// ── Límite duro de contacto proactivo por agente ──────────────────────────────
// Segunda capa de seguridad, INDEPENDIENTE de agentPause.js — por diseño.
// El incidente del 16-22 de septiembre pasó porque el único freno (un flag)
// falló silenciosamente durante una semana. Esto es la red de repuesto: un
// techo duro de mensajes/llamadas por agente por día que no depende de que
// ningún otro interruptor esté bien puesto. Si agentPause también falla otra
// vez, esto solo permite que el daño llegue hasta el techo, nunca más.
//
// Memoria + disco — mismo patrón que ipBanlist.js. El contador es por día
// calendario (hora de Monterrey) y se reinicia solo al cambiar de día.
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/outbound-rate-limit.json');

// Techo por default — generoso para operación normal, pero muy por debajo
// de los ~100/día que salieron durante el incidente. Ajustable por agente
// vía env var sin tocar código.
const LIMITES = {
  sara:  Number(process.env.OUTBOUND_LIMIT_SARA  || 40),
  sofia: Number(process.env.OUTBOUND_LIMIT_SOFIA || 40),
  noa:   Number(process.env.OUTBOUND_LIMIT_NOA   || 40),
};

function fechaMTY() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Monterrey', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date());
}

function cargar() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return {};
}

// { [agente]: { fecha: 'YYYY-MM-DD', count: N } }
const cache = cargar();

let saveTimer = null;
function guardar() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(cache, null, 2)); }
    catch (e) { console.error('[outboundRateLimit] Error guardando en disco:', e.message); }
  }, 500);
}

function entrada(agente) {
  const a = (agente || '').toLowerCase();
  const hoy = fechaMTY();
  if (!cache[a] || cache[a].fecha !== hoy) cache[a] = { fecha: hoy, count: 0 };
  return cache[a];
}

// Registra un envío real y dice si YA se pasó del límite — se llama justo
// antes de mandar, así el envío que rompería el techo nunca sale.
function registrarYVerificar(agente) {
  const a = (agente || '').toLowerCase();
  const limite = LIMITES[a] ?? 40;
  const e = entrada(a);
  if (e.count >= limite) {
    return { permitido: false, count: e.count, limite };
  }
  e.count += 1;
  guardar();
  return { permitido: true, count: e.count, limite };
}

function estado(agente) {
  const a = (agente || '').toLowerCase();
  const e = entrada(a);
  return { count: e.count, limite: LIMITES[a] ?? 40, fecha: e.fecha };
}

module.exports = { registrarYVerificar, estado, LIMITES };
