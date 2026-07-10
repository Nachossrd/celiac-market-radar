/**
 * Normalizador territorial — delga sobre region-engine.
 *
 * Antes leia directo data/comunas-censo2024.json (RM hardcoded). Ahora
 * cualquier consulta de comuna pasa por el region-engine, que entrega la
 * lista correcta segun la region activa (REGION env o region.set()).
 *
 * Estandarizaciones que sí siguen viviendo aqui (no son territoriales):
 *  - asPercent: rango 0-100 estricto
 *  - asCLP: pesos enteros
 *  - minMax: para scoring
 *  - stripAccents/slugifyComuna: utilitarios de texto
 */

const region = require('../../context/region-engine');

function ctx() { return region.context(); }

function listComunas() {
  return ctx().comunas;
}

function getComunaMeta(id) {
  return ctx().getComuna(id);
}

function resolveComunaId(rawName) {
  return ctx().resolveComuna(rawName);
}

function stripAccents(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/Ñ/g, 'N')
    .replace(/ñ/g, 'n');
}

function slugifyComuna(name) {
  return stripAccents(name)
    .toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * BCN entrega siempre 0-100. NO multiplicamos.
 * Devuelve null si fuera de rango.
 */
function asPercent(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  return Math.round(n * 10) / 10;
}

function asCLP(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  if (n < 0) return null;
  return Math.round(n);
}

function minMax(val, min, max) {
  if (val === null || val === undefined || !Number.isFinite(val)) return null;
  if (max === min) return 0.5;
  const x = (val - min) / (max - min);
  return Math.max(0, Math.min(1, x));
}

// Backwards-compat shim: codigo viejo que importaba loadComunas
function loadComunas() {
  const c = ctx();
  return {
    fuente: c.fuentes,
    region: c.nombre,
    totalComunas: c.comunas.length,
    comunas: c.comunas
  };
}

module.exports = {
  loadComunas,
  listComunas,
  getComunaMeta,
  resolveComunaId,
  slugifyComuna,
  stripAccents,
  asPercent,
  asCLP,
  minMax
};
