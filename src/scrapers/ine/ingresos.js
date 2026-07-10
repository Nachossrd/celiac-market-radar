/**
 * Scraper INGRESOS por comuna (BCN Reportes Comunales).
 *
 * Honestidad: BCN NO publica ingreso autonomo / mediano / per capita por
 * comuna en su web (esa data vive en CASEN microdatos, fuera de alcance de
 * scraping ligero). Lo que SI entrega BCN son indicadores derivados de CASEN
 * que funcionan como excelentes proxies de capacidad economica:
 *
 *   - Tasa de Pobreza por ingresos, personas (%)        CASEN
 *   - Tasa de Pobreza multidimensional, personas (%)    CASEN
 *
 * Para "ingreso_*_clp" dejamos null explicitamente y avisamos en `_notas`.
 * Cuando el usuario integre SINIM o CASEN microdatos, esos campos se llenan.
 */

const { IneScraperBase } = require('./_base');
const { fetchComuna, findRow, readValue } = require('./_bcn');
const { listComunas, getComunaMeta, asPercent } = require('../../analysis/ine/normalizer');
const region = require('../../context/region-engine');
const DataStore = require('../../utils/data-store');

const scraper = new IneScraperBase('ingresos');
const storeKey = () => `ine-${region.context().slug}-ingresos`;

async function extract(comunaId) {
  return { bcn: await fetchComuna(comunaId) };
}

function normalize(comunaId, { bcn }) {
  const out = {
    comunaId,
    comuna: getComunaMeta(comunaId)?.nombre || comunaId,
    // CASEN derivables desde BCN web:
    pobreza_ingresos_pct: null,
    pobreza_multidimensional_pct: null,
    // Sin fuente publica a comuna:
    ingreso_promedio_hogar_clp: null,
    ingreso_mediano_hogar_clp: null,
    ingreso_per_capita_clp: null,
    pobreza_extrema_pct: null,
    fuentes: [],
    _notas: 'ingreso_*_clp no estan disponibles en BCN web. Integrar CASEN microdatos o SINIM si se requieren.'
  };

  if (!bcn?.ok || !bcn.tables.length) {
    if (bcn) scraper.warn(`${comunaId}: ${bcn.reason || 'sin tablas'}`);
    return out;
  }
  out.fuentes.push({ tipo: 'BCN comuna ficha (CASEN)', url: bcn.url });

  const ts = bcn.tables;

  out.pobreza_ingresos_pct = asPercent(readValue(
    findRow(ts, /pobreza\s*por\s*ingresos/i)
  ));
  out.pobreza_multidimensional_pct = asPercent(readValue(
    findRow(ts, /pobreza\s*multidimensional/i)
  ));

  return out;
}

function validate(r) {
  const issues = [];
  if (r.pobreza_ingresos_pct !== null && r.pobreza_ingresos_pct > 60) {
    issues.push(`pobreza_ingresos sospechosa (${r.pobreza_ingresos_pct}%)`);
  }
  if (r.pobreza_multidimensional_pct !== null && r.pobreza_multidimensional_pct > 80) {
    issues.push(`pobreza_multidim sospechosa (${r.pobreza_multidimensional_pct}%)`);
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
  const conDatos = results.filter(r => r.pobreza_ingresos_pct !== null).length;
  DataStore.save(storeKey(), results, scraper.meta({
    comunasConDatos: conDatos,
    comunasTotales: results.length
  }));
  return results;
}

module.exports = { run, extract, normalize, validate, save };
