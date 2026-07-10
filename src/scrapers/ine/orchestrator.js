/**
 * Orchestrator INE.
 *
 * Decision de diseno: ejecucion SECUENCIAL entre dominios (ingresos -> empleo
 * -> vivienda -> demografia -> consumo) porque todos consultan el mismo host
 * BCN. Disparar 5 scrapers en paralelo seria mas rapido pero saturaria
 * reportescomunales.bcn.cl y nos ganaria un 503 o un ban. El rate-limiter
 * comparte estado en /utils/rate-limiter pero igual conviene serializar.
 *
 * El paralelismo real esta DENTRO de cada scraper a nivel comuna -> request
 * por seccion (Promise.all en extract()).
 */

const logger = require('../../utils/logger');
const DataStore = require('../../utils/data-store');
const region = require('../../context/region-engine');

const STEPS = [
  { key: 'ingresos',   mod: './ingresos' },
  { key: 'empleo',     mod: './empleo' },
  { key: 'vivienda',   mod: './vivienda' },
  { key: 'demografia', mod: './demografia' },
  { key: 'consumo',    mod: './consumo' }
];

async function runAll(opts = {}) {
  const t0 = Date.now();
  const only = (opts.only || '').split(',').map(s => s.trim()).filter(Boolean);
  const skip = (opts.skip || '').split(',').map(s => s.trim()).filter(Boolean);

  const ctx = region.context();
  logger.info('=================================================');
  logger.info(`  INE - INTELIGENCIA TERRITORIAL [${ctx.nombre}]`);
  logger.info(`  Region: ${ctx.slug} | ${ctx.comunas.length} comunas | DEIS ${ctx.codigoRegion}`);
  logger.info('=================================================');

  const results = {};
  for (const step of STEPS) {
    if (only.length && !only.includes(step.key)) continue;
    if (skip.includes(step.key)) continue;

    logger.info(`\n>> INE/${step.key}`);
    try {
      const { run } = require(step.mod);
      results[step.key] = await run();
      const n = Array.isArray(results[step.key]) ? results[step.key].length : 'N/A';
      logger.info(`   OK ine-${step.key}: ${n} registros`);
    } catch (e) {
      logger.error(`   FAIL ine-${step.key}: ${e.message}\n${e.stack}`);
      results[step.key] = { error: e.message };
    }
  }

  const durationMs = Date.now() - t0;
  const summary = {
    region: ctx.slug,
    nombre: ctx.nombre,
    durationMs,
    duracion: `${Math.round(durationMs / 1000)}s`,
    pasos: Object.fromEntries(STEPS.map(s => [
      s.key,
      Array.isArray(results[s.key]) ? results[s.key].length : (results[s.key]?.error ? 'error' : 'N/A')
    ]))
  };

  DataStore.save(`ine-${ctx.slug}-_summary`, summary, { success: true, durationMs });
  logger.info('\n=================================================');
  logger.info('  INE - RESUMEN');
  logger.info('=================================================');
  logger.info(JSON.stringify(summary, null, 2));

  return summary;
}

module.exports = { runAll, STEPS };
