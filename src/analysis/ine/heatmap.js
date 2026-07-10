/**
 * Heatmap comercial y deteccion de oportunidades.
 *
 * Modelo: dos senales por comuna.
 *   - demanda_potencial = poblacion * (1 + score_normalizado)
 *                         (poblacion ponderada por poder adquisitivo, no
 *                          poblacion absoluta — 100k habitantes de Vitacura
 *                          mueven mas dinero que 100k de La Pintana)
 *   - oferta_aproximada = locales scrapeados via google-maps (si existe data)
 *
 * Indice de oportunidad = demanda_potencial / (oferta + 1)
 *
 * Una comuna con alta demanda potencial y poca oferta = "subatendida".
 * Una con baja demanda y mucha oferta = "saturada".
 *
 * Esto requiere que el modulo google-maps ya haya corrido. Si no, devolvemos
 * demanda potencial solamente y avisamos.
 */

const DataStore = require('../../utils/data-store');

const PESO_PODER_ADQ = 1.5; // multiplicador maximo: comuna con score=100 vale 2.5x su poblacion

function buildHeatmap(scoredRecords) {
  // Maps storage por region; fallback al viejo nacional si no existe.
  const region = require('../../context/region-engine');
  const slug = region.context().slug;
  let maps = DataStore.load(`google-maps-${slug}`);
  if (!maps || maps.itemCount === 0) maps = DataStore.load('google-maps');
  const locales = Array.isArray(maps.data) ? maps.data : [];

  // Cuenta locales por comuna (matching laxo)
  const ofertaPorComuna = {};
  for (const loc of locales) {
    const slug = (loc.comuna || loc.address || loc.barrio || '').toLowerCase();
    if (!slug) continue;
    for (const rec of scoredRecords) {
      const needle = rec.comuna.toLowerCase();
      if (slug.includes(needle.split(' ')[0])) {
        ofertaPorComuna[rec.comunaId] = (ofertaPorComuna[rec.comunaId] || 0) + 1;
      }
    }
  }

  // Calcula demanda potencial
  const rows = scoredRecords.map(rec => {
    const factor = rec.poder_adquisitivo_score !== null
      ? 1 + (rec.poder_adquisitivo_score / 100) * PESO_PODER_ADQ
      : 1;
    const demanda = (rec.poblacion || 0) * factor;
    const oferta = ofertaPorComuna[rec.comunaId] || 0;
    const oportunidad = demanda / (oferta + 1);
    return {
      comunaId: rec.comunaId,
      comuna: rec.comuna,
      sector: rec.sector,
      lat: rec.lat,
      lng: rec.lng,
      poblacion: rec.poblacion,
      poder_adquisitivo_score: rec.poder_adquisitivo_score,
      demanda_potencial: Math.round(demanda),
      oferta_locales: oferta,
      indice_oportunidad: Math.round(oportunidad)
    };
  });

  // Normaliza indices a 0-100 para visualizacion
  const maxOp = Math.max(...rows.map(r => r.indice_oportunidad), 1);
  const maxDem = Math.max(...rows.map(r => r.demanda_potencial), 1);
  for (const r of rows) {
    r.heat_demanda = Math.round((r.demanda_potencial / maxDem) * 100);
    r.heat_oportunidad = Math.round((r.indice_oportunidad / maxOp) * 100);
    r.estado = clasifEstado(r);
  }

  return {
    rows,
    metadata: {
      ofertaDisponible: locales.length > 0,
      fuenteOferta: locales.length > 0 ? 'google-maps scrapeado' : 'sin oferta scrapeada — heatmap solo refleja demanda',
      pesoPoderAdquisitivo: PESO_PODER_ADQ
    }
  };
}

function clasifEstado(r) {
  if (r.poder_adquisitivo_score === null) return 'sin-datos';
  if (r.oferta_locales === 0 && r.heat_demanda >= 60) return 'subatendida';
  if (r.oferta_locales > 0 && r.heat_oportunidad >= 70) return 'oportunidad-alta';
  if (r.oferta_locales > 5 && r.heat_demanda < 30)     return 'saturada';
  if (r.poder_adquisitivo_score >= 75)                  return 'premium';
  if (r.poder_adquisitivo_score <= 30)                  return 'sensible-precio';
  return 'estandar';
}

module.exports = { buildHeatmap };
