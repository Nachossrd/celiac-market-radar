/**
 * Cliente BCN Reportes Comunales (v2 — sistema migrado).
 *
 * Cambio respecto a v1:
 *   BCN migro de https://reportescomunales.bcn.cl/<año>/index.php/<nombre>/<seccion>
 *   a            https://www.bcn.cl/siit/reportescomunales/comunas_v.html?anno=<año>&idcom=<DEIS>
 *   En la nueva version TODA la ficha de una comuna esta en una sola pagina
 *   (~36 tablas), separadas por <h4> con titulos como "Indicadores
 *   demograficos", "Indicadores economicos", etc. No hay endpoints por
 *   seccion. Eso es bueno: 1 fetch = todo el contexto.
 *
 * Diseño:
 *   - URL unica por comuna => mucho menos load para BCN
 *   - Cache de sesion: si ingresos.js descargo Las Condes, empleo.js lo recibe
 *     instantaneo. Como cada `npm run scrape:ine` corre en un proceso, el cache
 *     se vacia entre corridas (perfecto: data fresca cada vez).
 *   - Parser de tablas Bootstrap (class="table ..."), no wikitable.
 */

const { fetchWithRetry, detectStructuralChange } = require('./_base');
const region = require('../../context/region-engine');
const logger = require('../../utils/logger');

const BCN_YEAR = process.env.BCN_YEAR || '2024';
const BCN_BASE = 'https://www.bcn.cl/siit/reportescomunales/comunas_v.html';

function deisFor(comunaId) {
  return region.context().deisFor(comunaId);
}

function urlFor(comunaId) {
  const code = deisFor(comunaId);
  if (!code) {
    const r = region.context();
    throw new Error(`Sin codigo DEIS para '${comunaId}' en region ${r.slug}. Verifica que la comuna exista en src/config/regions/${r.slug}.json`);
  }
  return `${BCN_BASE}?anno=${BCN_YEAR}&idcom=${code}`;
}

function stripTags(s) {
  return String(s)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, ' / ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é').replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&ntilde;/gi, 'ñ');
}

