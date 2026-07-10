/**
 * Perfilamiento territorial — consciente de region.
 *
 * Cada perfil entrega no solo score+nivel+elasticidad, sino tambien un
 * `perfil_consumo` cualitativo derivado de:
 *   1) banda socioeconomica del score
 *   2) zonas funcionales donde aparece la comuna (turistica, portuaria,
 *      minera, agricola, industrial)
 *   3) perfil economico declarado en el JSON regional
 *
 * Ejemplos:
 *   Vitacura (RM, alto, urbano)          => "premium urbano"
 *   Concon (Valpo, alto, costero)        => "premium costero"
 *   San Pedro de Atacama (Antof, alto)   => "premium turistico"
 *   Calama (Antof, medio-alto, mineria)  => "estable minero"
 *   La Pintana (RM, bajo, urbano)        => "sensible al precio urbano"
 */

const { buildScores } = require('./score');
const { classify } = require('./classifier');
const { buildHeatmap } = require('./heatmap');
const region = require('../../context/region-engine');

function nivelEducacionalLabel(simceLec, simceMat) {
  const vals = [simceLec, simceMat].filter(v => v !== null && v !== undefined);
  if (!vals.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (avg >= 290) return 'alto';
  if (avg >= 275) return 'medio-alto';
  if (avg >= 260) return 'medio';
  if (avg >= 245) return 'medio-bajo';
  return 'bajo';
}

function densidadComercialLabel(heatOp) {
  if (heatOp === null || heatOp === undefined) return null;
  if (heatOp >= 75) return 'muy-alta';
  if (heatOp >= 50) return 'alta';
  if (heatOp >= 25) return 'media';
  return 'baja';
}

function perfilConsumoLabel(rec, ctx) {
  const banda = rec.nivel_socioeconomico;
  if (!banda) return null;

  const zonas = ctx.zonas || {};
  const id = rec.comunaId;
  const inZona = (k) => Array.isArray(zonas[k]) && zonas[k].includes(id);

  const altaBanda = banda === 'Alto' || banda === 'Medio-Alto';
  const bajaBanda = banda === 'Bajo' || banda === 'Medio-Bajo';

  if (altaBanda && inZona('turisticas') && inZona('portuarias') === false) {
    if (inZona('mineras')) return 'premium minero';
    return 'premium costero/turistico';
  }
  if (altaBanda && inZona('mineras')) return 'estable minero alto';
  if (altaBanda && inZona('portuarias')) return 'urbano-portuario alto';
  if (altaBanda) return 'premium urbano';

  if (banda === 'Medio' && inZona('turisticas')) return 'medio turistico estacional';
  if (banda === 'Medio' && inZona('industriales')) return 'medio industrial';
  if (banda === 'Medio' && inZona('mineras')) return 'medio minero';
  if (banda === 'Medio' && inZona('agricolas')) return 'medio agricola';
  if (banda === 'Medio') return 'medio urbano';

  if (bajaBanda && inZona('agricolas')) return 'sensible al precio rural-agricola';
  if (bajaBanda && inZona('mineras')) return 'sensible al precio minero periferico';
  if (bajaBanda && inZona('industriales')) return 'sensible al precio industrial';
  if (bajaBanda) return 'sensible al precio urbano';

  return 'estandar';
}

function buildProfiles() {
  const { scores, bounds, weights, region: regionMeta } = buildScores();
  const heat = buildHeatmap(scores);
  const heatById = Object.fromEntries(heat.rows.map(r => [r.comunaId, r]));
  const ctx = region.context();

  const perfiles = scores.map(rec => {
    const cls = classify(rec);
    const h = heatById[rec.comunaId] || {};
    const merged = {
      ...rec,
      nivel_socioeconomico: cls.nivel_socioeconomico,
    };
    return {
      comunaId: rec.comunaId,
      comuna: rec.comuna,
      sector: rec.sector,
      poblacion: rec.poblacion,
      lat: rec.lat,
      lng: rec.lng,
      region: regionMeta.slug,
      poder_adquisitivo: rec.poder_adquisitivo_score,
      nivel_socioeconomico: cls.nivel_socioeconomico,
      clase_confianza: cls.clase_confianza,
      confirmaciones: cls.confirmaciones,
      elasticidad_precio: cls.elasticidad_precio,
      probabilidad_consumo_premium: cls.probabilidad_consumo_premium,
      nivel_educacional: nivelEducacionalLabel(
        rec.variables?.simce_4b_lectura,
        rec.variables?.simce_4b_matematica
      ),
      densidad_comercial: densidadComercialLabel(h.heat_oportunidad),
      perfil_consumo: perfilConsumoLabel(merged, ctx),
      heat: {
        demanda: h.heat_demanda ?? null,
        oportunidad: h.heat_oportunidad ?? null,
        oferta_locales: h.oferta_locales ?? 0,
        estado: h.estado ?? null
      },
      subscores: rec.subscores,
      confianza_score: rec.confianza,
      variables: rec.variables
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    region: regionMeta,
    universo: perfiles.length,
    weights,
    bounds_normalizacion: bounds,
    heatmap_metadata: heat.metadata,
    perfiles
  };
}

module.exports = { buildProfiles };
