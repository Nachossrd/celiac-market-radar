require('dotenv').config();
const fetch = require('node-fetch');
const logger = require('../utils/logger');
const DataStore = require('../utils/data-store');
const limiters = require('../utils/rate-limiter');

/**
 * Scraper de Rappi Chile.
 * Usa endpoints de la API web pública (los que carga la SPA).
 * NOTA: Rappi puede bloquear sin auth. Si falla, se registra honestamente.
 */

const RAPPI_API = 'https://services.rappi.cl/api/web-gateway/web/stores-router/search/products';

const QUERIES = [
  'sin gluten',
  'pan sin gluten',
  'pastel sin gluten',
  'celiaco'
];

const SANTIAGO_LAT = -33.4489;
const SANTIAGO_LNG = -70.6693;

async function scrapeRappi() {
  const startTime = Date.now();
  const allProducts = [];
  const errors = [];
  const seen = new Set();

  logger.info('[Rappi] Iniciando scraping...');

  for (const query of QUERIES) {
    try {
      let data;
      const response = await limiters.rappi.schedule(() =>
        fetch(RAPPI_API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'es-CL,es;q=0.9',
            'Origin': 'https://www.rappi.cl',
            'Referer': 'https://www.rappi.cl/',
            'app-version': 'web'
          },
          body: JSON.stringify({
            lat: SANTIAGO_LAT,
            lng: SANTIAGO_LNG,
            query,
            options: { next_cursor: '' }
          }),
          timeout: 15000
        })
      );

      if (!response.ok) {
        const altUrl = `https://services.rappi.cl/api/web-gateway/web/dynamic/context/content/search_results?query=${encodeURIComponent(query)}&lat=${SANTIAGO_LAT}&lng=${SANTIAGO_LNG}`;

        const altResponse = await fetch(altUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
          },
          timeout: 15000
        });

        if (!altResponse.ok) {
          const errMsg = `HTTP ${response.status} / ALT ${altResponse.status} para "${query}" - Rappi posiblemente requiere auth`;
          logger.warn(`[Rappi] ${errMsg}`);
          errors.push(errMsg);
          continue;
        }

        data = await altResponse.json();
      } else {
        data = await response.json();
      }

      const products = extractRappiProducts(data);

      for (const product of products) {
        const key = `${product.nombre}-${product.tienda}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        product.query = query;
        product.fuente = 'rappi';
        product.scrapedAt = new Date().toISOString();
        allProducts.push(product);
      }

      logger.info(`[Rappi] Query "${query}": ${products.length} productos`);

    } catch (error) {
      const errMsg = `Error "${query}": ${error.message}`;
      logger.error(`[Rappi] ${errMsg}`);
      errors.push(errMsg);
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`[Rappi] Completado: ${allProducts.length} productos, ${errors.length} errores, ${duration}ms`);

  DataStore.save('rappi', allProducts, {
    success: allProducts.length > 0,
    errors,
    durationMs: duration
  });

  return allProducts;
}

function extractRappiProducts(data) {
  const products = [];

  if (data.products && Array.isArray(data.products)) {
    for (const p of data.products) {
      products.push({
        nombre: p.name || p.product_name,
        precio: p.price || p.real_price,
        precioOriginal: p.real_price || p.price,
        tienda: p.store_name || p.store?.name || '',
        imagen: p.image || p.product_image,
        disponible: p.in_stock !== false
      });
    }
  }

  if (data.components && Array.isArray(data.components)) {
    for (const comp of data.components) {
      const items = comp.resource?.products || comp.products || [];
      for (const p of items) {
        products.push({
          nombre: p.name || p.product_name || '',
          precio: p.price || p.real_price || 0,
          precioOriginal: p.real_price || p.price || 0,
          tienda: p.store_name || '',
          imagen: p.image || '',
          disponible: true
        });
      }
    }
  }

  if (Array.isArray(data)) {
    for (const p of data) {
      if (p.name || p.product_name) {
        products.push({
          nombre: p.name || p.product_name,
          precio: p.price || 0,
          precioOriginal: p.real_price || p.price || 0,
          tienda: p.store_name || '',
          imagen: p.image || '',
          disponible: true
        });
      }
    }
  }

  return products.filter(p => p.nombre && p.precio > 0);
}

module.exports = { run: scrapeRappi };
