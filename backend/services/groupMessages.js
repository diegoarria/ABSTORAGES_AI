// ── Memoria del grupo de WhatsApp "ABSTORAGES IA - TEST" ──────────────────────
// Guarda cada mensaje (entrante y saliente) para darle contexto a SOFIA/NOA —
// mismo patrón de archivo JSON que ya usa callLog.js, sin depender de Postgres.
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/whatsapp-grupo.json');
const MAX_REGISTROS = 5000;

function cargar() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return [];
}

let cache = cargar();
let saveTimer = null;

function guardarDisco() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(cache, null, 2)); }
    catch (e) { console.error('[groupMessages] Error guardando:', e.message); }
  }, 500);
}

function registrar(entrada) {
  const registro = {
    timestamp: new Date().toISOString(),
    ...entrada,
  };
  cache.push(registro);
  if (cache.length > MAX_REGISTROS) cache = cache.slice(-MAX_REGISTROS);
  guardarDisco();
  return registro;
}

// ¿Ya guardamos este message_id? — evita procesar el mismo webhook dos veces
// (2Chat puede reintentar la entrega) y evita que un mensaje saliente propio
// se vuelva a interpretar como entrante si el webhook lo hace eco.
function existeMensaje(messageId) {
  return !!messageId && cache.some(m => m.message_id === messageId);
}

// Busca si un message_id corresponde a un mensaje que mandamos nosotros como
// agente (para la Regla 2 — reply a SOFIA/NOA sin necesidad de @mención).
function agentePorMessageId(messageId) {
  const m = cache.find(x => x.message_id === messageId && x.direction === 'outgoing');
  return m ? m.agent : null;
}

function contextoGrupo(groupUuid, limit = 20) {
  return cache
    .filter(m => m.group_uuid === groupUuid)
    .slice(-limit);
}

// Limpia mensajes de un grupo (o todos si no se pasa groupUuid) — para
// descontaminar el historial cuando quedó guardado algo mal formado.
function limpiar(groupUuid) {
  const antes = cache.length;
  cache = groupUuid ? cache.filter(m => m.group_uuid !== groupUuid) : [];
  guardarDisco();
  return antes - cache.length;
}

module.exports = { registrar, existeMensaje, agentePorMessageId, contextoGrupo, limpiar };
