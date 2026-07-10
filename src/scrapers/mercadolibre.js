require('dotenv').config();
const puppeteer = require('puppeteer');
const logger = require('../utils/logger');
const DataStore = require('../utils/data-store');

/**
 * Scraper REAL de MercadoLibre Chile.
 *
 * Historia: la API publica `api.mercadolibre.com/sites/MLC/search` ahora exige
 * token OAuth (devuelve 403 sin auth). La pagina HTML de listado.mercadolibre.cl
 * esta protegida por un challenge JavaScript (PoW SHA-256, sistema Akamai/Anubis):
 * sin ejecutar JS solo se obtiene 7KB de bootstrap, no productos.
 *
 * Solucion: Puppeteer ejecuta el challenge automaticamente al cargar la pagina.
 * Tras pasarlo, se setea cookie `_bm_skipml=true` que dura ~5 min y permite
 * navegar mas queries en la misma sesion sin re-resolver el challenge.
 *
 * Si MercadoLibre cambia su markup, los selectores devuelven 0 y se guarda 0.
 */

const QUERIES = [
  'pan-sin-gluten',
  'pan-celiaco',
  'torta-sin-gluten',
  'pastel-sin-gluten',
  'galletas-sin-gluten',
  'harina-sin-gluten',
  'premezcla-sin-gluten'
];

async function scrapeMercadoLibre() {
  const startTime = Date.now();
  const allProducts = [];
  const errors = [];
  const seen = new Set();

  logger.info('[MercadoLibre] Iniciando scraping con Puppeteer (resolviendo challenge JS)...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-CL,es;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  for (const slug of QUERIES) {
    try {
      const url = `https://listado.mercadolibre.cl/${slug}`;
      logger.info(`[MercadoLibre] Navegando a ${url}`);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // El challenge se resuelve solo y luego redirige a la pagina real.
      // Esperamos a que aparezcan productos (o un timeout corto).
      const ready = await page.waitForSelector(
        '.ui-search-layout__item, li.ui-search-layout__item, .poly-component__title, .poly-card',
        { timeout: 30000 }
      ).then(() => true).catch(() => false);

      if (!ready) {
        const stillChallenge = await page.evaluate(() =>
          document.body.innerText.includes('JavaScript') ||
          document.body.innerText.includes('Continuando')
        );
        const errMsg = stillChallenge
          ? `Challenge no resuelto para "${slug}"`
          : `Sin productos visibles para "${slug}" (posible cambio de markup)`;
        logger.warn(`[MercadoLibre] ${errMsg}`);
        errors.push(errMsg);
        continue;
      }

      await new Promise(r => setTimeout(r, 1500));

      const products = await page.evaluate(() => {
        const results = [];
        // ML usa varios layouts (poly-card moderno + ui-search-layout legacy)
        const cards = document.querySelectorAll(
          'li.ui-search-layout__item, .poly-card, .ui-search-layout__item'
        );

        cards.forEach(card => {
          const titleEl = card.querySelector('.poly-component__title, h2.ui-search-item__title, .ui-search-item__title');
          const linkEl  = card.querySelector('a.poly-component__title, a.ui-search-link, a.poly-card__content-link, a[href*="MLC-"], a[href*="/MLC-"]');
          const priceFractionEl = card.querySelector('.andes-money-amount__fraction, .price-tag-fraction');
          const priceCurrencyEl = card.querySelector('.andes-money-amount__currency-symbol');
          const sellerEl = card.querySelector('.poly-component__seller, .ui-search-official-store-label');
          const shippingEl = card.querySelector('.poly-component__shipping, .ui-search-item__shipping');
          const imgEl = card.querySelector('img.poly-component__picture, img.ui-search-result-image__element');

          const title = titleEl ? titleEl.textContent.trim() : '';
          if (!title) return;

          const priceText = priceFractionEl ? priceFractionEl.textContent.replace(/\./g, '') : '';
          const price = priceText ? parseInt(priceText, 10) : null;

          results.push({
            title,
            price,
            currency: priceCurrencyEl ? priceCurrencyEl.textContent.trim() : 'CLP',
            url: linkEl ? linkEl.href : '',
            seller: sellerEl ? sellerEl.textContent.trim() : null,
            shipping: shippingEl ? shippingEl.textContent.trim() : null,
            image: imgEl ? (imgEl.dataset?.src || imgEl.src) : null
          });
        });

        return results;
      });

      for (const p of products) {
        const id = p.url || `${p.title}-${p.price}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (p.price === null || p.price <= 0) continue;

        allProducts.push({
          id,
          nombre: p.title,
          precio: p.price,
          moneda: p.currency,
          vendedor: p.seller,
          envio: p.shipping,
          imagen: p.image,
          url: p.url,
          query: slug,
          fuente: 'mercadolibre',
          scrapedAt: new Date().toISOString()
        });
      }

      logger.info(`[MercadoLibre] "${slug}": ${products.length} extraidos -> ${allProducts.length} unicos acumulados`);

      await new Promise(r => setTimeout(r, parseInt(process.env.DELAY_MERCADOLIBRE_MS) || 3000));

    } catch (error) {
      const errMsg = `Error en "${slug}": ${error.message}`;
      logger.error(`[MercadoLibre] ${errMsg}`);
      errors.push(errMsg);
    }
  }

  await browser.close();

  const duration = Date.now() - startTime;
  logger.info(`[MercadoLibre] Completado: ${allProducts.length} productos en ${duration}ms (${errors.length} errores)`);

  DataStore.save('mercadolibre', allProducts, {
    success: allProducts.length > 0,
    errors,
    durationMs: duration
  });

  return allProducts;
}

module.exports = { run: scrapeMercadoLibre };
