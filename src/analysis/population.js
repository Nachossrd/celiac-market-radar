const region = require('../context/region-engine');

/**
 * Modelo poblacional - region-aware.
 *
 * Fuentes:
 * - Poblacion: INE Chile, proyeccion 2024 (base Censo 2017). Cargada via region-engine.
 * - Prevalencia celiaca en Chile: Araya M, et al. Rev Med Chile 2015 (0.76% serologico).
 * - Ratio subdiagnostico: Fasano A, et al. Arch Intern Med 2003 (~5:1).
 *
 * La prevalencia celiaca se asume NACIONAL (la literatura chilena no diferencia por
 * region). El reparto absoluto SI cambia por region porque la poblacion lo hace.
 */

const PREVALENCIA_SEROLOGICA = 0.0076;
const PREVALENCIA_AUTO_REPORTE = 0.01;
const RATIO_SUBDIAGNOSTICO = 5;

class PopulationModel {
  constructor() {
    this.prevalencia = PREVALENCIA_SEROLOGICA;
    this.prevalenciaAutoReporte = PREVALENCIA_AUTO_REPORTE;
    this.ratioNoDiagnosticados = RATIO_SUBDIAGNOSTICO;
    this.fuentes = region.context().fuentes || {};
  }

  getAll() {
    return region.context().comunas.map(comuna => this.enrich(comuna));
  }

  getById(id) {
    const comuna = region.context().getComuna(id);
    return comuna ? this.enrich(comuna) : null;
  }

  enrich(comuna) {
    const celiacosTotal = Math.round(comuna.poblacion * this.prevalenciaAutoReporte);
    const celiacosSerologico = Math.round(comuna.poblacion * this.prevalencia);
    const diagnosticados = Math.round(celiacosSerologico / this.ratioNoDiagnosticados);
    const subdiagnosticados = celiacosSerologico - diagnosticados;

    return {
      ...comuna,
      celiacos: {
        estimadoAutoReporte: celiacosTotal,
        estimadoSerologico: celiacosSerologico,
        diagnosticados,
        subdiagnosticados
      }
    };
  }

  totals() {
    const all = this.getAll();
    return {
      comunas: all.length,
      poblacion: all.reduce((s, c) => s + c.poblacion, 0),
      celiacosEstimados: all.reduce((s, c) => s + c.celiacos.estimadoSerologico, 0),
      diagnosticados: all.reduce((s, c) => s + c.celiacos.diagnosticados, 0),
      subdiagnosticados: all.reduce((s, c) => s + c.celiacos.subdiagnosticados, 0),
      prevalenciaAplicada: this.prevalencia,
      fuentes: this.fuentes
    };
  }
}

module.exports = { PopulationModel, PREVALENCIA_SEROLOGICA, RATIO_SUBDIAGNOSTICO };
