/**
 * Scraper CONSUMO + INDICADORES DE PRECIOS.
 *
 * BCN web NO publica Indice de Prioridad Social ni gasto familiar por comuna.
 * Lo que SI capturamos es contexto nacional:
 *   - IPC mensual y por divisiones (INE)
 *   - EPF: links oficiales y ronda vigente
 *
 * El "indice de consumo" comunal se DERIVA en el scoring desde los proxies
 * disponibles (pobreza inversa + actividad SII + SIMCE), no se inventa.
 */

const { IneScraperBase, fetchWithRetry, parseChileanNumber } = require('./_base');
const region = require('../../context/region-engine');
const DataStore = require('../../utils/data-store');

const scraper = new IneScraperBase('consumo');
const storeKey = () => `ine-${region.context().slug}-consumo`;

const INE_EPF_URL = 'https://www.ine.gob.cl/estadisticas/sociales/ingresos-y-gastos/encuesta-presupuestos-familiares';
const INE_IPC_URL = 'https://www.ine.gob.cl/estadisticas/economia/indices-de-precio-e-inflacion/indice-de-precios-al-consumidor';

async function scrapeIpcContext() {
  const res = await fetchWithRetry(INE_IPC_URL, {}, 2, 'ine');
  if (!res.ok) {
    scraper.warn(`IPC: ${res.reason}`);
    return null;
  }
  const html = res.body;
  const variaciones = [];
  const reVar = /(variaci[oó]n\s*(mensual|anual|en\s*12\s*meses))[\s:]*([+-]?\d+[,.]\d+)\s*%/gi;
  let m;
  while ((m = reVar.exec(html)) !== null) {
    variaciones.push({ tipo: m[2].toLowerCase(), valor_pct: parseChileanNumber(m[3]) });
  }
  const mesMatch = html.match(/(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+(de\s+)?(\d{4})/i);
  return {
    mes_referencia: mesMatch ? `${mesMatch[1]} ${mesMatch[3]}` : null,
    variaciones: variaciones.slice(0, 6),
    sourceUrl: INE_IPC_URL
  };
}

async function scrapeEpfReferencia() {
  const res = await fetchWithRetry(INE_EPF_URL, {}, 2, 'ine');
  if (!res.ok) {
    scraper.warn(`EPF index: ${res.reason}`);
    return { ronda_vigente: null, descargas: [], sourceUrl: INE_EPF_URL };
  }
  const html = res.body;
  const rondaMatch = html.match(/VIII\s*EPF|IX\s*EPF|EPF\s*\d{4}\s*[-–]\s*\d{4}/i);
  const descargas = [...html.matchAll(/href="([^"]+\.(xlsx|csv|zip|pdf))"/gi)]
    .map(m => m[1])
    .filter(u => /epf|presupuesto/i.test(u))
    .slice(0, 20)
    .map(u => u.startsWith('http') ? u : `https://www.ine.gob.cl${u.startsWith('/') ? '' : '/'}${u}`);
  return {
    ronda_vigente: rondaMatch ? rondaMatch[0] : null,
    descargas,
    sourceUrl: INE_EPF_URL,
    nota: 'EPF representativa a nivel Gran Santiago / capitales. No hay gasto comunal directo.'
  };
}

async function run() {
  scraper.start();
  const [ipc, epf] = await Promise.all([
    scrapeIpcContext(),
    scrapeEpfReferencia()
  ]);

  const payload = {
    porComuna: [],  // BCN no expone IPS comunal en web — placeholder explicito
    contextoNacional: { ipc, epf },
    _notas: 'IPS comunal requiere fuente alternativa (Observatorio Social MDS).'
  };

  DataStore.save(storeKey(), payload, scraper.meta({
    ipcDisponible: !!ipc,
    epfDisponible: !!epf
  }));
  return payload;
}

module.exports = { run, scrapeIpcContext, scrapeEpfReferencia };
