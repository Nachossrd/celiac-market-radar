/**
 * Clasificador socioeconomico territorial.
 *
 * Bandas por score [0..100]:
 *   Alto       >= 80
 *   Medio-Alto 65..80
 *   Medio      45..65
 *   Medio-Bajo 30..45
 *   Bajo       <30
 *
 * Confianza por verificacion cruzada con 3 marcadores (BCN):
 *   - pobreza_ingresos_pct
 *   - simce_4b_lectura
 *   - hacinamiento_pct
 *
 * Si >=2 marcadores apuntan a la misma banda que el score => alta.
 * Si 1 marcador => media. Cero => baja. Sin marcadores => sin-datos.
 */

const BANDS = [
  { name: 'Alto',        min: 80 },
  { name: 'Medio-Alto',  min: 65 },
  { name: 'Medio',       min: 45 },
  { name: 'Medio-Bajo',  min: 30 },
  { name: 'Bajo',        min: 0  }
];

function bandFor(score) {
  if (score === null || score === undefined) return null;
  return BANDS.find(b => score >= b.min)?.name || 'Bajo';
}

function bandFromPobreza(p) {
  if (p === null) return null;
  // Inversa: menos pobreza => banda mas alta. Umbrales calibrados sobre RM Casen 2022.
  if (p <= 2)  return 'Alto';
  if (p <= 5)  return 'Medio-Alto';
  if (p <= 10) return 'Medio';
  if (p <= 16) return 'Medio-Bajo';
  return 'Bajo';
}

function bandFromSimce(lec, mat) {
  const vals = [lec, mat].filter(v => v !== null && v !== undefined);
  if (!vals.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (avg >= 290) return 'Alto';
  if (avg >= 275) return 'Medio-Alto';
  if (avg >= 260) return 'Medio';
  if (avg >= 245) return 'Medio-Bajo';
  return 'Bajo';
}

function bandFromHacinamiento(h) {
  if (h === null) return null;
  if (h <= 2)  return 'Alto';
  if (h <= 5)  return 'Medio-Alto';
  if (h <= 10) return 'Medio';
  if (h <= 18) return 'Medio-Bajo';
  return 'Bajo';
}

function confirmations(rec) {
  const score = rec.poder_adquisitivo_score;
  if (score === null) return { count: 0, total: 0 };
  const expected = bandFor(score);
  const v = rec.variables || {};

  const checks = [
    bandFromPobreza(v.pobreza_ingresos_pct),
    bandFromSimce(v.simce_4b_lectura, v.simce_4b_matematica),
    bandFromHacinamiento(v.hacinamiento_pct)
  ].filter(b => b !== null);

  return { count: checks.filter(b => b === expected).length, total: checks.length };
}

function elasticidadPrecio(score) {
  if (score === null) return null;
  if (score >= 80) return 'baja';
  if (score >= 60) return 'media-baja';
  if (score >= 40) return 'media';
  if (score >= 25) return 'media-alta';
  return 'alta';
}

function probabilidadConsumoPremium(rec) {
  const s = rec.poder_adquisitivo_score;
  if (s === null) return null;
  const z = (s - 70) / 10;
  return Math.round((1 / (1 + Math.exp(-z))) * 100) / 100;
}

function classify(rec) {
  const band = bandFor(rec.poder_adquisitivo_score);
  const conf = confirmations(rec);
  const confianzaClase = (
    conf.total === 0  ? 'sin-datos' :
    conf.count >= 2   ? 'alta' :
    conf.count === 1  ? 'media' : 'baja'
  );
  return {
    nivel_socioeconomico: band,
    clase_confianza: confianzaClase,
    confirmaciones: `${conf.count}/${conf.total}`,
    elasticidad_precio: elasticidadPrecio(rec.poder_adquisitivo_score),
    probabilidad_consumo_premium: probabilidadConsumoPremium(rec)
  };
}

module.exports = { classify, bandFor, BANDS };
