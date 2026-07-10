require('dotenv').config();
const fetch = require('node-fetch');
const logger = require('../utils/logger');
const DataStore = require('../utils/data-store');
const limiters = require('../utils/rate-limiter');

/**
 * Scraper REAL de Lider.cl (Walmart Chile)
 * Usa su API BFF (Backend For Frontend) que sirve a la web pública.
 */

const LIDER_SEARCH_URL = 'https://www.lider.cl/catalogo/bff/category';

const QUERIES = [
  'sin gluten',
  'libre de gluten',
  'celiaco',
  'pan sin gluten'
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'es-CL,es;q=0.9',
  'Content-Type': 'application/json',
  'Referer': 'https://www.lider.cl/catalogo',
  'Origin': 'https://www.lider.cl',
  'x-channel': 'SOD'
};

async function scrapeLider() {
  const startTime = Date.now();
  const allProducts = [];
  const errors = [];
  const seen = new Set();

  logger.info('[Lider] Iniciando scraping via BFF API...');

  for (const query of QUERIES) {
    try {
      const payload = {
        keyword: query,
        page: 1,
        facets: [],
        sortBy: '',
        hitsPerPage: 40
      };

      let data;
      const response = await limiters.supermercado.schedule(() =>
        fetch(LIDER_SEARCH_URL, {
          method: 'POST',
          headers: HEADERS,
          body: JSON.stringify(payload),
          timeout: 15000
        })
      );

      if (!response.ok) {
        const altUrl = `https://www.lider.cl/catalogo/bff/search?keyword=${encodeURIComponent(query)}&page=1&hitsPerPage=40`;
        const altResponse = await fetch(altUrl, { headers: HEADERS, timeout: 15000 });

        if (!altResponse.ok) {
          const errMsg = `HTTP ${response.status} / ALT ${altResponse.status} para "${query}"`;
          logger.warn(`[Lider] ${errMsg}`);
          errors.push(errMsg);
          continue;
        }

        data = await altResponse.json();
      } else {
        data = await response.json();
      }

      const products = data.products || data.hits || [];

      if (!Array.isArray(products)) {
        errors.push(`Formato inesperado para "${query}": ${JSON.stringify(data).slice(0, 200)}`);
        continue;
      }

      for (const product of products) {
        const id = product.productId || product.sku || product.displayName;
        if (seen.has(id)) continue;
        seen.add(id);

        const precio = product.price?.BasePriceSales ||
          product.price?.BasePriceReference ||
          product.prices?.normal ||
          product.prices?.sale ||
          null;

        if (precio === null) continue;

        allProducts.push({
          id: product.productId || product.sku,
          nombre: product.displayName || `${product.brand || ''} ${product.description || ''}`.trim(),
          marca: product.brand || 'Sin marca',
          precio,
          precioOferta: product.price?.BasePriceSales || product.prices?.sale || precio,
          disponible: product.available !== false,
          categoria: product.category || '',
          imagen: product.images?.defaultImage || product.imageUrl || null,
          url: product.url ? `https://www.lider.cl${product.url}` : null,
          peso: product.netContent || '',
          query,
          fuente: 'lider'
        });
      }

      logger.info(`[Lider] Query "${query}": ${products.length} raw -> ${allProducts.length} unicos acumulados`);

    } catch (error) {
      const errMsg = `Error en query "${query}": ${error.message}`;
      logger.error(`[Lider] ${errMsg}`);
      errors.push(errMsg);
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`[Lider] Completado: ${allProducts.length} productos en ${duration}ms (${errors.length} errores)`);

  DataStore.save('lider', allProducts, {
    success: allProducts.length > 0,
    errors,
    durationMs: duration
  });

  return allProducts;
}

module.exports = { run: scrapeLider };
