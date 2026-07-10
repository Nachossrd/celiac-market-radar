require('dotenv').config();
const logger = require('../utils/logger');
const DataStore = require('../utils/data-store');

/**
 * Orquestador de scrapers. Ejecuta todo en orden y reporta resultados REALES.
 */

async function runAll() {
  const startTime = Date.now();
  logger.info('===========================================');
  logger.info('  INICIO DE SCRAPING COMPLETO');
  logger.info('===========================================');

  const results = {};

  logger.info('\n>> FASE 1: Supermercados (APIs internas)');
  try {
    const { run: runJumbo } = require('./jumbo');
    results.jumbo = await runJumbo();
    logger.info(`  OK Jumbo: ${results.jumbo.length} productos`);
  } catch (e) {
    logger.error(`  FAIL Jumbo: ${e.message}`);
    results.jumbo = [];
  }

  try {
    const { run: runLider } = require('./lider');
    results.lider = await runLider();
    logger.info(`  OK Lider: ${results.lider.length} productos`);
  } catch (e) {
    logger.error(`  FAIL Lider: ${e.message}`);
    results.lider = [];
  }

  logger.info('\n>> FASE 2: MercadoLibre (API publica)');
  try {
    const { run: runML } = require('./mercadolibre');
    results.mercadolibre = await runML();
    logger.info(`  OK MercadoLibre: ${results.mercadolibre.length} productos`);
  } catch (e) {
    logger.error(`  FAIL MercadoLibre: ${e.message}`);
    results.mercadolibre = [];
  }

  logger.info('\n>> FASE 3: Google Trends (npm package)');
  try {
    const { run: runTrends } = require('./google-trends');
    results.trends = await runTrends();
    logger.info(`  OK Trends: ${results.trends.length} queries`);
  } catch (e) {
    logger.error(`  FAIL Trends: ${e.message}`);
    results.trends = [];
  }

  logger.info('\n>> FASE 4: Rappi (API publica, puede requerir auth)');
  try {
    const { run: runRappi } = require('./rappi');
    results.rappi = await runRappi();
    logger.info(`  OK Rappi: ${results.rappi.length} productos`);
  } catch (e) {
    logger.error(`  FAIL Rappi: ${e.message}`);
    results.rappi = [];
  }

  logger.info('\n>> FASE 5: Google Maps (Puppeteer, riesgo CAPTCHA)');
  try {
    const { run: runMaps } = require('./google-maps');
    results.maps = await runMaps();
    logger.info(`  OK Maps: ${results.maps.length} locales`);
  } catch (e) {
    logger.error(`  FAIL Maps: ${e.message}`);
    results.maps = [];
  }

  if (results.maps && results.maps.length > 0) {
    logger.info('\n>> FASE 6: Reviews (max 5 locales)');
    try {
      const { run: runReviews } = require('./reviews');
      results.reviews = await runReviews();
      logger.info(`  OK Reviews: ${results.reviews.length} reviews`);
    } catch (e) {
      logger.error(`  FAIL Reviews: ${e.message}`);
      results.reviews = [];
    }
  } else {
    logger.info('\n>> FASE 6: Reviews OMITIDA (no hay locales de Maps)');
    results.reviews = [];
  }

  logger.info('\n>> FASE 7: INE - Inteligencia socioeconomica territorial');
  try {
    const { runAll: runIne } = require('./ine/orchestrator');
    results.ine = await runIne();
    logger.info(`  OK INE: ${JSON.stringify(results.ine.pasos)}`);
  } catch (e) {
    logger.error(`  FAIL INE: ${e.message}`);
    results.ine = { error: e.message };
  }

  logger.info('\n>> FASE 8: Export perfiles territoriales (JSON + CSV)');
  try {
    const { exportAll } = require('../analysis/ine/exporter');
    results.perfilesExport = exportAll();
    logger.info(`  OK Exporter: ${results.perfilesExport.perfiles} perfiles, ${results.perfilesExport.altaConfianza} con alta confianza`);
  } catch (e) {
    logger.error(`  FAIL Exporter: ${e.message}`);
    results.perfilesExport = { error: e.message };
  }

  const duration = Date.now() - startTime;
  const summary = {
    duration: `${Math.round(duration / 1000)}s`,
    jumbo: results.jumbo.length,
    lider: results.lider.length,
    mercadolibre: results.mercadolibre.length,
    trends: results.trends.length,
    rappi: results.rappi.length,
    maps: results.maps.length,
    reviews: results.reviews.length,
    ine: results.ine?.pasos || null,
    perfilesExport: results.perfilesExport?.perfiles || 0,
    totalDataPoints: Object.values(results).reduce((sum, arr) =>
      sum + (Array.isArray(arr) ? arr.length : 0), 0)
  };

  logger.info('\n===========================================');
  logger.info('  RESUMEN DE SCRAPING');
  logger.info('===========================================');
  logger.info(JSON.stringify(summary, null, 2));

  DataStore.save('_summary', summary, { success: true, durationMs: duration });
  DataStore.printStatus();

  return summary;
}

module.exports = { runAll };
