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
  maria: Number(process.env.OUTBOUND_LIMIT_MARIA || process.env.OUTBOUND_LIMIT_SARA || 40),
  sara:  Number(process.env.OUTBOUND_LIMIT_MARIA || process.env.OUTBOUND_LIMIT_SARA || 40), // alias heredado — mismo techo
  sofia: Number(process.env.OUTBOUND_LIMIT_SOFIA || 40),
  noa:   Number(process.env.OUTBOUND_LIMIT_NOA   || 40),
};

// Reserva exclusiva para clientes top5 — pedido explícito del usuario
// (26-oct-2026): el límite diario normal no debe poder dejar a un cliente
// top5 sin poder contactar proveedores solo porque la difusión general u
// otro tráfico rutinario ya gastó el cupo del día. Un envío NO urgente nunca
// puede tocar esta franja (se bloquea en cuanto count >= LIMITES[a]); solo un
// envío marcado "urgente" puede usarla, así que el cupo de arriba del techo
// normal queda intacto exclusivamente para top5.
const RESERVA_URGENTE = Number(process.env.OUTBOUND_RESERVA_URGENTE || 15);

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
// Contador de hoy guardado bajo 'sara' antes del rename → se hereda en 'maria'.
if (cache.sara && !cache.maria) cache.maria = cache.sara;

// Síncrona e inmediata (sin debounce) — pedido explícito del usuario
// (30-oct-2026). Este archivo es la red de repuesto creada justo por el
// incidente del 16-22 de septiembre; un debounce aquí deja la misma ventana
// de pérdida de estado en un reinicio que causó el incidente real del
// whatsappProactivo.js del 30-oct-2026 (4 envíos duplicados en 4 horas) —
// justo el componente que debe sobrevivir un reinicio no debe poder perder
// el último conteo.
function guardar() {
  try { fs.writeFileSync(FILE, JSON.stringify(cache, null, 2)); }
  catch (e) { console.error('[outboundRateLimit] Error guardando en disco:', e.message); }
}

// SARA → MARÍA (oct-2026): 'sara' y 'maria' son el mismo agente — comparten
// UN solo contador (bajo 'maria') para que el techo no se duplique mientras
// conviven llamadas con el identificador viejo (p. ej. contactos con
// agente_asignado 'SARA') y el nuevo.
function clave(agente) {
  const a = (agente || '').toLowerCase();
  return a === 'sara' ? 'maria' : a;
}

function entrada(agente) {
  const a = clave(agente);
  const hoy = fechaMTY();
  if (!cache[a] || cache[a].fecha !== hoy) cache[a] = { fecha: hoy, count: 0 };
  return cache[a];
}

// Registra un envío real y dice si YA se pasó del límite — se llama justo
// antes de mandar, así el envío que rompería el techo nunca sale.
// `urgente: true` (cliente top5) puede usar la franja de reserva por encima
// del límite normal, cuando el tráfico rutinario ya lo agotó.
function registrarYVerificar(agente, { urgente } = {}) {
  const a = clave(agente);
  const limite = LIMITES[a] ?? 40;
  const techo = urgente ? limite + RESERVA_URGENTE : limite;
  const e = entrada(a);
  if (e.count >= techo) {
    return { permitido: false, count: e.count, limite: techo };
  }
  e.count += 1;
  guardar();
  return { permitido: true, count: e.count, limite: techo, usoReserva: urgente && e.count > limite };
}

function estado(agente) {
  const a = clave(agente);
  const e = entrada(a);
  return { count: e.count, limite: LIMITES[a] ?? 40, fecha: e.fecha };
}

module.exports = { registrarYVerificar, estado, LIMITES };
