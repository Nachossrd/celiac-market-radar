const Bottleneck = require('bottleneck');

/**
 * Rate limiters por fuente.
 * Configurados conservadoramente para NO ser bloqueados.
 */

const limiters = {
  google: new Bottleneck({
    minTime: parseInt(process.env.DELAY_GOOGLE_MS) || 8000,
    maxConcurrent: 1
  }),
  mercadolibre: new Bottleneck({
    minTime: parseInt(process.env.DELAY_MERCADOLIBRE_MS) || 3000,
    maxConcurrent: 1
  }),
  supermercado: new Bottleneck({
    minTime: parseInt(process.env.DELAY_SUPERMERCADO_MS) || 2000,
    maxConcurrent: 1
  }),
  rappi: new Bottleneck({
    minTime: parseInt(process.env.DELAY_RAPPI_MS) || 2000,
    maxConcurrent: 1
  }),
  ine: new Bottleneck({
    minTime: parseInt(process.env.DELAY_INE_MS) || 4500,
    maxConcurrent: 1,
    reservoir: 60,
    reservoirRefreshAmount: 60,
    reservoirRefreshInterval: 60 * 1000
  }),
  bcn: new Bottleneck({
    minTime: parseInt(process.env.DELAY_BCN_MS) || 3500,
    maxConcurrent: 2,
    reservoir: 90,
    reservoirRefreshAmount: 90,
    reservoirRefreshInterval: 60 * 1000
  })
};

module.exports = limiters;
