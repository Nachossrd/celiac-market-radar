/**
 * Region Auto-Trigger.
 *
 * Conecta region-engine con auto-orchestrator. CUALQUIER cambio de region
 * (via API, watcher, CLI o codigo interno) dispara la pipeline.
 *
 * Sin este modulo, region.set() solo cambia el contexto pero los datos
 * derivados (scoring, census, celiac, export) no se recalculan.
 *
 * Idempotente: si se importa varias veces, registra el listener una sola vez.
 */

const region = require('../context/region-engine');
const auto = require('./auto-orchestrator');
const logger = require('../utils/logger');

let _registered = false;

function init() {
  if (_registered) return;
  _registered = true;

  region.onChange((newCtx, prevSlug) => {
    if (prevSlug === newCtx.slug) return;   // sin cambio real
    const from = prevSlug || '(none)';
    logger.info(`[auto-trigger] region cambio ${from} -> ${newCtx.slug} | disparando pipeline`);
    // Por defecto skipIne (si cache fresca, no re-scrapea). El usuario puede
    // forzar via POST /api/auto/run { force: true }.
    auto.run({ skipIne: true }).catch(e =>
      logger.error(`[auto-trigger] orchestrator fallo: ${e.message}`));
  });

  logger.info('[auto-trigger] listener registrado: region.onChange -> auto.run');
}

module.exports = { init };
