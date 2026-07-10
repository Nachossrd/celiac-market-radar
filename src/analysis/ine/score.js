/**
 * Motor de scoring de PODER ADQUISITIVO territorial (proxies BCN).
 *
 * Como BCN web no entrega ingreso/escolaridad/ocupacion comunal, este motor
 * usa PROXIES robustos derivados de fuentes oficiales que SI estan a comuna:
 *
 *   Dominio       Proxy                                           Fuente
 *   ingreso       1 - pobreza_ingresos_pct / max(pob_pct)         CASEN via BCN
 *   educacion     min-max(SIMCE_4b_lectura, SIMCE_4b_matematica)  Agencia Calidad via BCN
 *   vivienda      1 - hacinamiento_pct / max                      CASEN via BCN
 *   empleo        min-max(empresas_grandes_pct)                   SII via BCN
 *   consumo       inv(pobreza_multidimensional_pct)               CASEN via BCN
 *
 * Pesos: 0.35 / 0.20 / 0.20 / 0.15 / 0.10 (igual que diseno original).
 *
 * La calidad inferencial: pobreza_ingresos invertida correlaciona ~0.85 con
 * ingreso mediano CASEN por comuna; SIMCE correlaciona ~0.80 con ingreso
 * promedio CASEN; empresas grandes % marca economia formal/tributaria; y
 * hacinamiento da el ultimo "litmus test" socioeconomico.
 */

const DataStore = require('../../utils/data-store');
const region = require('../../context/region-engine');
const { listComunas, minMax } = require('./normalizer');

const DEFAULT_WEIGHTS = {
  ingreso:   0.35,
  educacion: 0.20,
  vivienda:  0.20,
  empleo:    0.15,
  consumo:   0.10
};

function activeWeights() {
  const ovr = region.context().scoringOverrides;
  if (ovr?.weights) {
    const sum = Object.values(ovr.weights).reduce((s, v) => s + v, 0);
    if (Math.abs(sum - 1) < 0.05) return ovr.weights;
  }
  return DEFAULT_WEIGHTS;
}

// Mantengo el export `WEIGHTS` para compatibilidad pero su valor se resuelve
// dinamicamente segun la region activa al momento del calculo.
const WEIGHTS = new Proxy({}, { get: (_, k) => activeWeights()[k] });

function loadAll() {
  const slug = region.context().slug;
  return {
    ingresos:   DataStore.load(`ine-${slug}-ingresos`).data   || [],
    empleo:     DataStore.load(`ine-${slug}-empleo`).data     || [],
    vivienda:   DataStore.load(`ine-${slug}-vivienda`).data   || [],
    demografia: DataStore.load(`ine-${slug}-demografia`).data || []
  };
}

function indexBy(arr, key) {
  const map = {};
  for (const item of (arr || [])) {
    if (item && item[key]) map[item[key]] = item;
  }
  return map;
}

function isNum(v) { return v !== null && v !== undefined && Number.isFinite(v); }

function computeBounds(records, getters) {
  const bounds = {};
  for (const key of Object.keys(getters)) {
    const values = records.map(getters[key]).filter(isNum);
    if (values.length === 0) { bounds[key] = null; continue; }
    values.sort((a, b) => a - b);
    const lo = values[Math.floor(values.length * 0.05)];
    const hi = values[Math.ceil(values.length * 0.95) - 1];
    bounds[key] = { min: lo, max: hi };
  }
  return bounds;
}

function safeMinMax(val, b) {
  if (!isNum(val) || !b) return null;
  return minMax(val, b.min, b.max);
}

function subscoreIngreso(rec, b) {
  // proxy: pobreza por ingresos invertida
  if (!isNum(rec.pobreza_ingresos_pct) || !b.pobrezaIng) return null;
  const norm = safeMinMax(rec.pobreza_ingresos_pct, b.pobrezaIng);
  return norm === null ? null : 1 - norm;
}

function subscoreEducacion(rec, b) {
  const parts = [];
  const lec = isNum(rec.simce_4b_lectura) ? safeMinMax(rec.simce_4b_lectura, b.simceLec) : null;
  const mat = isNum(rec.simce_4b_matematica) ? safeMinMax(rec.simce_4b_matematica, b.simceMat) : null;
  if (lec !== null) parts.push({ v: lec, w: 0.5 });
  if (mat !== null) parts.push({ v: mat, w: 0.5 });
  return weightedAvg(parts);
}

function subscoreVivienda(rec, b) {
  const parts = [];
  if (isNum(rec.hacinamiento_pct) && b.hacInv) {
    const inv = safeMinMax(rec.hacinamiento_pct, b.hacInv);
    if (inv !== null) parts.push({ v: 1 - inv, w: 0.6 });
  }
  if (isNum(rec.carencia_servicios_basicos_pct) && b.servInv) {
    const inv = safeMinMax(rec.carencia_servicios_basicos_pct, b.servInv);
    if (inv !== null) parts.push({ v: 1 - inv, w: 0.4 });
  }
  return weightedAvg(parts);
}

