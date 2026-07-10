/**
 * Census Engine.
 *
 * Extrae composicion etnica/migrante por comuna a partir de los datos
 * demograficos ya scrapeados (BCN ficha comunal — fuente derivada Censo +
 * CASEN).
 *
 * Variables disponibles hoy en BCN web:
 *   - pueblos_indigenas_pct    (poblacion que se autoidentifica como pueblo originario)
 *   - extranjeros_pct          (nacidos en el extranjero)
 *   - poblacion grupos etarios (proxy de estructura demografica)
 *
 * Lo que NO tenemos sin Censo desagregado:
 *   - desglose mapuche / aymara / quechua / rapanui / atacameno
 *   - pais de origen del migrante (europeo vs latam)
 *
 * Decision de modelado:
 *   ancestral.amerindio    <- pueblos_indigenas_pct
 *   ancestral.migrante_*   <- extranjeros_pct (sin desglose pais => asumimos
 *                              mayoria latam dado el patron migratorio chileno
 *                              actual; weight migrante_latam)
 *   ancestral.mestizo      <- residuo (1 - amerindio - migrante)
 *
 * Esta simplificacion es honesta y se documenta en el output (campo `_modelo`).
 */

const DataStore = require('../../utils/data-store');
const region = require('../../context/region-engine');
const { getAncestralWeight } = require('./scientific-validator');

function loadDemografia() {
  const slug = region.context().slug;
  return DataStore.load(`ine-${slug}-demografia`).data || [];
}

/**
 * Calcula la composicion ancestral aproximada de una comuna.
 * Devuelve fracciones [0..1] que suman ~1.
 */
function composicionAncestral(rec) {
  const indigenas = (rec.pueblos_indigenas_pct ?? null);
  const extranjeros = (rec.extranjeros_pct ?? null);

  if (indigenas === null && extranjeros === null) {
    return { mestizo: 1.0, amerindio: 0, migrante_latam: 0, _missing: true };
  }

  const amerindio = (indigenas ?? 0) / 100;
  const migrante  = (extranjeros ?? 0) / 100;
  // Limpiamos: si por error la suma > 1, normalizamos
  let mestizo = Math.max(0, 1 - amerindio - migrante);
  const total = amerindio + migrante + mestizo;
  return {
    amerindio:       +(amerindio / total).toFixed(3),
    migrante_latam:  +(migrante / total).toFixed(3),
    mestizo:         +(mestizo / total).toFixed(3),
    _missing: false
  };
}

/**
 * Modificador ancestral promedio ponderado para la comuna.
 * Devuelve { weight, confidence, level, breakdown }.
 *
 * Formula: sum_i (fraccion_i * weight_i)  ponderado por confianza individual
 *          de cada categoria. La confianza final es la media ponderada de las
 *          confianzas de las categorias presentes — asi una comuna donde el
 *          peso ancestral viene de literatura 'baja' propaga esa baja
 *          confianza hacia el celiac_score.
 */
function modificadorAncestral(rec) {
  const comp = composicionAncestral(rec);

  const mestizo  = getAncestralWeight('mestizo');
  const amerindio = getAncestralWeight('amerindio');
  const migLatam  = getAncestralWeight('migrante_latam');

  const weightedSum =
    comp.mestizo        * mestizo.weight  +
    comp.amerindio      * amerindio.weight +
    comp.migrante_latam * migLatam.weight;

  const confidenceWeighted =
    comp.mestizo        * mestizo.confidence  +
    comp.amerindio      * amerindio.confidence +
    comp.migrante_latam * migLatam.confidence;

  return {
    weight: +weightedSum.toFixed(3),
    confidence: +confidenceWeighted.toFixed(3),
    breakdown: {
      mestizo:        { fraccion: comp.mestizo,        weight: mestizo.weight,  ev: mestizo.level },
      amerindio:      { fraccion: comp.amerindio,      weight: amerindio.weight, ev: amerindio.level },
      migrante_latam: { fraccion: comp.migrante_latam, weight: migLatam.weight,  ev: migLatam.level }
    },
    _missing: comp._missing,
    _fuentes: [...new Set([
      ...(mestizo.fuentes || []),
      ...(amerindio.fuentes || []),
      ...(migLatam.fuentes || [])
    ])]
  };
}

function buildCensusContext() {
  const records = loadDemografia();
  const slug = region.context().slug;
  const out = records.map(r => ({
    comunaId: r.comunaId,
    comuna: r.comuna,
    indigenas_pct: r.pueblos_indigenas_pct ?? null,
    extranjeros_pct: r.extranjeros_pct ?? null,
    composicion: composicionAncestral(r),
    modificador_ancestral: modificadorAncestral(r),
    grupos_etarios: {
      g_0_14:   r.edad_grupo_0_14_pct ?? null,
      g_15_29:  r.edad_grupo_15_29_pct ?? null,
      g_30_44:  r.edad_grupo_30_44_pct ?? null,
      g_45_64:  r.edad_grupo_45_64_pct ?? null,
      g_65_mas: r.edad_grupo_65_mas_pct ?? null
    }
  }));

  return {
    region: slug,
    generatedAt: new Date().toISOString(),
    comunas: out,
    _modelo: 'amerindio = pueblos_indigenas_pct, migrante_latam = extranjeros_pct (sin desglose pais), mestizo = residuo. Refinar con Censo desagregado cuando este disponible.'
  };
}

module.exports = { buildCensusContext, composicionAncestral, modificadorAncestral };
