/**
 * Exporter analitico (JSON + CSV).
 * Esquema plano por comuna. Compatible con Power BI, BigQuery, Postgres y pandas.
 * Separador `;` (los nombres chilenos usan comas).
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const { buildProfiles } = require('./profile');
const region = require('../../context/region-engine');

const EXPORTS_DIR = path.join(__dirname, '../../../data/ine/exports');

const COLUMNS = [
  'region', 'comunaId', 'comuna', 'sector', 'poblacion', 'lat', 'lng',
  'poder_adquisitivo', 'nivel_socioeconomico', 'clase_confianza', 'confirmaciones',
  'elasticidad_precio', 'probabilidad_consumo_premium',
  'nivel_educacional', 'densidad_comercial', 'perfil_consumo',
  'subscore_ingreso', 'subscore_educacion', 'subscore_vivienda', 'subscore_empleo', 'subscore_consumo',
  'confianza_score',
  'heat_demanda', 'heat_oportunidad', 'oferta_locales', 'estado_heatmap',
  'pobreza_ingresos_pct', 'pobreza_multidimensional_pct',
  'hacinamiento_pct', 'carencia_servicios_basicos_pct',
  'simce_4b_lectura', 'simce_4b_matematica',
  'empresas_total', 'empresas_grandes_pct', 'empresas_micro_pct', 'empresas_per_1000hab',
  'idd_proyeccion', 'iam_proyeccion', 'extranjeros_pct'
];

function flatten(p) {
  return {
    region: p.region,
    comunaId: p.comunaId,
    comuna: p.comuna,
    sector: p.sector,
    poblacion: p.poblacion,
    lat: p.lat,
    lng: p.lng,
    poder_adquisitivo: p.poder_adquisitivo,
    nivel_socioeconomico: p.nivel_socioeconomico,
    clase_confianza: p.clase_confianza,
    confirmaciones: p.confirmaciones,
    elasticidad_precio: p.elasticidad_precio,
    probabilidad_consumo_premium: p.probabilidad_consumo_premium,
    nivel_educacional: p.nivel_educacional,
    densidad_comercial: p.densidad_comercial,
    perfil_consumo: p.perfil_consumo,
    subscore_ingreso:   p.subscores?.ingreso,
    subscore_educacion: p.subscores?.educacion,
    subscore_vivienda:  p.subscores?.vivienda,
    subscore_empleo:    p.subscores?.empleo,
    subscore_consumo:   p.subscores?.consumo,
    confianza_score: p.confianza_score,
    heat_demanda:     p.heat?.demanda,
    heat_oportunidad: p.heat?.oportunidad,
    oferta_locales:   p.heat?.oferta_locales,
    estado_heatmap:   p.heat?.estado,
    pobreza_ingresos_pct:           p.variables?.pobreza_ingresos_pct,
    pobreza_multidimensional_pct:   p.variables?.pobreza_multidimensional_pct,
    hacinamiento_pct:               p.variables?.hacinamiento_pct,
    carencia_servicios_basicos_pct: p.variables?.carencia_servicios_basicos_pct,
    simce_4b_lectura:               p.variables?.simce_4b_lectura,
    simce_4b_matematica:            p.variables?.simce_4b_matematica,
    empresas_total:                 p.variables?.empresas_total,
    empresas_grandes_pct:           p.variables?.empresas_grandes_pct,
    empresas_micro_pct:             p.variables?.empresas_micro_pct,
    empresas_per_1000hab:           p.variables?.empresas_per_1000hab,
    idd_proyeccion:                 p.variables?.idd_proyeccion,
    iam_proyeccion:                 p.variables?.iam_proyeccion,
    extranjeros_pct:                p.variables?.extranjeros_pct
  };
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(';') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCSV(rows) {
  const lines = [COLUMNS.join(';')];
  for (const r of rows) lines.push(COLUMNS.map(c => csvEscape(r[c])).join(';'));
  return lines.join('\n') + '\n';
}

function ensureDir() {
  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

function exportAll() {
  ensureDir();
  const profile = buildProfiles();
  const flatRows = profile.perfiles.map(flatten);

  const slug = region.context().slug;
  const jsonPath = path.join(EXPORTS_DIR, `perfiles-${slug}.json`);
  const csvPath  = path.join(EXPORTS_DIR, `perfiles-${slug}.csv`);

  fs.writeFileSync(jsonPath, JSON.stringify(profile, null, 2));
  fs.writeFileSync(csvPath, toCSV(flatRows));

  logger.info(`[Exporter:${slug}] JSON => ${jsonPath} (${profile.perfiles.length} perfiles)`);
  logger.info(`[Exporter:${slug}] CSV  => ${csvPath}`);

  return {
    region: slug,
    jsonPath,
    csvPath,
    perfiles: profile.perfiles.length,
    conScore: profile.perfiles.filter(p => p.poder_adquisitivo !== null).length,
    altaConfianza: profile.perfiles.filter(p => p.clase_confianza === 'alta').length
  };
}

module.exports = { exportAll, toCSV, COLUMNS };
