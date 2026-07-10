require('dotenv').config();
const puppeteer = require('puppeteer');
const logger = require('../utils/logger');
const DataStore = require('../utils/data-store');
const region = require('../context/region-engine');

/**
 * Scraper de Reviews de Google Maps.
 * LIMITACIÓN SEVERA:
 * - Solo funciona para ~3-5 locales antes de CAPTCHA
 * - Si no obtiene reviews, guarda 0 (no inventa texto)
 *
 * Uso: lee URLs desde data/scraped/google-maps.json (debes haberlo ejecutado antes).
 */

async function scrapeReviews(placeUrls = []) {
  const slug = region.context().slug;
  const mapsKey = `google-maps-${slug}`;
  const storeKey = `reviews-${slug}`;
  if (placeUrls.length === 0) {
    const mapsData = DataStore.load(mapsKey);
    if (mapsData.data && Array.isArray(mapsData.data)) {
      placeUrls = mapsData.data
        .filter(p => p.placeUrl && p.placeUrl.includes('/maps/place/'))
        .slice(0, 5)
        .map(p => ({ url: p.placeUrl, name: p.name, comuna: p.comuna }));
    }

    if (placeUrls.length === 0) {
      logger.warn(`[Reviews/${slug}] No hay URLs. Ejecuta google-maps primero.`);
      DataStore.save(storeKey, [], {
        success: false,
        errors: [`No hay URLs disponibles para ${slug}. Ejecutar google-maps primero.`]
      });
      return [];
    }
  }

  const startTime = Date.now();
  const allReviews = [];
  const errors = [];
  let captchaDetected = false;

  logger.info(`[Reviews] Scraping reviews de ${placeUrls.length} locales (max recomendado: 5)`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  for (const place of placeUrls) {
    if (captchaDetected) break;

    const placeUrl = typeof place === 'string' ? place : place.url;
    const placeName = typeof place === 'string' ? 'Desconocido' : place.name;

    logger.info(`[Reviews] Procesando: ${placeName}`);

    try {
      await page.goto(placeUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await delay(3000);

      const hasCaptcha = await page.evaluate(() => {
        return document.body.innerText.includes('unusual traffic') ||
          document.querySelector('iframe[src*="recaptcha"]') !== null;
      });

      if (hasCaptcha) {
        captchaDetected = true;
        errors.push('CAPTCHA detectado');
        logger.warn('[Reviews] CAPTCHA - Deteniendo');
        break;
      }

      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button[role="tab"]'));
        const reviewBtn = buttons.find(b => b.textContent.match(/reseñas|reviews|opiniones/i));
        if (reviewBtn) reviewBtn.click();
      });
      await delay(2000);

      await page.evaluate(() => {
        const scrollable = document.querySelector('.m6QErb.DxyBCb.kA9KIf.dS8AEf');
        if (scrollable) {
          for (let i = 0; i < 3; i++) scrollable.scrollTop += 500;
        }
      });
      await delay(2000);

      await page.evaluate(() => {
        document.querySelectorAll('button[aria-label*="Más"], button.w8nwRe').forEach(b => b.click());
      });
      await delay(1000);

      const reviews = await page.evaluate((pName) => {
        const reviewEls = document.querySelectorAll('[data-review-id]');
        const els = reviewEls.length > 0 ? reviewEls : document.querySelectorAll('.jftiEf');

        return Array.from(els).map(el => {
          const textEl = el.querySelector('.wiI7pd') || el.querySelector('[class*="review-full-text"]');
          const text = textEl ? textEl.textContent.trim() : '';

          const starsEl = el.querySelector('[role="img"][aria-label]');
          const starsLabel = starsEl ? starsEl.getAttribute('aria-label') : '';
          const starsMatch = starsLabel.match(/(\d)/);
          const rating = starsMatch ? parseInt(starsMatch[1]) : null;

          const dateEl = el.querySelector('.rsqaWe');
          const date = dateEl ? dateEl.textContent.trim() : '';

          const nameEl = el.querySelector('.d4r55');
          const reviewerName = nameEl ? nameEl.textContent.trim() : '';

          return { text, rating, date, reviewerName, place: pName };
        }).filter(r => r.text.length > 5);
      }, placeName);

      for (const review of reviews) {
        review.placeUrl = placeUrl;
        review.comuna = typeof place === 'object' ? place.comuna : '';
        review.scrapedAt = new Date().toISOString();
        allReviews.push(review);
      }

      logger.info(`[Reviews]   ${placeName}: ${reviews.length} reviews extraidas`);

      await delay(parseInt(process.env.DELAY_GOOGLE_MS) || 8000);

    } catch (error) {
      const errMsg = `Error en ${placeName}: ${error.message}`;
      logger.error(`[Reviews] ${errMsg}`);
      errors.push(errMsg);
      await delay(5000);
    }
  }

  await browser.close();

  const duration = Date.now() - startTime;
  logger.info(`[Reviews] Completado: ${allReviews.length} reviews de ${placeUrls.length} locales, CAPTCHA=${captchaDetected}`);

  DataStore.save(storeKey, allReviews, {
    success: allReviews.length > 0,
    errors,
    durationMs: duration,
    captchaDetected,
    placesAttempted: placeUrls.length
  });

  return allReviews;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { run: scrapeReviews };
