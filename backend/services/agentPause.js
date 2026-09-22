// ── Pausa de contacto proactivo por agente ────────────────────────────────
// A diferencia de emergencyShutdown.js (apaga TODO — ni siquiera contesta),
// esto solo bloquea que un agente INICIE contacto con alguien (llamadas,
// plantillas de WhatsApp) — sigue pudiendo responder si alguien le escribe
// primero. Pensado para poder pausar a un agente sin apagarlo por completo.
// Memoria + disco — mismo patrón que ipBanlist.js/emergencyShutdown.js.
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/agent-pause.json');

function cargar() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return {};
}

// { [agente]: { motivo, desde } }
const pausados = cargar();

function guardar() {
  try { fs.writeFileSync(FILE, JSON.stringify(pausados, null, 2)); }
  catch (e) { console.error('[agentPause] Error guardando en disco:', e.message); }
}

function pausar(agente, motivo) {
  const a = (agente || '').toLowerCase();
  if (!a) return;
  pausados[a] = { motivo: motivo || null, desde: new Date().toISOString() };
  guardar();
  console.warn(`[agentPause] 🔇 Contacto proactivo de ${a.toUpperCase()} PAUSADO — ${motivo || 'sin motivo'}`);
}

function reanudar(agente) {
  const a = (agente || '').toLowerCase();
  if (!a || !pausados[a]) return;
  delete pausados[a];
  guardar();
  console.log(`[agentPause] ▶️  Contacto proactivo de ${a.toUpperCase()} reanudado`);
}

function estaPausado(agente) {
  return !!pausados[(agente || '').toLowerCase()];
}

function listar() {
  return { ...pausados };
}

// Sobreescribe el estado completo desde una fuente externa (monitoringControl,
// que lo trae de la base de monitoring) — a diferencia de pausar/reanudar, esto
// no dispara el push de vuelta a monitoring, es solo "adoptar lo que ya está
// ahí". Usado en el arranque y en la resincronización periódica, para que un
// disco local viejo/vacío (como pasó el 16-22 de septiembre con el volumen de
// Railway) nunca vuelva a ganarle silenciosamente al estado real.
function establecerEstadoCompleto(nuevoEstado) {
  const anterior = JSON.stringify(pausados);
  for (const k of Object.keys(pausados)) delete pausados[k];
  for (const [agente, datos] of Object.entries(nuevoEstado || {})) {
    if (datos?.paused) pausados[agente] = { motivo: datos.motivo, desde: datos.changed_at || new Date().toISOString() };
  }
  if (JSON.stringify(pausados) !== anterior) {
    console.warn('[agentPause] Estado resincronizado desde monitoring:', JSON.stringify(pausados));
  }
  guardar();
}

module.exports = { pausar, reanudar, estaPausado, listar, establecerEstadoCompleto };
