require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const logger = require('./src/utils/logger');

const apiRoutes = require('./src/routes/api');
const watcher = require('./src/core/region-watcher');
const region = require('./src/context/region-engine');
const autoTrigger = require('./src/core/region-auto-trigger');

// Conecta region.onChange -> auto.run. Cualquier cambio de region (selector,
// API, watcher) dispara la pipeline automaticamente.
autoTrigger.init();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', apiRoutes);

app.listen(PORT, () => {
  logger.info(`Servidor OSINT Chile escuchando en http://localhost:${PORT}`);
  const slug = region.current();
  console.log(`\n  OSINT Chile - v4.0 multi-region\n  Region inicial: ${slug}\n  Dashboard:      http://localhost:${PORT}\n  API:            http://localhost:${PORT}/api\n  Cambiar region: editar .env (REGION=valparaiso) o POST /api/regions/set\n`);

  if (process.env.WATCHER !== 'off') {
    watcher.start({ skipBoot: true });
  } else {
    logger.info('[server] watcher deshabilitado (WATCHER=off)');
  }
});

module.exports = app;
