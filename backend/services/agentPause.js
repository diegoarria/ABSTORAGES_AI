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

module.exports = { pausar, reanudar, estaPausado, listar };
