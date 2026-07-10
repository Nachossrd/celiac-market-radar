const express = require('express');
const router = express.Router();
const DataStore = require('../utils/data-store');
const { PopulationModel } = require('../analysis/population');
const { MobilityModel } = require('../analysis/mobility');
const { generateReport } = require('../analysis/inference');
const region = require('../context/region-engine');
const logger = require('../utils/logger');

// === REGION ENGINE ===
// Switch global de region. Cambiarlo aqui afecta a TODOS los endpoints
// posteriores: comunas, scrapers, scoring, perfiles, exports.

router.get('/regions', (_req, res) => {
  const list = region.listAvailable().map(slug => {
    const ctx = region.loadRegion(slug);
    return {
      slug: ctx.slug,
      nombre: ctx.nombre,
      codigoRegion: ctx.codigoRegion,
      capital: ctx.capital,
      perfilEconomico: ctx.perfilEconomico,
      totalComunas: ctx.comunas.length,
      activa: ctx.slug === region.current()
    };
  });
  res.json({ current: region.current(), regions: list });
});

router.get('/regions/current', (_req, res) => {
  const c = region.context();
  res.json({
    slug: c.slug,
    nombre: c.nombre,
    codigoRegion: c.codigoRegion,
    capital: c.capital,
    perfilEconomico: c.perfilEconomico,
    totalComunas: c.comunas.length,
    centroide: c.centroide,
    bbox: c.bbox,
    retail: c.retail,
    zonas: c.zonas
  });
});

