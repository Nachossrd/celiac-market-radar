require('dotenv').config();
const googleTrends = require('google-trends-api');
const logger = require('../utils/logger');
const DataStore = require('../utils/data-store');

/**
 * Google Trends REAL usando el paquete google-trends-api.
 * Hace requests reales a Google Trends y parsea las respuestas.
 * Si Google cambia su estructura, el paquete falla (y lo verás en logs).
 */

const QUERIES = [
  { keyword: 'celiaco', category: 'diagnostico' },
  { keyword: 'sin gluten', category: 'general' },
  { keyword: 'pan sin gluten', category: 'consumo' },
  { keyword: 'pasteleria sin gluten', category: 'consumo' },
  { keyword: 'intolerancia al gluten', category: 'diagnostico' },
  { keyword: 'dieta sin gluten', category: 'estilo_vida' },
  { keyword: 'dilici', category: 'marca' },
  { keyword: 'sersayaan', category: 'marca' }
];

async function scrapeTrends() {
  const startTime = Date.now();
  const results = [];
  const errors = [];

  // Construye geo dinamico segun region activa: CL = nacional, CL-XX = region.
  const region = require('../context/region-engine').context();
  const ISO_BY_CODIGO = {
    '02': 'AN', '04': 'CO', '05': 'VS', '06': 'LI', '07': 'ML', '08': 'BI',
    '09': 'AR', '10': 'LL', '11': 'AI', '12': 'MA', '13': 'RM', '14': 'LR',
    '15': 'AP', '16': 'NB'
  };
  const geo = ISO_BY_CODIGO[region.codigoRegion]
    ? `CL-${ISO_BY_CODIGO[region.codigoRegion]}`
    : 'CL';
  const storeKey = `google-trends-${region.slug}`;
  logger.info(`[GoogleTrends] Region: ${region.nombre} (geo=${geo}) -> store ${storeKey}`);

  for (const { keyword, category } of QUERIES) {
    try {
      const interestRaw = await googleTrends.interestOverTime({
        keyword,
        startTime: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
        endTime: new Date(),
        geo,
        hl: 'es'
      });

      const interestData = JSON.parse(interestRaw);
      const timelineData = interestData.default?.timelineData || [];

      let regionData = [];
      try {
        const regionRaw = await googleTrends.interestByRegion({
          keyword,
          startTime: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
          endTime: new Date(),
          geo,
          resolution: 'CITY',
          hl: 'es'
        });
        const regionParsed = JSON.parse(regionRaw);
        regionData = regionParsed.default?.geoMapData || [];
      } catch (regionErr) {
        logger.warn(`[GoogleTrends] Sin datos regionales para "${keyword}": ${regionErr.message}`);
      }

      let relatedQueries = [];
      try {
        const relatedRaw = await googleTrends.relatedQueries({
          keyword,
          startTime: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
          endTime: new Date(),
          geo,
          hl: 'es'
        });
        const relatedParsed = JSON.parse(relatedRaw);
        relatedQueries = relatedParsed.default?.rankedList?.[0]?.rankedKeyword || [];
      } catch (relErr) {
        logger.warn(`[GoogleTrends] Sin queries relacionadas para "${keyword}"`);
      }

      const entry = {
        keyword,
        category,
        timeline: timelineData.map(point => ({
          date: point.formattedAxisTime || point.time,
          value: point.value?.[0] || 0,
          formattedValue: point.formattedValue?.[0] || '0'
        })),
        averageInterest: timelineData.length > 0
          ? Math.round(timelineData.reduce((sum, p) => sum + (p.value?.[0] || 0), 0) / timelineData.length)
          : 0,
        peakInterest: timelineData.length > 0
          ? Math.max(...timelineData.map(p => p.value?.[0] || 0))
          : 0,
        regions: regionData.map(r => ({
          name: r.geoName,
          value: r.value?.[0] || 0
        })).filter(r => r.value > 0),
        relatedQueries: relatedQueries.slice(0, 10).map(q => ({
          query: q.query,
          value: q.value
        }))
      };

      results.push(entry);
      logger.info(`[GoogleTrends] "${keyword}": avg=${entry.averageInterest}, peak=${entry.peakInterest}, ${entry.timeline.length} puntos temporales`);

      await new Promise(r => setTimeout(r, 2000));

    } catch (error) {
      const errMsg = `Error para "${keyword}": ${error.message}`;
      logger.error(`[GoogleTrends] ${errMsg}`);
      errors.push(errMsg);

      if (error.message.includes('429') || error.message.includes('rate')) {
        logger.warn('[GoogleTrends] Rate limited. Esperando 30s...');
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  }

  const comparison = results
    .filter(r => r.averageInterest > 0)
    .sort((a, b) => b.averageInterest - a.averageInterest)
    .map(r => ({ keyword: r.keyword, category: r.category, avgInterest: r.averageInterest }));

  const duration = Date.now() - startTime;
  logger.info(`[GoogleTrends] Completado: ${results.length} queries, ${errors.length} errores, ${duration}ms`);

  DataStore.save(storeKey, { region: region.slug, geo, queries: results, comparison }, {
    success: results.some(r => r.timeline.length > 0),
    errors,
    durationMs: duration
  });

  return results;
}

module.exports = { run: scrapeTrends };
