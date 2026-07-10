/**
 * Celiac Scorer contextual por comuna.
 *
 * Composicion del celiac_score [0..100]:
 *   prevalencia_base    0.30   — Araya 2015 (0.76% serologico) * modificador ancestral
 *   ingreso             0.15   — proxy de capacidad de comprar gluten-free (es mas caro)
 *   acceso_diagnostico  0.15   — proxy: % educacion + densidad servicios (BCN: simce/medicos)
 *   educacion           0.10   — SIMCE como proxy
 *   consumo_gf          0.10   — % Google Trends + retail premium en la comuna (si existe)
 *   composicion_etnica  0.20   — modificador_ancestral directo
 *
 * La confianza se PROPAGA: cada subcomponente aporta su nivel de evidencia y
 * el score final lleva un campo `confidence` agregado. Si la fuente ancestral
 * es 'baja', el confidence final cae.
 *
 * Output por comuna:
 *   {
 *     comuna, region,
 *     celiac_score [0..100],
 *     confidence [0..1],
 *     prevalencia_estimada_pct,
 *     estimated_celiac_population,
 *     ethnic_modifier,
 *     diagnostic_access,
 *     market_gap_gluten_free,
 *     advertencias: [...],
 *     fuentes: [...]
 *   }
 */

const DataStore = require('../../utils/data-store');
const region = require('../../context/region-engine');
const { buildScores } = require('../ine/score');
const { buildCensusContext, modificadorAncestral } = require('./census-engine');
const validator = require('./scientific-validator');
const literature = require('./literature.json');

const WEIGHTS = {
  prevalencia_base:   0.30,
  ingreso:            0.15,
  acceso_diagnostico: 0.15,
  educacion:          0.10,
  consumo_gf:         0.10,
  composicion_etnica: 0.20
};

const PREVALENCIA_BASE = literature.araya_2015.valor;       // 0.0076
const RATIO_SUBDIAG    = literature.fasano_2003.valor;       // 5

function loadDemografia() {
  const slug = region.context().slug;
  return DataStore.load(`ine-${slug}-demografia`).data || [];
}

function loadGfTrends() {
  // Prioridad: trends de la region activa; fallback al nacional viejo si existe.
  const slug = region.context().slug;
  const sources = [`google-trends-${slug}`, 'google-trends'];
  for (const key of sources) {
    const rec = DataStore.load(key);
    const queries = rec.data?.queries || (Array.isArray(rec.data) ? rec.data : null);
    if (!queries) continue;
    const all = queries.flatMap(x => (x.timeline || []).map(p => p.value)).filter(Number.isFinite);
    if (all.length) return Math.round(all.reduce((s, v) => s + v, 0) / all.length);
  }
  return null;
}

function loadRetailGfCounts() {
  // Cuenta SKUs sin-gluten scrapeados por comuna proxy: no tenemos comuna en el scraper,
  // asi que devolvemos solo el conteo nacional. Si en el futuro el scraper guarda comuna
  // de venta, se usa por-comuna.
  const sources = ['jumbo', 'lider', 'mercadolibre', 'rappi'];
  let total = 0;
  for (const s of sources) {
    const d = DataStore.load(s).data;
    if (Array.isArray(d)) total += d.length;
  }
  return total;
}

function isNum(v) { return v !== null && v !== undefined && Number.isFinite(v); }

function normalize(val, min, max) {
  if (!isNum(val) || max === min) return null;
  return Math.max(0, Math.min(1, (val - min) / (max - min)));
}