router.post('/regions/set', (req, res) => {
  const slug = req.body?.slug;
  if (!slug) return res.status(400).json({ error: 'falta body.slug' });
  const prev = region.current();
  try {
    const c = region.set(slug);
    logger.info(`[api] region cambiada a ${c.slug} (${c.nombre})`);
    // region-auto-trigger ya dispara auto.run() en background via onChange.
    // Devolvemos info inmediata; el frontend escucha SSE /api/events para el done.
    res.json({
      ok: true,
      slug: c.slug,
      nombre: c.nombre,
      totalComunas: c.comunas.length,
      previousRegion: prev,
      pipelineTriggered: prev !== c.slug,
      note: prev !== c.slug
        ? 'Pipeline disparada en background. Escucha /api/events SSE para start/step/done.'
        : 'Region sin cambio, pipeline no disparada.'
    });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

router.get('/regions/:slug/comunas', (req, res) => {
  try {
    const c = region.loadRegion(req.params.slug);
    res.json({ region: c.slug, total: c.comunas.length, comunas: c.comunas });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// === AUTO-ORCHESTRATOR + EVENTS ===
const auto = require('../core/auto-orchestrator');

router.get('/auto/status', (_req, res) => res.json(auto.status()));

router.post('/auto/run', (req, res) => {
  // dispara la pipeline asincrona — responde inmediato con el status
  auto.run(req.body || {}).catch(e => logger.error(`[api] auto.run: ${e.message}`));
  res.json({ started: true, region: region.current(), status: auto.status() });
});

// SSE — eventos del orchestrator y watcher al dashboard
router.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  const send = (name, payload) => {
    res.write(`event: ${name}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send('hello', { region: region.current(), at: new Date().toISOString() });

  const onStart = (p) => send('start',  p);
  const onStep  = (p) => send('step',   p);
  const onDone  = (p) => send('done',   p);
  const onErr   = (p) => send('error',  p);

  auto.events.on('start', onStart);
  auto.events.on('step',  onStep);
  auto.events.on('done',  onDone);
  auto.events.on('error', onErr);

  const heartbeat = setInterval(() => res.write(': hb\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    auto.events.off('start', onStart);
    auto.events.off('step',  onStep);
    auto.events.off('done',  onDone);
    auto.events.off('error', onErr);
  });
});

// === CELIAC ENGINE ===
router.get('/celiac/profiles', (_req, res) => {
  try {
    const { buildCeliacScores } = require('../analysis/celiac/scorer');
    res.json(buildCeliacScores());
  } catch (e) {
    res.status(500).json({ error: e.message, hint: 'Asegura que ine-<region>-demografia este scrapeado' });
  }
});

router.get('/celiac/profiles/:comunaId', (req, res) => {
  try {
    const { buildCeliacScores } = require('../analysis/celiac/scorer');
    const all = buildCeliacScores().perfiles;
    const found = all.find(p => p.comunaId === req.params.comunaId);
    if (!found) return res.status(404).json({ error: 'Comuna no encontrada' });
    res.json(found);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/celiac/literature', (_req, res) => {
  const lit = require('../analysis/celiac/literature.json');
  res.json(lit);
});

router.get('/celiac/validation', (_req, res) => {
  const v = require('../analysis/celiac/scientific-validator');
  res.json(v.validateAncestralWeights());
});

router.get('/census', (_req, res) => {
  try {
    const { buildCensusContext } = require('../analysis/celiac/census-engine');
    res.json(buildCensusContext());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/status', (req, res) => {
  res.json(DataStore.getStatus());
});

router.get('/comunas', (req, res) => {
  const pop = new PopulationModel();
  res.json({
    fuentes: pop.fuentes,
    totals: pop.totals(),
    comunas: pop.getAll()
  });
});

router.get('/comunas/:id', (req, res) => {
  const pop = new PopulationModel();
  const c = pop.getById(req.params.id);
  if (!c) return res.status(404).json({ error: 'Comuna no encontrada' });
  res.json(c);
});

router.get('/mobility', (req, res) => {
  const mob = new MobilityModel();
  res.json({
    metadata: mob.metadata(),
    matrix: mob.matrix,
    defaults: mob.defaults
  });
});

router.get('/scraped/:source', (req, res) => {
  if (!DataStore.exists(req.params.source)) {
    return res.status(404).json({
      error: 'Fuente no scrapeada todavia',
      source: req.params.source,
      hint: `Ejecuta npm run scrape:${req.params.source}`
    });
  }
  res.json(DataStore.load(req.params.source));
});

router.get('/report', async (req, res) => {
  try {
    const report = await generateReport();
    res.json(report);
  } catch (e) {
    logger.error(`[api] Error generando reporte: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// === INE: inteligencia socioeconomica territorial ===

router.get('/ine/perfiles', (req, res) => {
  try {
    const { buildProfiles } = require('../analysis/ine/profile');
    res.json(buildProfiles());
  } catch (e) {
    logger.error(`[api] ine/perfiles: ${e.message}`);
    res.status(500).json({ error: e.message, hint: 'Ejecuta primero npm run scrape:ine' });
  }
});

router.get('/ine/perfiles/:comunaId', (req, res) => {
  try {
    const { buildProfiles } = require('../analysis/ine/profile');
    const all = buildProfiles().perfiles;
    const found = all.find(p => p.comunaId === req.params.comunaId);
    if (!found) return res.status(404).json({ error: 'Comuna no encontrada' });
    res.json(found);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/ine/scores', (req, res) => {
  try {
    const { buildScores } = require('../analysis/ine/score');
    res.json(buildScores());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/ine/ranking', (req, res) => {
  try {
    const { buildProfiles } = require('../analysis/ine/profile');
    const perfiles = buildProfiles().perfiles
      .filter(p => p.poder_adquisitivo !== null)
      .sort((a, b) => b.poder_adquisitivo - a.poder_adquisitivo)
      .map((p, i) => ({
        rank: i + 1,
        comunaId: p.comunaId,
        comuna: p.comuna,
        sector: p.sector,
        poblacion: p.poblacion,
        poder_adquisitivo: p.poder_adquisitivo,
        nivel_socioeconomico: p.nivel_socioeconomico,
        clase_confianza: p.clase_confianza,
        elasticidad_precio: p.elasticidad_precio,
        probabilidad_consumo_premium: p.probabilidad_consumo_premium,
        nivel_educacional: p.nivel_educacional,
        densidad_comercial: p.densidad_comercial
      }));
    res.json({ total: perfiles.length, ranking: perfiles });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/ine/heatmap', (req, res) => {
  try {
    const { buildScores } = require('../analysis/ine/score');
    const { buildHeatmap } = require('../analysis/ine/heatmap');
    res.json(buildHeatmap(buildScores().scores));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/ine/scrape', (req, res) => {
  res.json({ started: 'ine', status: 'running', note: 'Ver logs/scraper.log para progreso (~3 min)' });
  const { runAll } = require('../scrapers/ine/orchestrator');
  runAll().catch(err => logger.error(`[api] ine scrape: ${err.message}`));
});

router.post('/ine/export', (req, res) => {
  try {
    const { exportAll } = require('../analysis/ine/exporter');
    res.json(exportAll());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/scrape/:source', async (req, res) => {
  const source = req.params.source;
  const map = {
    jumbo: './src/scrapers/jumbo',
    lider: './src/scrapers/lider',
    mercadolibre: './src/scrapers/mercadolibre',
    'google-trends': './src/scrapers/google-trends',
    'google-maps': './src/scrapers/google-maps',
    rappi: './src/scrapers/rappi',
    reviews: './src/scrapers/reviews',
    all: './src/scrapers/orchestrator'
  };

  const modulePath = map[source];
  if (!modulePath) return res.status(400).json({ error: `Fuente desconocida: ${source}` });

  res.json({ started: source, status: 'running', note: 'Ver logs/scraper.log para progreso' });

  const mod = require('../../' + modulePath.replace('./', ''));
  const fn = source === 'all' ? mod.runAll : mod.run;
  fn().catch(err => logger.error(`[api] Scrape ${source} fallo: ${err.message}`));
});

module.exports = router;
