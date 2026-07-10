require('dotenv').config();
const fetch = require('node-fetch');
const logger = require('../utils/logger');
const DataStore = require('../utils/data-store');
const limiters = require('../utils/rate-limiter');

/**
 * Scraper REAL de Jumbo.cl (post-migracion 2024 fuera de VTEX).
 *
 * Jumbo migro de la API VTEX (que ahora devuelve HTTP 410) a una plataforma
 * propia bajo ecomm.cencosud.com. La forma estable de obtener productos hoy
 * es scrapear el HTML de la pagina de busqueda y extraer el JSON inline que
 * React Query deshidrata en `<script id="__REACT_QUERY_STATE__">`.
 *
 * Endpoint usado: https://www.jumbo.cl/busqueda?ft=<query>
 * Datos en: data.dehydratedState.queries[0].state.data.products
 *
 * Si Jumbo cambia su sitio nuevamente, el regex no encontrara el script y
 * el scraper guardara 0 productos (no inventa nada).
 */

const QUERIES = [
  'sin gluten',
  'libre de gluten',
  'celiaco',
  'gluten free'
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-CL,es;q=0.9'
};

function extractProducts(html) {
  const m = html.match(/<script type="application\/json" id="__REACT_QUERY_STATE__">([\s\S]*?)<\/script>/);
  if (!m) return { products: [], reason: 'no-react-query-state' };

  let parsed;
  try {
    parsed = JSON.parse(m[1]);
  } catch (e) {
    return { products: [], reason: `parse-fail: ${e.message}` };
  }

  const queries = parsed.dehydratedState?.queries || [];
  for (const q of queries) {
    const products = q.state?.data?.products;
    if (Array.isArray(products) && products.length) {
      return { products, reason: 'ok' };
    }
  }
  return { products: [], reason: 'no-products-in-queries' };
}

function normalizeProduct(p, query) {
  const item = (p.items && p.items[0]) || {};
  return {
    id: p.productId || item.skuId,
    nombre: item.name || p.name || `${p.brand || ''} ${p.reference || ''}`.trim(),
    marca: p.brand || 'Sin marca',
    precio: item.listPrice ?? item.price ?? null,
    precioOferta: item.price ?? item.listPrice ?? null,
    ppumPrice: item.ppumPrice ?? null,
    ppumUnidad: item.ppumMeasurementUnit ?? null,
    disponible: item.stock !== false,
    categoria: (p.categoryNames || []).join(' > '),
    imagen: (item.images && item.images[0]) || null,
    url: p.slug ? `https://www.jumbo.cl/${p.slug}/p` : null,
    soldBy: p.soldBy || null,
    isMarketplace: !!p.isMarketplace,
    query,
    fuente: 'jumbo'
  };
}

async function scrapeJumbo() {
  const startTime = Date.now();
  const allProducts = [];
  const errors = [];
  const seen = new Set();

  logger.info('[Jumbo] Iniciando scraping via HTML + __REACT_QUERY_STATE__...');

  for (const query of QUERIES) {
    try {
      const url = `https://www.jumbo.cl/busqueda?ft=${encodeURIComponent(query)}`;

      const response = await limiters.supermercado.schedule(() =>
        fetch(url, { headers: HEADERS, timeout: 20000, redirect: 'follow' })
      );

      if (!response.ok) {
        const errMsg = `HTTP ${response.status} para "${query}"`;
        logger.warn(`[Jumbo] ${errMsg}`);
        errors.push(errMsg);
        continue;
      }

      const html = await response.text();
      const { products, reason } = extractProducts(html);

      if (products.length === 0) {
        const errMsg = `Sin productos en "${query}" (motivo: ${reason})`;
        logger.warn(`[Jumbo] ${errMsg}`);
        errors.push(errMsg);
        continue;
      }

      for (const p of products) {
        const id = p.productId || p.reference;
        if (seen.has(id)) continue;
        seen.add(id);
        const normalized = normalizeProduct(p, query);
        if (normalized.precio === null && normalized.precioOferta === null) continue;
        allProducts.push(normalized);
      }

      logger.info(`[Jumbo] Query "${query}": ${products.length} extraidos -> ${allProducts.length} unicos acumulados`);

    } catch (error) {
      const errMsg = `Error en query "${query}": ${error.message}`;
      logger.error(`[Jumbo] ${errMsg}`);
      errors.push(errMsg);
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`[Jumbo] Completado: ${allProducts.length} productos en ${duration}ms (${errors.length} errores)`);

  DataStore.save('jumbo', allProducts, {
    success: allProducts.length > 0,
    errors,
    durationMs: duration
  });

  return allProducts;
}

module.exports = { run: scrapeJumbo };
