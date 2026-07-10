/**
 * Auto Orchestrator.
 *
 * Coordina la pipeline COMPLETA cuando se dispara un cambio de region.
 * Garantiza:
 *   - No corre dos pipelines en paralelo para la misma region (lock)
 *   - Skip de pasos cuya data fresca ya existe (config: maxAgeMs por dataset)
 *   - Emite eventos via EventEmitter para que el watcher / dashboard escuchen
 *
 * Pipeline (orden):
 *   1. clearRegionCache       (cache de sesion BCN, fingerprints)
 *   2. loadRegionContext      (asegura region cargada)
 *   3. runIneScrapers         (ingresos, empleo, vivienda, demografia, consumo)
 *   4. runCelebrityScores     (INE buildScores)
 *   5. runCensus              (composicion etnica desde demografia)
 *   6. runCeliacScores        (celiac scorer)
 *   7. exportOutputs          (CSV+JSON por region)
 *   8. broadcast              ("done" event)
 *
 * Scrapers de retail (Jumbo/Lider/Maps/etc) NO se ejecutan automaticamente al
 * cambiar region porque sus APIs no aceptan filtro regional directo y correrlos
 * cada cambio de region multiplicaria el costo. Quedan disponibles via API
 * manual (POST /api/scrape/<source>) o cuando se mantenga la misma region.
 *
 * Si se quiere forzar TODO el pipeline (incluido retail), llamar a run() con
 * `{ includeRetail: true }`.
 */

const EventEmitter = require('events');
const region = require('../context/region-engine');
const logger = require('../utils/logger');
const DataStore = require('../utils/data-store');
const { clearCache: clearBcnCache } = require('../scrapers/ine/_bcn');

const events = new EventEmitter();
let _running = null;     // { region, startedAt, step }
let _lastRun = null;

const MAX_AGE_MS = {
  ineScrape:    1000 * 60 * 60 * 24,      // 24h: BCN no cambia diariamente
  trends:       1000 * 60 * 60 * 24,      // 24h: Trends por region
  maps:         1000 * 60 * 60 * 24 * 7,  // 7 dias: Maps es lento y dispara CAPTCHA
  retailNat:    1000 * 60 * 60 * 12       // 12h: retail nacional (no por region)
};

function emit(name, payload) {
  events.emit(name, { ...payload, at: new Date().toISOString() });
}

function isFresh(key, maxAge) {
  const rec = DataStore.load(key);
  if (!rec.scrapedAt || rec.itemCount === 0) return false;
  const age = Date.now() - new Date(rec.scrapedAt).getTime();
  return age < maxAge;
}

function ineCacheFresh(slug) {
  const datasets = ['ingresos', 'empleo', 'vivienda', 'demografia'];
  return datasets.every(d => isFresh(`ine-${slug}-${d}`, MAX_AGE_MS.ineScrape));
}

