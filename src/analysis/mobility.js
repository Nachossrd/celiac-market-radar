const region = require('../context/region-engine');
const EOD_RM = require('../../data/eod-matrix.json');

/**
 * Modelo de movilidad inter-comunal — region-aware.
 *
 * IMPORTANTE: La matriz eod-matrix.json es un PROXY para Region Metropolitana.
 * Para otras regiones no hay matriz cargada; el modelo degrada honestamente a
 * "sin datos de movilidad" y los flujos atraidos quedan en 0 con bandera.
 *
 * Cuando consigas EOD oficial para otra region, agrega data/eod-<region>.json
 * y este modulo lo cargara automaticamente.
 */

const fs = require('fs');
const path = require('path');

function loadMatrixForRegion(slug) {
  if (slug === 'metropolitana') return EOD_RM;
  const file = path.join(__dirname, `../../data/eod-${slug}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return { matrix: {}, defaultFlows: {}, tipoDeDato: 'sin-datos', fuente: `Sin matriz EOD para ${slug}` };
}

class MobilityModel {
  constructor() {
    const slug = region.context().slug;
    const data = loadMatrixForRegion(slug);
    this.region = slug;
    this.matrix = data.matrix || {};
    this.defaults = data.defaultFlows || {};
    this.tipoDeDato = data.tipoDeDato || 'sin-datos';
    this.fuente = data.fuente || '';
  }

  /**
   * Devuelve flujos de salida de una comuna origen.
   * Si no hay entrada especifica, cae al default residential.
   */
  flowsFrom(comunaId) {
    if (this.matrix[comunaId]) return { ...this.matrix[comunaId] };
    return { ...(this.defaults.residential || {}) };
  }

  /**
   * Estima demanda atraida hacia una comuna destino sumando los flujos
   * (de salida * poblacion celiaca) de todas las comunas origen.
   */
  attractedDemand(comunaDestId, comunasEnriquecidas) {
    let total = 0;
    for (const origen of comunasEnriquecidas) {
      const flows = this.flowsFrom(origen.id);
      const share = flows[comunaDestId] || 0;
      total += share * (origen.celiacos?.estimadoSerologico || 0);
    }
    return Math.round(total);
  }

  /**
   * Demanda local retenida (la fraccion que se queda en la propia comuna).
   */
  retainedDemand(comuna) {
    const flows = this.flowsFrom(comuna.id);
    const share = flows.local || 0;
    return Math.round(share * (comuna.celiacos?.estimadoSerologico || 0));
  }

  /**
   * Metadata sobre la fuente de la matriz, para mostrarla en el dashboard
   * y que el usuario sepa que es proxy y no EOD oficial.
   */
  metadata() {
    return {
      region: this.region,
      tipoDeDato: this.tipoDeDato,
      fuente: this.fuente,
      origenesDefinidos: Object.keys(this.matrix).length
    };
  }
}

module.exports = { MobilityModel };
