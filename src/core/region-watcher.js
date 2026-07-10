/**
 * Region Watcher.
 *
 * Vigila .env y dispara la pipeline cuando REGION cambia.
 *
 * Mecanica:
 *   - fs.watchFile (no fs.watch — en Windows fs.watch dispara dos eventos por
 *     guardado y es inestable con editores que rescriben el archivo)
 *   - Lee y parsea .env como dotenv (sin reinyectar a process.env: el cambio
 *     se aplica via region.set())
 *   - Debounce 500ms para evitar disparos multiples cuando el editor guarda
 *     en varias operaciones (touch + write)
 *
 * Tambien expone una API de cambio runtime:
 *   watcher.applyRegion('valparaiso')   // mismo efecto que editar .env
 *
 * Cuando detecta cambio, llama auto-orchestrator.run(). Skip de scraping si
 * la cache esta fresca (controlado por el orchestrator).
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const region = require('../context/region-engine');
// region-auto-trigger se encarga de disparar auto-orchestrator cuando
// region.onChange se emite. Aqui solo llamamos region.set().
require('./region-auto-trigger').init();

const ENV_FILE = path.join(__dirname, '../../.env');

let _lastSeen = null;
let _debounceTimer = null;
let _watching = false;

function parseEnv(content) {
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function readEnv() {
  try {
    return parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function applyRegion(slug, opts = {}) {
  const prev = region.current();
  if (slug === prev && !opts.force) {
    logger.info(`[watcher] region ya activa: ${slug}, sin cambios`);
    return;
  }
  try {
    region.set(slug);   // region-auto-trigger se encarga del resto
    logger.info(`[watcher] region.set(${slug}) ejecutado`);
  } catch (e) {
    logger.error(`[watcher] error aplicando region '${slug}': ${e.message}`);
  }
}

function onEnvChange() {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    const env = readEnv();
    const slug = (env.REGION || '').toLowerCase().trim();
    if (!slug) {
      logger.warn('[watcher] .env sin REGION definida, ignorando cambio');
      return;
    }
    if (slug === _lastSeen) return;
    _lastSeen = slug;
    applyRegion(slug);
  }, 500);
}

function start(opts = {}) {
  if (_watching) {
    logger.warn('[watcher] ya iniciado');
    return;
  }

  if (!fs.existsSync(ENV_FILE)) {
    logger.warn(`[watcher] .env no existe en ${ENV_FILE} — creando placeholder`);
    fs.writeFileSync(ENV_FILE, `REGION=${region.current()}\n`);
  }

  const env = readEnv();
  _lastSeen = (env.REGION || region.current()).toLowerCase();
  logger.info(`[watcher] region inicial: ${_lastSeen}`);

  // Si la region inicial difiere de la default, aplicarla ya
  if (_lastSeen !== region.current()) {
    applyRegion(_lastSeen);
  }

  fs.watchFile(ENV_FILE, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    logger.info(`[watcher] .env cambio (mtime ${new Date(curr.mtime).toISOString()})`);
    onEnvChange();
  });

  _watching = true;
  logger.info(`[watcher] vigilando ${ENV_FILE} cada 1s`);
}

function stop() {
  fs.unwatchFile(ENV_FILE);
  _watching = false;
  logger.info('[watcher] detenido');
}

module.exports = { start, stop, applyRegion, readEnv };
