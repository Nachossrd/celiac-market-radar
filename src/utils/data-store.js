const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const SCRAPED_DIR = path.join(__dirname, '../../data/scraped');

if (!fs.existsSync(SCRAPED_DIR)) {
  fs.mkdirSync(SCRAPED_DIR, { recursive: true });
}

/**
 * DataStore HONESTO:
 * - Nunca inventa datos
 * - Registra exactamente qué se scrapeó, cuándo, y cuántos resultados
 * - Si un scraper devuelve 0, guarda 0 (no rellena con seed)
 */
class DataStore {
  static save(source, data, meta = {}) {
    const filePath = path.join(SCRAPED_DIR, `${source}.json`);

    const itemCount = Array.isArray(data)
      ? data.length
      : (data && typeof data === 'object' ? Object.keys(data).length : 0);

    const record = {
      source,
      scrapedAt: new Date().toISOString(),
      itemCount,
      success: meta.success !== undefined ? meta.success : true,
      errors: meta.errors || [],
      durationMs: meta.durationMs || 0,
      ...(meta.captchaDetected !== undefined && { captchaDetected: meta.captchaDetected }),
      ...(meta.searchesCompleted !== undefined && { searchesCompleted: meta.searchesCompleted }),
      ...(meta.placesAttempted !== undefined && { placesAttempted: meta.placesAttempted }),
      data
    };

    fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
    logger.info(`[DataStore] Guardado ${source}: ${itemCount} items`);
    return record;
  }

  static load(source) {
    const filePath = path.join(SCRAPED_DIR, `${source}.json`);
    if (!fs.existsSync(filePath)) {
      return { source, scrapedAt: null, itemCount: 0, data: [], errors: [], neverRun: true };
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  static exists(source) {
    return fs.existsSync(path.join(SCRAPED_DIR, `${source}.json`));
  }

  static getStatus() {
    const sources = [
      'jumbo', 'lider', 'mercadolibre', 'google-maps',
      'google-trends', 'rappi', 'reviews'
    ];

    const status = {};
    for (const src of sources) {
      const record = this.load(src);
      status[src] = {
        lastRun: record.scrapedAt || 'Nunca',
        items: record.itemCount || 0,
        success: record.success !== undefined ? record.success : false,
        errors: (record.errors || []).length
      };
    }
    return status;
  }

  static printStatus() {
    const status = this.getStatus();
    console.log('\n+--------------------------------------------------+');
    console.log('|      ESTADO REAL DE DATOS SCRAPEADOS             |');
    console.log('+--------------------------------------------------+');
    for (const [src, info] of Object.entries(status)) {
      const icon = info.items > 0 ? '[OK]' : info.lastRun === 'Nunca' ? '[--]' : '[XX]';
      const when = info.lastRun === 'Nunca' ? 'Nunca ejecutado' : info.lastRun.slice(0, 19);
      console.log(`| ${icon} ${src.padEnd(16)} | ${String(info.items).padStart(4)} items | ${when.padEnd(19)} |`);
    }
    console.log('+--------------------------------------------------+\n');
  }
}

module.exports = DataStore;
