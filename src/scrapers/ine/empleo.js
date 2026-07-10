/**
 * Scraper EMPLEO / ACTIVIDAD ECONOMICA por comuna.
 *
 * BCN no entrega tasa de ocupacion/desocupacion por comuna (es ENE regional).
 * SI entrega la distribucion de empresas registradas por tramo de ventas (SII),
 * que es un excelente proxy de actividad economica formal por comuna:
 *
 *   - empresas_total            n empresas registradas
 *   - empresas_micro_pct        % microempresas (< UF 2.400 ventas anuales)
 *   - empresas_grandes_pct      % grandes (> UF 100.000)
 *   - empresas_per_capita       empresas / 1000 hab
 *
 * Mas empresas grandes => mas masa salarial formal => mayor base contributiva
 * en la comuna. Mas microempresas concentradas => economia mas informal.
 */

const { IneScraperBase, parseChileanNumber } = require('./_base');
const { fetchComuna, findRow, readValue } = require('./_bcn');
const { listComunas, getComunaMeta } = require('../../analysis/ine/normalizer');
const region = require('../../context/region-engine');
const DataStore = require('../../utils/data-store');

const scraper = new IneScraperBase('empleo');
const storeKey = () => `ine-${region.context().slug}-empleo`;

const TRAMOS = ['Micro', 'Pequeña', 'Mediana', 'Grande', 'Sin Ventas'];

async function extract(comunaId) {
  return { bcn: await fetchComuna(comunaId) };
}

function readTramo(tables, label) {
  // Busca la tabla SII (filas Micro/Pequeña/Mediana/Grande). Identificacion
  // por la PRESENCIA de filas con esos labels, no por titulo (BCN nombra
  // todo "Indicadores economicos").
  for (const t of tables) {
    // Filtro fuerte: que tenga al menos 2 de los tramos canonicos
    const tramosDetectados = TRAMOS.filter(tr =>
      t.rows.some(r => new RegExp(`^${tr}$`, 'i').test((r[0] || '').trim()))
    );
    if (tramosDetectados.length < 2) continue;

    const row = t.rows.find(r => new RegExp(`^${label}$`, 'i').test((r[0] || '').trim()));
    if (!row) continue;

    // Estructura tabla SII: Tramo | Comuna(2020,2021,2022) | Region(2020..) | Pais(2020..)
    // 9 columnas de datos = 3 anos * 3 niveles. Queremos el DATO COMUNAL MAS
    // RECIENTE => columna anos/3 - 1 dentro del bloque comuna => indice [anos-1].
    const numCols = row.length - 1;
    const bloques = 3; // comuna, region, pais
    const cols = Math.floor(numCols / bloques);
    if (cols < 1) continue;
    // Indice del dato comunal del ultimo año = 1 (offset label) + (cols - 1)
    const idx = 1 + (cols - 1);
    const v = parseChileanNumber(row[idx]);
    if (v !== null) return v;
  }
  return null;
}

function normalize(comunaId, { bcn }) {
  const meta = getComunaMeta(comunaId);
  const out = {
    comunaId,
    comuna: meta?.nombre || comunaId,
    empresas_total: null,
    empresas_micro: null,
    empresas_pequena: null,
    empresas_mediana: null,
    empresas_grande: null,
    empresas_micro_pct: null,
    empresas_grandes_pct: null,
    empresas_per_1000hab: null,
    // Tasa ocupacion/desocupacion: no disponible en BCN web a comuna.
    tasa_ocupacion_pct: null,
    tasa_desocupacion_pct: null,
    informalidad_pct: null,
    sector_predominante: null,
    fuentes: [],
    _notas: 'tasas de ocupacion/desocupacion no estan a comuna en BCN. Ver ENE (regional) o CASEN.'
  };

  if (!bcn?.ok || !bcn.tables.length) {
    if (bcn) scraper.warn(`${comunaId}: ${bcn.reason || 'sin tablas'}`);
    return out;
  }
  out.fuentes.push({ tipo: 'BCN comuna ficha (SII)', url: bcn.url });

  out.empresas_micro    = readTramo(bcn.tables, 'Micro');
  out.empresas_pequena  = readTramo(bcn.tables, 'Pequeña')   ?? readTramo(bcn.tables, 'Pequena');
  out.empresas_mediana  = readTramo(bcn.tables, 'Mediana');
  out.empresas_grande   = readTramo(bcn.tables, 'Grande');

  const parts = [out.empresas_micro, out.empresas_pequena, out.empresas_mediana, out.empresas_grande]
    .filter(v => v !== null);
  out.empresas_total = parts.length ? parts.reduce((s, v) => s + v, 0) : null;

  if (out.empresas_total && out.empresas_total > 0) {
    if (out.empresas_micro !== null) {
      out.empresas_micro_pct = Math.round((out.empresas_micro / out.empresas_total) * 1000) / 10;
    }
    const grandes = (out.empresas_grande || 0) + (out.empresas_mediana || 0);
    out.empresas_grandes_pct = Math.round((grandes / out.empresas_total) * 1000) / 10;
    if (meta?.poblacion) {
      out.empresas_per_1000hab = Math.round((out.empresas_total / meta.poblacion) * 1000 * 10) / 10;
    }
  }

  return out;
}

function validate(r) {
  const issues = [];
  if (r.empresas_total !== null && r.empresas_total < 50) {
    issues.push(`empresas_total muy bajo (${r.empresas_total}) — verificar parseo`);
  }
  return issues;
}

async function run() {
  scraper.start();
  const results = [];
  for (const c of listComunas()) {
    try {
      const raw = await extract(c.id);
      const norm = normalize(c.id, raw);
      const issues = validate(norm);
      if (issues.length) norm._validationIssues = issues;
      results.push(norm);
    } catch (e) {
      scraper.error(`${c.id}: ${e.message}`);
      results.push({ comunaId: c.id, _error: e.message });
    }
  }
  return save(results);
}

function save(results) {
  const conDatos = results.filter(r => r.empresas_total !== null).length;
  DataStore.save(storeKey(), results, scraper.meta({
    comunasConDatos: conDatos,
    comunasTotales: results.length
  }));
  return results;
}

module.exports = { run, extract, normalize, validate, save };