async function run(options = {}) {
  const ctx = region.context();
  const slug = ctx.slug;

  if (_running) {
    logger.warn(`[auto] Pipeline ya corriendo para ${_running.region}, ignorando trigger.`);
    return { skipped: true, reason: 'already-running', running: _running };
  }

  _running = { region: slug, startedAt: new Date().toISOString(), step: 'init' };
  emit('start', { region: slug, options });
  const t0 = Date.now();
  const result = { region: slug, steps: {} };

  try {
    // 1. Clear cache solo si force o region cambio recientemente
    if (options.clearCache !== false) {
      clearBcnCache();
      _running.step = 'cache-cleared';
      emit('step', { region: slug, step: 'cache-cleared' });
    }

    // 2. INE scrapers
    if (options.skipIne || (ineCacheFresh(slug) && !options.force)) {
      logger.info(`[auto/${slug}] INE skip (cache fresca o skipIne)`);
      result.steps.ine = { skipped: true, reason: 'cache-fresh' };
    } else {
      _running.step = 'ine-scrape';
      emit('step', { region: slug, step: 'ine-scrape' });
      const { runAll } = require('../scrapers/ine/orchestrator');
      result.steps.ine = await runAll();
    }

    // 3. Scoring INE
    _running.step = 'ine-score';
    emit('step', { region: slug, step: 'ine-score' });
    const { buildScores } = require('../analysis/ine/score');
    const scoresBlock = buildScores();
    result.steps.ineScore = {
      conScore: scoresBlock.scores.filter(s => s.poder_adquisitivo_score !== null).length,
      total: scoresBlock.scores.length
    };

    // 4. Trends (region-aware: cache por slug) — corre antes del celiac
    //    porque celiac usa trends como proxy de consumo gluten-free.
    if (options.skipTrends || isFresh(`google-trends-${slug}`, MAX_AGE_MS.trends)) {
      logger.info(`[auto/${slug}] Trends skip (cache fresca)`);
      result.steps.trends = { skipped: true, reason: 'cache-fresh' };
    } else {
      _running.step = 'trends-scrape';
      emit('step', { region: slug, step: 'trends-scrape' });
      try {
        const { run: runTrends } = require('../scrapers/google-trends');
        const t = await runTrends();
        result.steps.trends = { items: Array.isArray(t) ? t.length : 'ok' };
      } catch (e) {
        logger.warn(`[auto/${slug}] Trends fallo: ${e.message}`);
        result.steps.trends = { error: e.message };
      }
    }

    // 7. Retail nacional (Jumbo/Lider/ML/Rappi) — cache TTL 12h
    if (options.skipRetail || isFresh('jumbo', MAX_AGE_MS.retailNat)) {
      logger.info(`[auto/${slug}] Retail nacional skip (cache fresca o skipRetail)`);
      result.steps.retail = { skipped: true, reason: 'cache-fresh' };
    } else {
      _running.step = 'retail-scrape';
      emit('step', { region: slug, step: 'retail-scrape' });
      const retailResults = {};
      for (const src of ['jumbo', 'lider', 'mercadolibre', 'rappi']) {
        try {
          const { run } = require(`../scrapers/${src}`);
          const r = await run();
          retailResults[src] = Array.isArray(r) ? r.length : 'ok';
        } catch (e) {
          logger.warn(`[auto/${slug}] ${src} fallo: ${e.message}`);
          retailResults[src] = `error: ${e.message}`;
        }
      }
      result.steps.retail = retailResults;
    }

    // === Calculos derivados (despues de tener TODA la data fresca) ===

    _running.step = 'census';
    emit('step', { region: slug, step: 'census' });
    const { buildCensusContext } = require('../analysis/celiac/census-engine');
    const census = buildCensusContext();
    DataStore.save(`census-${slug}`, census.comunas, { success: true });
    result.steps.census = { comunas: census.comunas.length };

    _running.step = 'celiac';
    emit('step', { region: slug, step: 'celiac' });
    const { buildCeliacScores } = require('../analysis/celiac/scorer');
    const celiac = buildCeliacScores();
    DataStore.save(`celiac-${slug}`, celiac.perfiles, {
      success: true,
      validation: celiac.validation
    });
    result.steps.celiac = {
      perfiles: celiac.perfiles.length,
      conScore: celiac.perfiles.filter(p => p.celiac_score !== null).length,
      overallEvidence: celiac.validation.overallEvidence
    };

    // Maps + Reviews — opt-in (lento + CAPTCHA). Solo si includeMaps.
    if (options.includeMaps && !isFresh(`google-maps-${slug}`, MAX_AGE_MS.maps)) {
      _running.step = 'maps-scrape';
      emit('step', { region: slug, step: 'maps-scrape' });
      try {
        const { run: runMaps } = require('../scrapers/google-maps');
        const m = await runMaps();
        result.steps.maps = { items: Array.isArray(m) ? m.length : 'ok' };
        if (m && m.length > 0) {
          _running.step = 'reviews-scrape';
          emit('step', { region: slug, step: 'reviews-scrape' });
          const { run: runReviews } = require('../scrapers/reviews');
          const rv = await runReviews();
          result.steps.reviews = { items: Array.isArray(rv) ? rv.length : 'ok' };
        }
      } catch (e) {
        logger.warn(`[auto/${slug}] Maps/Reviews fallo: ${e.message}`);
        result.steps.maps = { error: e.message };
      }
    } else if (options.includeMaps) {
      logger.info(`[auto/${slug}] Maps skip (cache fresca, ${MAX_AGE_MS.maps / 1000 / 3600}h)`);
      result.steps.maps = { skipped: true };
    }

    _running.step = 'export';
    emit('step', { region: slug, step: 'export' });
    const { exportAll } = require('../analysis/ine/exporter');
    result.steps.export = exportAll();

    result.durationMs = Date.now() - t0;
    result.ok = true;
    _lastRun = { ...result, finishedAt: new Date().toISOString() };
    emit('done', { region: slug, durationMs: result.durationMs, result });
    logger.info(`[auto/${slug}] pipeline OK en ${result.durationMs}ms`);
    return result;

  } catch (e) {
    result.ok = false;
    result.error = e.message;
    _lastRun = { ...result, finishedAt: new Date().toISOString() };
    emit('error', { region: slug, error: e.message });
    logger.error(`[auto/${slug}] pipeline FAIL: ${e.message}\n${e.stack}`);
    return result;
  } finally {
    _running = null;
  }
}

function status() {
  return {
    running: _running,
    lastRun: _lastRun,
    currentRegion: region.current()
  };
}

module.exports = { run, status, events };
