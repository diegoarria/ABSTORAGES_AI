// ─── HUMAN DELAY — simula tiempo de respuesta humano ─────────────────────────
// Punto 12 del checklist de Rafael: "programar los tiempos de respuesta de las
// IA casi similar al tiempo que un humano responde para simular más cercano a
// una persona". Se aplica ANTES de abrir el stream de la respuesta — simula el
// tiempo que tomaría a una persona leer el mensaje entrante y empezar a
// escribir. Escala levemente con la longitud del mensaje, con jitter aleatorio,
// y queda acotado para no dañar la experiencia del usuario.
const MIN_MS = 900;
const MAX_MS = 3200;
const MS_POR_CARACTER = 4; // "tiempo de lectura" del mensaje entrante

function calcularDelay(mensaje) {
  const largo = String(mensaje || '').length;
  const base = MIN_MS + Math.min(largo * MS_POR_CARACTER, MAX_MS - MIN_MS);
  const jitter = Math.random() * 500;
  return Math.min(Math.round(base + jitter), MAX_MS);
}

function esperar(mensaje) {
  const ms = calcularDelay(mensaje);
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { esperar, calcularDelay };
