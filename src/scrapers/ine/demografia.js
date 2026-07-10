/**
 * Scraper DEMOGRAFIA + EDUCACION por comuna (lo que BCN si entrega).
 *
 * BCN comunal expone:
 *   - poblacion proyectada 2024 (ya en data/comunas-censo2024.json)
 *   - Indice de Dependencia Demografica (IDD)
 *   - Indice de Adultos Mayores (IAM)
 *   - distribucion por grupos etarios
 *   - SIMCE 4o basico (Lectura, Matematica)
 *   - SIMCE 2o medio (Lectura, Matematica)
 *   - Extranjeros % / Pueblos indigenas %
 *
 * SIMCE es un PROXY robusto de nivel educacional/socioeconomico — comunas con
 * SIMCE >280 son sistematicamente las de mayor NSE. Lo usamos como proxy de
 * "nivel educacional alcanzable por la siguiente generacion".
 *
 * Edad mediana / escolaridad promedio NO estan en BCN — provienen de Censo.
 */

const { IneScraperBase, parseChileanNumber } = require('./_base');
const { fetchComuna, findRow, readValue } = require('./_bcn');
const { listComunas, getComunaMeta, asPercent } = require('../../analysis/ine/normalizer');
const region = require('../../context/region-engine');
const DataStore = require('../../utils/data-store');

const scraper = new IneScraperBase('demografia');
const storeKey = () => `ine-${region.context().slug}-demografia`;

async function extract(comunaId) {
  return { bcn: await fetchComuna(comunaId) };
}

function readSimce(tables, etapaRegex) {
  // Tabla SIMCE: ["Unidad Territorial","Lectura","Matemática"]
  // Necesitamos identificar la tabla del nivel (4o basico vs 2o medio).
  // Como BCN no etiqueta claramente, tomamos la primera tabla con headers
  // Lectura+Matematica y la usamos. Etapa actual: solo retornamos ambas.
  let lectura = null, matematica = null;
  for (const t of tables) {
    const hasLect = (t.headers || []).some(h => /lectura/i.test(h));
    const hasMat  = (t.headers || []).some(h => /matem[aá]tica/i.test(h));
    if (hasLect && hasMat) {
      const cr = t.rows.find(r => /^\s*comuna\s+de/i.test(r[0] || ''));
      if (!cr) continue;
      const lIdx = (t.headers || []).findIndex(h => /lectura/i.test(h));
      const mIdx = (t.headers || []).findIndex(h => /matem[aá]tica/i.test(h));
      const offset = cr.length - (t.headers || []).length;
      if (lectura === null && lIdx >= 0) lectura = parseChileanNumber(cr[lIdx + offset]);
      if (matematica === null && mIdx >= 0) matematica = parseChileanNumber(cr[mIdx + offset]);
      if (lectura !== null && matematica !== null) break;
    }
  }
  return { lectura, matematica };
}

function normalize(comunaId, { bcn }) {
  const meta = getComunaMeta(comunaId);
  const out = {
    comunaId,
    comuna: meta?.nombre || comunaId,
    poblacion_total: meta?.poblacion || null,
    idd_proyeccion: null,
    iam_proyeccion: null,
    edad_grupo_0_14_pct: null,
    edad_grupo_15_29_pct: null,
    edad_grupo_30_44_pct: null,
    edad_grupo_45_64_pct: null,
    edad_grupo_65_mas_pct: null,
    simce_4b_lectura: null,
    simce_4b_matematica: null,
    extranjeros_pct: null,
    pueblos_indigenas_pct: null,
    // No disponibles en BCN web:
    edad_mediana: null,
    tamano_hogar_promedio: null,
    jefatura_femenina_pct: null,
    escolaridad_promedio_anos: null,
    educacion_superior_completa_pct: null,
    analfabetismo_pct: null,
    fuentes: [],
    _notas: 'edad mediana, escolaridad, ed. superior no estan en BCN web. Censo/CASEN aparte.'
  };

  if (!bcn?.ok || !bcn.tables.length) {
    if (bcn) scraper.warn(`${comunaId}: ${bcn.reason || 'sin tablas'}`);
    return out;
  }
  out.fuentes.push({ tipo: 'BCN comuna ficha', url: bcn.url });

  const ts = bcn.tables;

  // IDD / IAM
  out.idd_proyeccion = readValue(findRow(ts, /dependencia\s*demogr[aá]fica/i, /proyecci[oó]n/i));
  out.iam_proyeccion = readValue(findRow(ts, /adultos\s*mayores/i, /proyecci[oó]n/i));

  // Grupos etarios — tabla con filas "0 a 14", "15 a 29", "30 a 44", "45 a 64", "65 y mas"
  for (const t of ts) {
    if (!t.rows.some(r => /^0\s*a\s*14/i.test(r[0] || ''))) continue;
    for (const r of t.rows) {
      const label = (r[0] || '').toLowerCase();
      // Valor de la comuna: penultima a antepenultima columna usualmente.
      // Para evitar confusion, tomo el primer numero entre 0-100 que parezca %.
      let pct = null;
      for (let i = 1; i < r.length; i++) {
        const v = parseChileanNumber(r[i]);
        if (v !== null && v >= 0 && v <= 100) {
          pct = v;
          // Tomamos el penultimo % en la fila (proxy del valor comunal % reciente)
        }
      }
      // Mejor: buscamos el primer % razonable, NO un n° absoluto (>100)
      const pctValid = [];
      for (let i = 1; i < r.length; i++) {
        const v = parseChileanNumber(r[i]);
        if (v !== null && v >= 0 && v <= 100) pctValid.push(v);
      }
      const valor = pctValid.length >= 3 ? pctValid[pctValid.length - 3] : pctValid[0] ?? null;

      if (/^0\s*a\s*14/i.test(label))       out.edad_grupo_0_14_pct = asPercent(valor);
      else if (/^15\s*a\s*29/i.test(label)) out.edad_grupo_15_29_pct = asPercent(valor);
      else if (/^30\s*a\s*44/i.test(label)) out.edad_grupo_30_44_pct = asPercent(valor);
      else if (/^45\s*a\s*64/i.test(label)) out.edad_grupo_45_64_pct = asPercent(valor);
      else if (/^65/i.test(label))          out.edad_grupo_65_mas_pct = asPercent(valor);
    }
    break;
  }

  // SIMCE
  const simce = readSimce(ts);
  out.simce_4b_lectura = simce.lectura;
  out.simce_4b_matematica = simce.matematica;

  // Extranjeros / indigenas
  out.extranjeros_pct = asPercent(readValue(
    findRow(ts, /extranjero/i, /extranjero/i)
  ));
  out.pueblos_indigenas_pct = asPercent(readValue(
    findRow(ts, /pueblos\s*ind[ií]genas/i, /ind[ií]genas/i)
  ));

  return out;
}

function validate(r) {
  const issues = [];
  if (r.simce_4b_lectura !== null && (r.simce_4b_lectura < 150 || r.simce_4b_lectura > 400)) {
    issues.push(`SIMCE Lectura fuera de rango (${r.simce_4b_lectura})`);
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
  const conDatos = results.filter(r =>
    r.simce_4b_lectura !== null || r.idd_proyeccion !== null
  ).length;
  DataStore.save(storeKey(), results, scraper.meta({
    comunasConDatos: conDatos,
    comunasTotales: results.length
  }));
  return results;
}

module.exports = { run, extract, normalize, validate, save };
