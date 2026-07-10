require('dotenv').config();
const puppeteer = require('puppeteer');
const logger = require('../utils/logger');
const DataStore = require('../utils/data-store');
const region = require('../context/region-engine');

/**
 * Scraper de Google Maps con Puppeteer.
 *
 * LIMITACIONES REALES:
 * - Google muestra CAPTCHA después de ~10-15 búsquedas desde la misma IP
 * - Los selectores CSS cambian frecuentemente
 * - Sin proxies residenciales, funciona para ~5-10 comunas antes de bloqueo
 *
 * ESTRATEGIA:
 * - Delay largo (8-10s entre búsquedas)
 * - Máximo 10 búsquedas por sesión
 * - Detectar CAPTCHA y parar inmediatamente
 * - Guardar lo que se pudo obtener (no inventar)
 */

const SEARCHES = [
  'panaderia sin gluten',
  'pasteleria sin gluten',
  'tienda celiacos',
  'productos sin gluten'
];

/**
 * Selecciona las comunas prioritarias de la region activa: top N por poblacion.
 * Esto evita que Maps busque "panaderia sin gluten Vitacura" cuando la region
 * activa es Valparaiso.
 */
function topComunasOfRegion(n = 10) {
  return region.context().comunas
    .slice()
    .sort((a, b) => (b.poblacion || 0) - (a.poblacion || 0))
    .slice(0, n)
    .map(c => c.nombre);
}

async function scrapeGoogleMaps(comunas, maxSearches = 10) {
  const ctx = region.context();
  if (!comunas) comunas = topComunasOfRegion(maxSearches);
  const storeKey = `google-maps-${ctx.slug}`;
  const startTime = Date.now();
  const allPlaces = [];
  const errors = [];
  const seen = new Set();
  let captchaDetected = false;
  let searchCount = 0;

  logger.info(`[GoogleMaps] Iniciando con ${comunas.length} comunas, max ${maxSearches} busquedas`);

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
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'es-CL,es;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  for (const comuna of comunas) {
    if (captchaDetected || searchCount >= maxSearches) break;

    for (const searchTerm of SEARCHES) {
      if (captchaDetected || searchCount >= maxSearches) break;

      const query = `${searchTerm} ${comuna} Santiago Chile`;
      logger.info(`[GoogleMaps] Buscando: "${query}" (${searchCount + 1}/${maxSearches})`);

      try {
        const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        const hasCaptcha = await page.evaluate(() => {
          return document.body.innerText.includes('unusual traffic') ||
            document.body.innerText.includes('not a robot') ||
            document.querySelector('#captcha-form') !== null ||
            document.querySelector('iframe[src*="recaptcha"]') !== null;
        });

        if (hasCaptcha) {
          captchaDetected = true;
          logger.warn('[GoogleMaps] CAPTCHA DETECTADO - Deteniendo scraping');
          errors.push(`CAPTCHA detectado después de ${searchCount} búsquedas`);
          break;
        }

        const feedLoaded = await page.waitForSelector('div[role="feed"]', { timeout: 8000 })
          .then(() => true)
          .catch(() => false);

        if (!feedLoaded) {
          const noResults = await page.evaluate(() => {
            return document.body.innerText.includes('No hay resultados') ||
              document.body.innerText.includes('No results');
          });
          if (noResults) {
            logger.info(`[GoogleMaps]   Sin resultados para "${query}"`);
          } else {
            logger.warn(`[GoogleMaps]   Feed no cargo para "${query}" - posible cambio de layout`);
            errors.push(`Feed no cargó: "${query}"`);
          }
          searchCount++;
          await delay(8000);
          continue;
        }

        await scrollFeed(page);

        const places = await page.evaluate(() => {
          const results = [];
          const items = document.querySelectorAll('div[role="feed"] > div > div > a[href*="/maps/place"]');

          items.forEach(item => {
            const container = item.closest('div[jsaction]') || item.parentElement?.parentElement;
            if (!container) return;

            const nameEl = container.querySelector('.fontHeadlineSmall') ||
              container.querySelector('[class*="qBF1Pd"]') ||
              container.querySelector('div.NrDZNb') ||
              item.getAttribute('aria-label');

            const name = typeof nameEl === 'string' ? nameEl :
              (nameEl ? nameEl.textContent.trim() : null);

            if (!name) return;

            const ratingEl = container.querySelector('span[role="img"]');
            const ratingText = ratingEl ? ratingEl.getAttribute('aria-label') : '';
            const ratingMatch = ratingText ? ratingText.match(/([\d,\.]+)/) : null;
            const rating = ratingMatch ? parseFloat(ratingMatch[1].replace(',', '.')) : null;

            const reviewsEl = container.querySelector('span[style*="color"] + span') ||
              container.querySelector('.UY7F9');
            let reviews = 0;
            if (reviewsEl) {
              const revMatch = reviewsEl.textContent.match(/\d+/);
              reviews = revMatch ? parseInt(revMatch[0]) : 0;
            }

            const infoLines = container.querySelectorAll('.W4Efsd');
            let address = '';
            let category = '';
            infoLines.forEach((line, idx) => {
              const text = line.textContent.trim();
              if (idx === 0 && text.includes('·')) {
                const parts = text.split('·');
                category = parts[0]?.trim() || '';
              }
              if (text.match(/\d/) && (text.includes('Av') || text.includes('Calle') || text.includes(',') || text.includes('#'))) {
                address = text;
              }
            });

            const placeUrl = item.href || '';

            results.push({ name, rating, reviews, address, category, placeUrl });
          });

          return results;
        });

        for (const place of places) {
          const key = place.name.toLowerCase().trim();
          if (seen.has(key)) continue;
          seen.add(key);

          allPlaces.push({
            ...place,
            comuna,
            searchQuery: searchTerm,
            scrapedAt: new Date().toISOString()
          });
        }

        logger.info(`[GoogleMaps]   Encontrados: ${places.length} (${allPlaces.length} unicos total)`);
        searchCount++;

        await delay(parseInt(process.env.DELAY_GOOGLE_MS) || 8000);

      } catch (error) {
        const errMsg = `Error "${query}": ${error.message}`;
        logger.error(`[GoogleMaps] ${errMsg}`);
        errors.push(errMsg);
        searchCount++;
        await delay(5000);
      }
    }
  }

  await browser.close();

  const duration = Date.now() - startTime;
  logger.info(`[GoogleMaps] Completado: ${allPlaces.length} locales, ${searchCount} busquedas, ${errors.length} errores, CAPTCHA=${captchaDetected}`);

  DataStore.save(storeKey, allPlaces, {
    success: allPlaces.length > 0,
    errors,
    durationMs: duration,
    captchaDetected,
    searchesCompleted: searchCount
  });

  return allPlaces;
}

async function scrollFeed(page) {
  try {
    const scrollable = await page.$('div[role="feed"]');
    if (!scrollable) return;

    for (let i = 0; i < 3; i++) {
      await page.evaluate((el) => { el.scrollTop += 800; }, scrollable);
      await delay(1500);
    }
  } catch (e) { /* ignored */ }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { run: scrapeGoogleMaps };