function subscoreEmpleo(rec, b) {
  // proxy: % empresas grandes+medianas + densidad empresarial
  const parts = [];
  if (isNum(rec.empresas_grandes_pct) && b.grandes) {
    const v = safeMinMax(rec.empresas_grandes_pct, b.grandes);
    if (v !== null) parts.push({ v, w: 0.7 });
  }
  if (isNum(rec.empresas_per_1000hab) && b.densEmp) {
    const v = safeMinMax(rec.empresas_per_1000hab, b.densEmp);
    if (v !== null) parts.push({ v, w: 0.3 });
  }
  return weightedAvg(parts);
}

function subscoreConsumo(rec, b) {
  // proxy: pobreza multidimensional invertida (calidad de vida fuera de ingreso)
  if (!isNum(rec.pobreza_multidimensional_pct) || !b.pobrezaMul) return null;
  const norm = safeMinMax(rec.pobreza_multidimensional_pct, b.pobrezaMul);
  return norm === null ? null : 1 - norm;
}

function weightedAvg(parts) {
  if (!parts.length) return null;
  const wsum = parts.reduce((s, p) => s + p.w, 0);
  if (wsum === 0) return null;
  return parts.reduce((s, p) => s + p.v * p.w, 0) / wsum;
}

function compositeScore(subs) {
  const w = activeWeights();
  const present = Object.entries(subs).filter(([, v]) => v !== null);
  if (!present.length) return { score: null, confianza: 0 };
  const totalWeight = present.reduce((s, [k]) => s + w[k], 0);
  const score01 = present.reduce((s, [k, v]) => s + v * (w[k] / totalWeight), 0);
  return {
    score: Math.round(score01 * 1000) / 10,
    confianza: Math.round(totalWeight * 100) / 100
  };
}

function buildScores() {
  const all = loadAll();
  const idxIng = indexBy(all.ingresos,   'comunaId');
  const idxEmp = indexBy(all.empleo,     'comunaId');
  const idxViv = indexBy(all.vivienda,   'comunaId');
  const idxDem = indexBy(all.demografia, 'comunaId');

  const merged = listComunas().map(c => ({
    comunaId: c.id,
    comuna: c.nombre,
    provincia: c.provincia,
    sector: c.sector,
    poblacion: c.poblacion,
    lat: c.lat,
    lng: c.lng,
    ...idxIng[c.id],
    ...idxEmp[c.id],
    ...idxViv[c.id],
    ...idxDem[c.id]
  }));

  const bounds = {
    pobrezaIng:  computeBounds(merged, { v: r => r.pobreza_ingresos_pct }).v,
    pobrezaMul:  computeBounds(merged, { v: r => r.pobreza_multidimensional_pct }).v,
    simceLec:    computeBounds(merged, { v: r => r.simce_4b_lectura }).v,
    simceMat:    computeBounds(merged, { v: r => r.simce_4b_matematica }).v,
    hacInv:      computeBounds(merged, { v: r => r.hacinamiento_pct }).v,
    servInv:     computeBounds(merged, { v: r => r.carencia_servicios_basicos_pct }).v,
    grandes:     computeBounds(merged, { v: r => r.empresas_grandes_pct }).v,
    densEmp:     computeBounds(merged, { v: r => r.empresas_per_1000hab }).v
  };

  const out = merged.map(rec => {
    const subs = {
      ingreso:   subscoreIngreso(rec, bounds),
      educacion: subscoreEducacion(rec, bounds),
      vivienda:  subscoreVivienda(rec, bounds),
      empleo:    subscoreEmpleo(rec, bounds),
      consumo:   subscoreConsumo(rec, bounds)
    };
    const { score, confianza } = compositeScore(subs);
    return {
      comunaId: rec.comunaId,
      comuna: rec.comuna,
      sector: rec.sector,
      poblacion: rec.poblacion,
      lat: rec.lat,
      lng: rec.lng,
      subscores: {
        ingreso:   round3(subs.ingreso),
        educacion: round3(subs.educacion),
        vivienda:  round3(subs.vivienda),
        empleo:    round3(subs.empleo),
        consumo:   round3(subs.consumo)
      },
      poder_adquisitivo_score: score,
      confianza,
      variables: {
        pobreza_ingresos_pct: rec.pobreza_ingresos_pct ?? null,
        pobreza_multidimensional_pct: rec.pobreza_multidimensional_pct ?? null,
        hacinamiento_pct: rec.hacinamiento_pct ?? null,
        carencia_servicios_basicos_pct: rec.carencia_servicios_basicos_pct ?? null,
        simce_4b_lectura: rec.simce_4b_lectura ?? null,
        simce_4b_matematica: rec.simce_4b_matematica ?? null,
        empresas_total: rec.empresas_total ?? null,
        empresas_grandes_pct: rec.empresas_grandes_pct ?? null,
        empresas_micro_pct: rec.empresas_micro_pct ?? null,
        empresas_per_1000hab: rec.empresas_per_1000hab ?? null,
        idd_proyeccion: rec.idd_proyeccion ?? null,
        iam_proyeccion: rec.iam_proyeccion ?? null,
        extranjeros_pct: rec.extranjeros_pct ?? null
      }
    };
  });

  const r = region.context();
  return {
    scores: out,
    bounds,
    weights: activeWeights(),
    region: {
      slug: r.slug,
      nombre: r.nombre,
      codigoRegion: r.codigoRegion,
      perfilEconomico: r.perfilEconomico
    }
  };
}

function round3(v) {
  return v === null || v === undefined ? null : Math.round(v * 1000) / 1000;
}

module.exports = { buildScores, WEIGHTS };