function normWS(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

/**
 * Parser de tablas Bootstrap.
 * Captura todas las <table class="table*">. Para cada tabla devuelve:
 *   { headers: string[], rows: string[][] }
 * Headers: ultima fila <thead> si existe; si no, primera <tr>.
 * Rows: las filas de <tbody> (o el resto del <tr> si no hay tbody).
 *
 * NOTA: ignora rowspan/colspan a nivel estructural — para nuestros casos los
 * labels viven en la primera columna y los valores en las restantes, lo cual
 * el findRow toma sin problema.
 */
function parseAllTables(html) {
  const tables = [];
  const reTable = /<table[^>]*class="[^"]*\btable\b[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  let idx = 0;

  while ((m = reTable.exec(html)) !== null) {
    const inner = m[1];
    const tableStart = m.index;

    // Titulo: el <h4> mas cercano por encima en una ventana de 1500 chars.
    let titulo = null;
    const before = html.slice(Math.max(0, tableStart - 1500), tableStart);
    const heads = [...before.matchAll(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/gi)];
    if (heads.length) titulo = normWS(stripTags(heads[heads.length - 1][1]));

    // Headers y rows
    const theadMatch = inner.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
    const tbodyMatch = inner.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);

    let headers = [];
    if (theadMatch) {
      const headRows = [...theadMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
      const lastHead = headRows[headRows.length - 1];
      if (lastHead) {
        headers = [...lastHead[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
          .map(c => normWS(stripTags(c[1])));
      }
    }

    const bodyHtml = tbodyMatch ? tbodyMatch[1] : inner;
    const rows = [];
    for (const tr of bodyHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)]
        .map(c => normWS(stripTags(c[1])));
      if (cells.length) rows.push(cells);
    }

    // Si no hubo thead, la primera fila probablemente es header
    if (!headers.length && rows.length > 1) {
      headers = rows[0];
      rows.shift();
    }

    tables.push({ index: idx++, titulo, headers, rows });
  }

  return tables;
}

/**
 * Estructura BCN: cada tabla suele tener una fila tipo
 *   ["Unidad Territorial", "<nombre del indicador>"]
 * seguida de subheaders y filas de datos
 *   ["Comuna de X", "valor1", "valor2"]
 *
 * `findRow` localiza una tabla cuyo TITULO / HEADERS / FILAS contenga el
 * patron, y retorna la fila de "Comuna de ...". Si se pasa `subRegex`, ademas
 * intenta ubicar la columna correspondiente para tablas con multiples
 * indicadores (ej: hacinamiento + servicios basicos en la misma tabla).
 */
function findRow(tables, labelRegex, subRegex) {
  for (const t of tables) {
    const matchInTitle   = labelRegex.test(t.titulo || '');
    const matchInHeaders = (t.headers || []).some(h => labelRegex.test(h));
    const matchInRows    = t.rows.some(r => r.some(c => labelRegex.test(c)));

    if (!matchInTitle && !matchInHeaders && !matchInRows) continue;

    const comunaRow = t.rows.find(r => /^\s*comuna\s+de/i.test(r[0] || ''));
    if (!comunaRow) continue;

    // Alineacion por derecha: BCN suele duplicar "Comuna de X" en col 0 y 1,
    // pero los headers comienzan desde lo que corresponde al primer dato.
    // => el ultimo header corresponde a la ultima celda, etc.
    let dataIdx = -1;
    if (subRegex) {
      const headers = t.headers || [];
      const hIdx = headers.findIndex(h => subRegex.test(h));
      if (hIdx >= 0) {
        const offset = comunaRow.length - headers.length;
        dataIdx = hIdx + offset;
      } else {
        // fallback: buscar literal en cualquier fila (subheader)
        for (const r of t.rows) {
          const i = r.findIndex(c => subRegex.test(c));
          if (i >= 0) { dataIdx = i; break; }
        }
      }
    }

    return { row: comunaRow, table: t, dataIdx };
  }
  return null;
}

/**
 * Dado un match de findRow, retorna el valor numerico correcto.
 * - Si dataIdx >= 0 (sub-regex resolvio una columna), usa ese indice.
 * - Si no, devuelve el ULTIMO numero de la fila (dato mas reciente).
 */
const { parseChileanNumber } = require('./_base');
function readValue(match) {
  if (!match) return null;
  const row = match.row;
  if (match.dataIdx >= 0 && match.dataIdx < row.length) {
    const v = parseChileanNumber(row[match.dataIdx]);
    if (v !== null) return v;
  }
  for (let i = row.length - 1; i >= 1; i--) {
    const cell = row[i];
    if (!cell || /^comuna\s+de/i.test(cell)) continue;
    const v = parseChileanNumber(cell);
    if (v !== null) return v;
  }
  return null;
}

// ----- Cache de sesion --------------------------------------------------
// El cache es por proceso. Si la region cambia mid-run, se invalida (no
// mezclamos datos de regiones distintas en el mismo job).
const SESSION_CACHE = new Map();
let _fetchCount = 0;
let _cacheRegion = null;

region.onChange((newCtx, prevSlug) => {
  if (prevSlug && prevSlug !== newCtx.slug) {
    SESSION_CACHE.clear();
    _fetchCount = 0;
    _cacheRegion = newCtx.slug;
    logger.info(`[BCN] Region cambiada ${prevSlug} -> ${newCtx.slug}. Cache invalidado.`);
  }
});

async function fetchComuna(comunaId) {
  const slug = region.context().slug;
  if (_cacheRegion && _cacheRegion !== slug) {
    SESSION_CACHE.clear();
    _fetchCount = 0;
  }
  _cacheRegion = slug;

  if (SESSION_CACHE.has(comunaId)) return SESSION_CACHE.get(comunaId);

  _fetchCount++;
  const total = region.context().comunas.length;
  logger.info(`[BCN/${slug}] (${_fetchCount}/${total}) descargando ${comunaId}...`);

  const url = urlFor(comunaId);
  const res = await fetchWithRetry(url, {}, 3, 'bcn');

  let payload;
  if (!res.ok) {
    payload = { ok: false, comunaId, url, reason: res.reason || `HTTP ${res.status}`, tables: [] };
    logger.warn(`[BCN] ${comunaId} fallo: ${payload.reason}`);
  } else {
    const html = res.body;
    const fingerprint = detectStructuralChange(`bcn-v2:${comunaId}`, html);
    if (fingerprint.changed) {
      logger.warn(`[BCN] Cambio estructural detectado en ${comunaId}. Hash: ${fingerprint.hash}`);
    }
    const tables = parseAllTables(html);
    payload = { ok: true, comunaId, url, fingerprint, tables, htmlLength: html.length };
  }

  SESSION_CACHE.set(comunaId, payload);
  return payload;
}

function clearCache() {
  SESSION_CACHE.clear();
}

module.exports = {
  BCN_YEAR,
  deisFor,
  urlFor,
  fetchComuna,
  parseAllTables,
  findRow,
  readValue,
  stripTags,
  clearCache
};
