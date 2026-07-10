/**
 * Scraper VIVIENDA por comuna.
 *
 * Indicadores BCN comunal:
 *   - hogares_hacinados_pct        (CASEN — proxy directo de calidad vivienda)
 *   - carencia_servicios_basicos_pct (% personas en hogares sin servicios)
 *
 * Tipo de vivienda (casa/depto) y tenencia (propia/arrendada) NO estan en
 * BCN web por comuna. Quedan null + nota de origen alternativo.
 */

const { IneScraperBase } = require('./_base');
const { fetchComuna, findRow, readValue } = require('./_bcn');
const { listComunas, getComunaMeta, asPercent } = require('../../analysis/ine/normalizer');
const region = require('../../context/region-engine');
const DataStore = require('../../utils/data-store');

const scraper = new IneScraperBase('vivienda');
const storeKey = () => `ine-${region.context().slug}-vivienda`;

async function extract(comunaId) {
  return { bcn: await fetchComuna(comunaId) };
}

function normalize(comunaId, { bcn }) {
  const out = {
    comunaId,
    comuna: getComunaMeta(comunaId)?.nombre || comunaId,
    hacinamiento_pct: null,
    carencia_servicios_basicos_pct: null,
    // No disponibles en BCN web:
    viviendas_propias_pct: null,
    viviendas_arrendadas_pct: null,
    hacinamiento_critico_pct: null,
    calidad_deficitaria_pct: null,
    tipo_predominante: null,
    fuentes: [],
    _notas: 'tenencia y tipo (casa/depto) no estan en BCN web. Ver Censo 2017 INE redatam o CASEN.'
  };

  if (!bcn?.ok || !bcn.tables.length) {
    if (bcn) scraper.warn(`${comunaId}: ${bcn.reason || 'sin tablas'}`);
    return out;
  }
  out.fuentes.push({ tipo: 'BCN comuna ficha', url: bcn.url });

  const ts = bcn.tables;

  // Tabla compartida: Personas en hogares carentes de servicios basicos | Hogares hacinados
  out.hacinamiento_pct = asPercent(readValue(
    findRow(ts, /hogares\s*hacinados|hacinamiento/i, /hogares\s*hacinados|hacinamiento/i)
  ));
  out.carencia_servicios_basicos_pct = asPercent(readValue(
    findRow(ts, /servicios\s*b[aá]sicos|carencia/i, /servicios\s*b[aá]sicos|carencia/i)
  ));

  return out;
}

function validate(r) {
  const issues = [];
  if (r.hacinamiento_pct !== null && r.hacinamiento_pct > 80) {
    issues.push(`hacinamiento sospechoso ${r.hacinamiento_pct}%`);
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
  const conDatos = results.filter(r => r.hacinamiento_pct !== null).length;
  DataStore.save(storeKey(), results, scraper.meta({
    comunasConDatos: conDatos,
    comunasTotales: results.length
  }));
  return results;
}

module.exports = { run, extract, normalize, validate, save };