function buildCeliacScores() {
  const ineScores = buildScores();
  const census = buildCensusContext();
  const censusById = Object.fromEntries(census.comunas.map(c => [c.comunaId, c]));
  const demoById = Object.fromEntries(loadDemografia().map(d => [d.comunaId, d]));

  const gfTrendNational = loadGfTrends();
  const retailGfNational = loadRetailGfCounts();
  const ctx = region.context();

  // Bounds intra-regionales para acceso_diagnostico y consumo_gf
  const accessProxies = ineScores.scores.map(s => {
    const d = demoById[s.comunaId];
    // Acceso a diagnostico: proxy = SIMCE (educacion) + score INE (servicios). Si no hay,
    // null.
    const simce = d?.simce_4b_lectura ?? null;
    const sciencia = s.poder_adquisitivo_score ?? null;
    if (!isNum(simce) && !isNum(sciencia)) return null;
    return ((simce ?? 250) + (sciencia ?? 50)) / 2;
  }).filter(isNum);

  const accBounds = accessProxies.length
    ? { min: Math.min(...accessProxies), max: Math.max(...accessProxies) }
    : null;

  const validation = validator.validateAncestralWeights();
  const issuesGlobales = validation.globalIssues;

  const perfiles = ineScores.scores.map(s => {
    const censusComuna = censusById[s.comunaId];
    const demoComuna = demoById[s.comunaId];

    const ancestral = censusComuna?.modificador_ancestral
                   || modificadorAncestral(demoComuna || {});

    const prevalenciaEstimada = PREVALENCIA_BASE * ancestral.weight;
    const estimatedCeliacPop = s.poblacion
      ? Math.round(s.poblacion * prevalenciaEstimada)
      : null;

    const subs = {};
    const evidencias = [];

    // 1. Prevalencia base normalizada (a nivel comunal usamos prevalencia_estimada
    //    como senal: mas alta => mayor sub-score)
    subs.prevalencia_base = 1.0; // termino constante; usamos prevalencia_estimada para magnitud final
    evidencias.push({ src: 'araya_2015', conf: 1.0 });

    // 2. Ingreso (proxy: subscore_ingreso del modelo INE)
    if (isNum(s.subscores?.ingreso)) {
      subs.ingreso = s.subscores.ingreso;
      evidencias.push({ src: 'ine_score', conf: 0.85 });
    }

    // 3. Acceso a diagnostico (proxy: SIMCE + score INE normalizado)
    if (accBounds && (isNum(demoComuna?.simce_4b_lectura) || isNum(s.poder_adquisitivo_score))) {
      const raw = ((demoComuna?.simce_4b_lectura ?? 250) + (s.poder_adquisitivo_score ?? 50)) / 2;
      subs.acceso_diagnostico = normalize(raw, accBounds.min, accBounds.max);
      evidencias.push({ src: 'proxy_simce_ine', conf: 0.5 });
    }

    // 4. Educacion (SIMCE)
    if (isNum(s.subscores?.educacion)) {
      subs.educacion = s.subscores.educacion;
      evidencias.push({ src: 'simce', conf: 0.85 });
    }

    // 5. Consumo GF (proxy nacional, no comunal — confianza baja)
    if (isNum(gfTrendNational) || retailGfNational > 0) {
      subs.consumo_gf = Math.min(1, ((gfTrendNational ?? 0) / 100) * 0.5 + Math.min(1, retailGfNational / 500) * 0.5);
      evidencias.push({ src: 'trends_retail_proxy', conf: 0.35 });
    }

    // 6. Composicion etnica (modificador_ancestral ya calibrado contra la base)
    // Lo normalizamos al rango [0..1] respecto al rango plausible de modificadores [0.7..1.15].
    subs.composicion_etnica = normalize(ancestral.weight, 0.7, 1.15);
    evidencias.push({ src: 'ancestral', conf: ancestral.confidence });

    // === score compuesto ===
    const present = Object.entries(subs).filter(([, v]) => isNum(v));
    if (!present.length) {
      return {
        comunaId: s.comunaId, comuna: s.comuna, region: ctx.slug,
        celiac_score: null, confidence: 0,
        prevalencia_estimada_pct: +(prevalenciaEstimada * 100).toFixed(3),
        estimated_celiac_population: estimatedCeliacPop,
        ethnic_modifier: ancestral.weight,
        advertencias: ['Sin variables suficientes para celiac_score'],
        fuentes: ancestral._fuentes
      };
    }

    const totalW = present.reduce((acc, [k]) => acc + WEIGHTS[k], 0);
    const score01 = present.reduce((acc, [k, v]) => acc + v * (WEIGHTS[k] / totalW), 0);

    const confidenceWeighted =
      evidencias.reduce((s2, e) => s2 + e.conf, 0) / evidencias.length;

    // Market gap GF: heuristica simple — alto cuando hay mucho poder adquisitivo
    // pero baja oferta de productos GF (oferta nacional). Si no hay datos, null.
    const marketGap = isNum(s.poder_adquisitivo_score) && retailGfNational > 0
      ? Math.max(0, Math.min(100, Math.round(s.poder_adquisitivo_score - Math.min(50, retailGfNational / 10))))
      : null;

    return {
      comunaId: s.comunaId,
      comuna: s.comuna,
      region: ctx.slug,
      poblacion: s.poblacion,
      lat: s.lat, lng: s.lng,
      celiac_score: Math.round(score01 * 1000) / 10,
      confidence: +confidenceWeighted.toFixed(3),
      prevalencia_estimada_pct: +(prevalenciaEstimada * 100).toFixed(3),
      estimated_celiac_population: estimatedCeliacPop,
      estimated_diagnosed: estimatedCeliacPop ? Math.round(estimatedCeliacPop / RATIO_SUBDIAG) : null,
      estimated_underdiagnosed: estimatedCeliacPop ? estimatedCeliacPop - Math.round(estimatedCeliacPop / RATIO_SUBDIAG) : null,
      ethnic_modifier: ancestral.weight,
      ethnic_modifier_confidence: ancestral.confidence,
      ethnic_breakdown: ancestral.breakdown,
      diagnostic_access: subs.acceso_diagnostico !== undefined
        ? (subs.acceso_diagnostico >= 0.7 ? 'high' : subs.acceso_diagnostico >= 0.4 ? 'medium' : 'low')
        : null,
      market_gap_gluten_free: marketGap,
      subscores: subs,
      advertencias: ancestral._missing ? ['composicion etnica no disponible — usando default mestizo 100%'] : [],
      fuentes: ancestral._fuentes
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    region: { slug: ctx.slug, nombre: ctx.nombre },
    weights: WEIGHTS,
    base_literature: {
      prevalencia: PREVALENCIA_BASE,
      ratio_subdiagnostico: RATIO_SUBDIAG,
      citas: validator.citationsFor(['araya_2015', 'fasano_2003', 'perez_bravo_1999'])
    },
    validation: {
      overallEvidence: validation.overallEvidence,
      overallConfidence: validation.overallConfidence,
      issues: issuesGlobales
    },
    perfiles
  };
}

module.exports = { buildCeliacScores, WEIGHTS };
