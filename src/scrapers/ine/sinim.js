/**
 * Scraper SINIM (Sistema Nacional de Informacion Municipal) - PENDIENTE.
 *
 * Estado: BLOQUEADO. SINIM no publica un dataset descargable masivo y su
 * portal de consulta usa AJAX privado (POST con sesion PHPSESSID a
 * /datos_municipales/obtener_*.php) que devuelve "Error inesperado" sin la
 * combinacion exacta de IDs internos area/subarea/variable que el sitio
 * resuelve client-side via Chosen.js.
 *
 * Opciones para destrabar (decidir con el usuario antes de implementar):
 *
 *   A) Parsear XLSX oficiales de datos.gob.cl
 *      - Agregar dependencia `xlsx` (~3 MB) al package.json
 *      - Datasets:
 *          datos.gob.cl/dataset/principales-ingresos-y-gastos-de-salud-municipal
 *          datos.gob.cl/dataset/informacion-gastos-municipales-con-aportes-gobierno-central
 *      - Cobertura: hasta 2022.
 *      - Variables: ingreso propio municipal, dependencia FCM, gasto per capita.
 *
 *   B) Ingenieria inversa del AJAX SINIM
 *      - Tiempo estimado: 2-4 h de descubrir IDs internos via DevTools.
 *      - Una vez descubiertos, scraping es directo (POST a obtener_valores.php).
 *      - Beneficio: serie temporal 2008-actual con 600+ variables.
 *
 *   C) Subdere Conociendo Chile / portal FICOM
 *      - URL: https://conociendochile.subdere.gov.cl
 *      - Misma data SINIM pero con frontend mas estable. No verificado aun.
 *
 * Mientras tanto este modulo registra el bloqueo de forma explicita: corre,
 * guarda 0 items, y el reporte deja claro al consumidor que la variable no
 * esta disponible. NO inventa proxies ni rellena con constantes.
 */

const { IneScraperBase } = require('./_base');
const { listComunas, getComunaMeta } = require('../../analysis/ine/normalizer');
const DataStore = require('../../utils/data-store');

const scraper = new IneScraperBase('sinim');

async function run() {
  scraper.start();
  scraper.warn('SINIM bloqueado: ver doc en src/scrapers/ine/sinim.js (opciones A/B/C).');

  const results = listComunas().map(c => ({
    comunaId: c.id,
    comuna: getComunaMeta(c.id)?.nombre,
    presupuesto_municipal_clp: null,
    presupuesto_per_capita_clp: null,
    dependencia_fcm_pct: null,
    ingresos_propios_pct: null,
    gasto_educacion_per_capita_clp: null,
    gasto_salud_per_capita_clp: null,
    _estado: 'no-implementado',
    _bloqueo: 'SINIM AJAX privado / datasets datos.gob.cl en XLSX (requiere lib xlsx)'
  }));

  DataStore.save('ine-sinim', results, scraper.meta({
    comunasConDatos: 0,
    comunasTotales: results.length,
    estado: 'no-implementado'
  }));

  return results;
}

module.exports = { run };
