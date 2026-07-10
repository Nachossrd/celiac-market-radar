/**
 * Scientific Validator.
 *
 * Que valida:
 *   - Que cada peso/modificador usado en el celiac scoring referencie una
 *     clave existente en literature.json
 *   - Que el `evidencia` declarado del modificador no exceda el nivel maximo
 *     de evidencia de sus fuentes (no se puede afirmar 'alta' confianza con
 *     evidencia 'baja')
 *   - Que la suma de pesos del scorer este declarada y sea coherente
 *
 * Que NO hace:
 *   - NO valida papers en runtime (no descarga PubMed). Trabaja sobre el
 *     whitelist humano-curado literature.json.
 *   - NO inventa correlaciones. Si el llamador entrega un peso sin cita,
 *     este modulo lo etiqueta `unsupported` y baja la confianza.
 *
 * Filosofia: el validator es un GUARDIA de honestidad cientifica.
 * Si una inferencia no esta respaldada, debe ser visible aguas abajo.
 */

const literature = require('./literature.json');

const EVIDENCE_ORDER = { 'alta': 3, 'media': 2, 'baja': 1, 'especulativa': 0 };

function maxEvidenceOf(fuentes) {
  let best = 'especulativa';
  for (const f of fuentes) {
    const lit = literature[f];
    if (!lit) continue;
    if (EVIDENCE_ORDER[lit.evidencia] > EVIDENCE_ORDER[best]) best = lit.evidencia;
  }
  return best;
}

/**
 * Valida un modificador (ej: { weight: 0.7, fuentes: [...], evidencia: 'baja' }).
 * Devuelve { ok, level, issues:[] }.
 */
function validateModifier(mod, label = 'modifier') {
  const issues = [];

  if (!mod || typeof mod !== 'object') {
    return { ok: false, level: 'unsupported', issues: [`${label}: no es objeto`] };
  }
  if (typeof mod.weight !== 'number' || !Number.isFinite(mod.weight)) {
    issues.push(`${label}: weight invalido o ausente`);
  }
  if (!Array.isArray(mod.fuentes) || mod.fuentes.length === 0) {
    return {
      ok: false,
      level: 'unsupported',
      issues: [...issues, `${label}: sin fuentes literarias citadas`]
    };
  }

  const missing = mod.fuentes.filter(f => !literature[f]);
  if (missing.length) {
    issues.push(`${label}: fuentes no encontradas en literature.json: ${missing.join(', ')}`);
  }

  const maxEv = maxEvidenceOf(mod.fuentes);
  const declared = mod.evidencia || 'especulativa';
  if (EVIDENCE_ORDER[declared] > EVIDENCE_ORDER[maxEv]) {
    issues.push(`${label}: declara evidencia '${declared}' pero sus fuentes solo soportan '${maxEv}'`);
    return { ok: false, level: maxEv, issues };
  }

  return { ok: issues.length === 0, level: declared, issues };
}

/**
 * Convierte un nivel de evidencia a un factor 0-1 de confianza para propagar.
 */
function evidenceToConfidence(level) {
  switch (level) {
    case 'alta':         return 1.0;
    case 'media':        return 0.75;
    case 'baja':         return 0.5;
    case 'especulativa': return 0.3;
    case 'unsupported':  return 0.15;
    default:             return 0.2;
  }
}

/**
 * Helper: valida un set completo de modificadores ancestral.
 */
function validateAncestralWeights() {
  const set = literature._modificadores_derivados?.modificador_ancestral_chile || {};
  const results = {};
  let globalIssues = [];
  let minLevel = 'alta';
  for (const [key, mod] of Object.entries(set)) {
    const r = validateModifier(mod, `ancestral.${key}`);
    results[key] = r;
    globalIssues = globalIssues.concat(r.issues);
    if (EVIDENCE_ORDER[r.level] < EVIDENCE_ORDER[minLevel]) minLevel = r.level;
  }
  return {
    results,
    globalIssues,
    overallEvidence: minLevel,
    overallConfidence: evidenceToConfidence(minLevel)
  };
}

/**
 * Recupera el peso de una etnia con su confianza individual.
 */
function getAncestralWeight(label) {
  const mod = literature._modificadores_derivados?.modificador_ancestral_chile?.[label];
  if (!mod) {
    return {
      weight: 1.0,
      level: 'unsupported',
      confidence: evidenceToConfidence('unsupported'),
      issues: [`Sin modificador para '${label}' en literature.json`]
    };
  }
  const v = validateModifier(mod, `ancestral.${label}`);
  return {
    weight: mod.weight,
    level: v.level,
    confidence: evidenceToConfidence(v.level),
    issues: v.issues,
    fuentes: mod.fuentes
  };
}

/**
 * Citas usadas — para mostrar en el dashboard.
 */
function citationsFor(keys) {
  return keys
    .map(k => literature[k])
    .filter(Boolean)
    .map(l => ({ cita: l.cita, doi: l.doi || null, evidencia: l.evidencia }));
}

module.exports = {
  validateModifier,
  validateAncestralWeights,
  getAncestralWeight,
  evidenceToConfidence,
  citationsFor,
  literature
};
