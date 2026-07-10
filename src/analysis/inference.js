const DataStore = require('../utils/data-store');
const { PopulationModel } = require('./population');
const { MobilityModel } = require('./mobility');
const logger = require('../utils/logger');

/**
 * Motor de inferencia HONESTO.
 *
 * Regla de oro: si una fuente devolvio 0 items, el reporte refleja 0.
 * No hay fallback a constantes inventadas. Cada KPI lleva un campo
 * `confianza` indicando cuantos datos lo sustentan.
 */

function computePriceStats(products, categoryFilter) {
  const filtered = products.filter(p => {
    if (!p.precio || p.precio <= 0) return false;
    if (!categoryFilter) return true;
    const nombre = (p.nombre || '').toLowerCase();
    return categoryFilter.test(nombre);
  });

  if (filtered.length === 0) {
    return { count: 0, min: null, max: null, avg: null, median: null };
  }

  const prices = filtered.map(p => p.precio).sort((a, b) => a - b);
  const sum = prices.reduce((s, p) => s + p, 0);
  return {
    count: prices.length,
    min: prices[0],
    max: prices[prices.length - 1],
    avg: Math.round(sum / prices.length),
    median: prices[Math.floor(prices.length / 2)]
  };
}

function aggregateProducts() {
  const sources = ['jumbo', 'lider', 'mercadolibre', 'rappi'];
  const all = [];
  const bySource = {};

  for (const src of sources) {
    const record = DataStore.load(src);
    const items = Array.isArray(record.data) ? record.data : [];
    bySource[src] = {
      count: items.length,
      lastRun: record.scrapedAt,
      success: record.success,
      errors: (record.errors || []).length
    };
    all.push(...items);
  }

  return { all, bySource };
}

function inferBrandShare(products) {
  const brandCounts = {};
  for (const p of products) {
    const marca = (p.marca || 'Sin marca').toString().toLowerCase();
    brandCounts[marca] = (brandCounts[marca] || 0) + 1;
  }
  const total = Object.values(brandCounts).reduce((s, c) => s + c, 0);
  if (total === 0) return [];

  return Object.entries(brandCounts)
    .map(([name, count]) => ({
      name,
      count,
      sharePercentage: Math.round((count / total) * 1000) / 10
    }))
    .sort((a, b) => b.count - a.count);
}

async function generateReport() {
  logger.info('[Inference] Generando reporte desde datos scrapeados...');

  const population = new PopulationModel();
  const mobility = new MobilityModel();
  const { all: allProducts, bySource } = aggregateProducts();
  const region = require('../context/region-engine');
  const slug = region.context().slug;
  const loadWithFallback = (regionalKey, genericKey) => {
    const r = DataStore.load(regionalKey);
    return (r && r.itemCount > 0) ? r : DataStore.load(genericKey);
  };
  const maps    = loadWithFallback(`google-maps-${slug}`,    'google-maps');
  const reviews = loadWithFallback(`reviews-${slug}`,        'reviews');
  const trends  = loadWithFallback(`google-trends-${slug}`,  'google-trends');

  const totals = population.totals();

  const priceStats = {
    pan: computePriceStats(allProducts, /pan|marraqueta|hallull|baguette|molde/i),
    pastel: computePriceStats(allProducts, /pastel|torta|kuchen|cake|pie/i),
    galleta: computePriceStats(allProducts, /galleta|cookie/i),
    harina: computePriceStats(allProducts, /harina|premezcla|mix/i)
  };

  const comunasEnriquecidas = population.getAll();
  const demandPerComuna = comunasEnriquecidas.map(c => ({
    id: c.id,
    nombre: c.nombre,
    poblacion: c.poblacion,
    celiacosSerologico: c.celiacos.estimadoSerologico,
    demandaRetenida: mobility.retainedDemand(c),
    demandaAtraida: mobility.attractedDemand(c.id, comunasEnriquecidas)
  }));

  const brandShare = inferBrandShare(allProducts);

  const report = {
    generatedAt: new Date().toISOString(),

    fuentesUsadas: {
      poblacion: totals.fuentes.poblacion,
      prevalencia: 'Araya M, et al. Rev Med Chile 2015 (0.76% serologico)',
      subdiagnostico: 'Fasano A, et al. Arch Intern Med 2003 (ratio 5:1)',
      mobility: mobility.metadata(),
      scrapingStatus: bySource
    },

    confianza: {
      productos: allProducts.length,
      locales: maps.itemCount || 0,
      reviews: reviews.itemCount || 0,
      trendsQueries: trends.data?.queries?.length || 0,
      advertencias: [
        ...(allProducts.length === 0 ? ['No hay productos scrapeados. Ejecuta npm run scrape:jumbo / scrape:lider / scrape:mercadolibre.'] : []),
        ...(maps.itemCount === 0 ? ['No hay locales scrapeados. Ejecuta npm run scrape:maps.'] : []),
        ...(reviews.itemCount === 0 ? ['No hay reviews. Ejecuta npm run scrape:reviews (despues de scrape:maps).'] : []),
        ...(trends.itemCount === 0 ? ['No hay trends. Ejecuta npm run scrape:trends.'] : []),
        ...(mobility.metadata().tipoDeDato === 'proxy_estimado' ? ['Matriz EOD es un PROXY estimado, no datos SECTRA reales.'] : [])
      ]
    },

    poblacion: totals,

    precios: priceStats,

    marcas: brandShare,

    demanda: demandPerComuna,

    trends: trends.data?.comparison || []
  };

  return report;
}

module.exports = { generateReport };
