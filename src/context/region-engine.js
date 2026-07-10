/**
 * Region Engine — contexto regional global del sistema OSINT.
 *
 * Filosofia: la region NO es un filtro, es el contexto del runtime entero.
 * Todos los modulos (scrapers, scoring, normalizer, dashboard) consultan
 * `region.context()` en vez de hardcodear comunas o codigos DEIS.
 *
 * Como cambiar la region activa:
 *   1) Variable de entorno al lanzar:   REGION=valparaiso npm run scrape:ine
 *   2) Runtime (proceso vivo):           require('./region-engine').set('valparaiso')
 *   3) HTTP:                             POST /api/regions/set { slug: 'valparaiso' }
 *
 * El cambio es process-local: dos terminales pueden trabajar regiones distintas
 * sin pisarse. Para persistencia entre arranques, definir REGION en .env.
 *
 * Default: metropolitana (preserva el comportamiento previo del sistema).
 */

const fs = require('fs');
const path = require('path');

const REGIONS_DIR = path.join(__dirname, '../config/regions');
const DEFAULT_REGION = (process.env.REGION || 'metropolitana').toLowerCase();

const _cache = new Map();
let _activeSlug = null;
const _listeners = [];

function listAvailable() {
  return fs.readdirSync(REGIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .sort();
}

function loadRegion(slug) {
  const normalized = String(slug || '').toLowerCase().trim();
  if (!normalized) throw new Error('region slug vacio');
  if (_cache.has(normalized)) return _cache.get(normalized);

  const file = path.join(REGIONS_DIR, `${normalized}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Region '${normalized}' no existe. Disponibles: ${listAvailable().join(', ')}`);
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ctx = buildContext(json);
  _cache.set(normalized, ctx);
  return ctx;
}

function buildContext(raw) {
  const comunaById = new Map();
  const comunaByDeis = new Map();
  for (const c of raw.comunas) {
    comunaById.set(c.id, c);
    if (c.deis) comunaByDeis.set(c.deis, c);
  }

  return {
    raw,
    slug: raw.slug,
    nombre: raw.nombre,
    codigoRegion: raw.codigoRegion,
    capital: raw.capital,
    perfilEconomico: raw.perfilEconomico || [],
    comunas: raw.comunas,
    comunaIds: () => raw.comunas.map(c => c.id),
    getComuna: (id) => comunaById.get(id) || null,
    getByDeis: (deis) => comunaByDeis.get(deis) || null,
    deisFor: (id) => comunaById.get(id)?.deis || null,
    resolveComuna: (rawName) => resolveComunaImpl(rawName, raw.comunas),
    keywords: raw.keywordsComerciales || [],
    sectoresAltos: raw.sectoresAltosIngresos || [],
    sectoresMedios: raw.sectoresMedios || [],
    sectoresBajos: raw.sectoresBajosIngresos || [],
    retail: raw.retailDominante || [],
    polosComerciales: raw.polosComerciales || [],
    zonas: raw.zonas || {},
    centroide: raw.centroide || null,
    scoringOverrides: raw.scoringOverrides || null,
    fuentes: raw.fuentes || {},
    bbox: computeBoundingBox(raw.comunas)
  };
}

function computeBoundingBox(comunas) {
  const lats = comunas.map(c => c.lat).filter(Number.isFinite);
  const lngs = comunas.map(c => c.lng).filter(Number.isFinite);
  if (!lats.length || !lngs.length) return null;
  return {
    minLat: Math.min(...lats), maxLat: Math.max(...lats),
    minLng: Math.min(...lngs), maxLng: Math.max(...lngs)
  };
}

function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/Ñ/g, 'n').replace(/ñ/g, 'n')
    .toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-').replace(/-+/g, '-');
}

function resolveComunaImpl(rawName, comunas) {
  if (!rawName) return null;
  const slug = slugify(rawName);
  const direct = comunas.find(c => c.id === slug);
  if (direct) return direct.id;
  const byName = comunas.find(c => slugify(c.nombre) === slug);
  return byName ? byName.id : null;
}

// === API publica ===

function context() {
  if (!_activeSlug) _activeSlug = DEFAULT_REGION;
  return loadRegion(_activeSlug);
}

function current() {
  return _activeSlug || DEFAULT_REGION;
}

function set(slug) {
  const ctx = loadRegion(slug);
  const prev = _activeSlug;
  _activeSlug = ctx.slug;
  if (prev !== ctx.slug) {
    for (const fn of _listeners) {
      try { fn(ctx, prev); } catch { /* listener errors no rompen el set */ }
    }
  }
  return ctx;
}

function onChange(fn) {
  _listeners.push(fn);
  return () => {
    const i = _listeners.indexOf(fn);
    if (i >= 0) _listeners.splice(i, 1);
  };
}

function reset() {
  _activeSlug = DEFAULT_REGION;
  _cache.clear();
}

module.exports = {
  listAvailable,
  loadRegion,
  context,
  current,
  set,
  onChange,
  reset,
  // exports utiles para tests/codigo upstream:
  slugify
};
