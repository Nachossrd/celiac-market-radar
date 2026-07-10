/**
 * Base helpers para todos los scrapers INE.
 *
 * Por que existe este archivo:
 * - INE Chile y BCN tienen disponibilidad erratica (timeouts, 502 ocasionales,
 *   cambios silenciosos de HTML). Necesitamos retries con backoff y deteccion
 *   de cambios estructurales para no acumular datos invisibles que se rompieron.
 * - Cada scraper debe sentirse uniforme: extract -> normalize -> validate -> save.
 *   La clase base no impone ese pipeline, pero ofrece las piezas para armarlo.
 *
 * Filosofia: el _base nunca inventa datos. Si el HTML cambia, devuelve
 * `{ ok:false, reason:'estructura-cambiada' }` y el scraper guarda 0.
 */

const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const limiters = require('../../utils/rate-limiter');

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
  'Accept-Language': 'es-CL,es;q=0.9,en;q=0.5',
  'Cache-Control': 'no-cache'
};

const FINGERPRINTS_FILE = path.join(__dirname, '../../../data/ine/raw/_fingerprints.json');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function humanDelay(min = 800, max = 2200) {
  const ms = Math.floor(min + Math.random() * (max - min));
  return sleep(ms);
}

function loadFingerprints() {
  try {
    return JSON.parse(fs.readFileSync(FINGERPRINTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveFingerprints(map) {
  fs.mkdirSync(path.dirname(FINGERPRINTS_FILE), { recursive: true });
  fs.writeFileSync(FINGERPRINTS_FILE, JSON.stringify(map, null, 2));
}

function hashStructure(html) {
  // Hashea la estructura tag a tag, no el contenido. Asi un cambio en cifras
  // no dispara alerta, pero un rediseno si.
  const tags = (html.match(/<[a-z][a-z0-9]*\b[^>]*>/gi) || [])
    .map(t => t.replace(/\s+/g, ' ').slice(0, 40));
  return crypto.createHash('sha1').update(tags.join('|')).digest('hex').slice(0, 12);
}

function detectStructuralChange(key, html) {
  const map = loadFingerprints();
  const current = hashStructure(html);
  const previous = map[key];
  map[key] = { hash: current, seenAt: new Date().toISOString() };
  saveFingerprints(map);
  if (!previous) return { firstSeen: true, changed: false, hash: current };
  return { firstSeen: false, changed: previous.hash !== current, hash: current };
}

async function fetchWithRetry(url, opts = {}, retries = 3, limiterKey = 'ine') {
  const limiter = limiters[limiterKey] || limiters.ine;
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await limiter.schedule(() => fetch(url, {
        timeout: 30000,
        redirect: 'follow',
        ...opts,
        headers: { ...DEFAULT_HEADERS, ...(opts.headers || {}) }
      }));

      if (res.status >= 500 || res.status === 429) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        // 4xx que no es 429: no reintentamos, no es un problema transitorio.
        return { ok: false, status: res.status, body: null, reason: `HTTP ${res.status}` };
      }

      const contentType = res.headers.get('content-type') || '';
      const body = contentType.includes('application/json')
        ? await res.json()
        : await res.text();

      return { ok: true, status: res.status, body, contentType };

    } catch (err) {
      lastError = err;
      const backoff = Math.min(15000, 1500 * Math.pow(2, attempt - 1)) + Math.random() * 800;
      logger.warn(`[INE] ${url} intento ${attempt}/${retries} fallo (${err.message}). Reintentando en ${Math.round(backoff)}ms.`);
      await sleep(backoff);
    }
  }
  return { ok: false, status: 0, body: null, reason: `retries-agotados: ${lastError?.message}` };
}

async function fetchJson(url, opts = {}, limiterKey = 'ine') {
  return fetchWithRetry(url, {
    ...opts,
    headers: { 'Accept': 'application/json', ...(opts.headers || {}) }
  }, 3, limiterKey);
}

async function postJson(url, body, opts = {}, limiterKey = 'ine') {
  return fetchWithRetry(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...(opts.headers || {}) },
    ...opts
  }, 3, limiterKey);
}

/**
 * Convierte texto chileno a numero. Maneja:
 *   "$ 1.234.567"   -> 1234567
 *   "12,5%"         -> 12.5
 *   "1.234,56"      -> 1234.56
 *   "S/I" "N/D" ""  -> null
 */
function parseChileanNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s || /^(S\/I|N\/?D|s\.?\/?i\.?|nd|--?|-)$/i.test(s)) return null;

  const cleaned = s
    .replace(/\$/g, '')
    .replace(/%/g, '')
    .replace(/\s/g, '')
    .replace(/ /g, '');

  // Si tiene tanto . como , : asume formato chileno (1.234,56)
  if (cleaned.includes('.') && cleaned.includes(',')) {
    const n = parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  // Solo coma: separador decimal chileno
  if (cleaned.includes(',') && !cleaned.includes('.')) {
    const n = parseFloat(cleaned.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  // Solo puntos: si son miles (mas de un grupo) -> quita; si decimal -> parsea
  if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
    return parseInt(cleaned.replace(/\./g, ''), 10);
  }
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

class IneScraperBase {
  constructor(name) {
    this.name = name;
    this.errors = [];
    this.warnings = [];
    this.startTime = 0;
  }

  start() {
    this.startTime = Date.now();
    this.errors = [];
    this.warnings = [];
    logger.info(`[INE:${this.name}] Iniciando.`);
  }

  warn(msg) {
    this.warnings.push(msg);
    logger.warn(`[INE:${this.name}] ${msg}`);
  }

  error(msg) {
    this.errors.push(msg);
    logger.error(`[INE:${this.name}] ${msg}`);
  }

  meta(extra = {}) {
    return {
      success: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings,
      durationMs: Date.now() - this.startTime,
      ...extra
    };
  }
}

module.exports = {
  IneScraperBase,
  DEFAULT_HEADERS,
  fetchWithRetry,
  fetchJson,
  postJson,
  parseChileanNumber,
  detectStructuralChange,
  humanDelay,
  sleep
};
