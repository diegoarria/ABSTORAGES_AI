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

// Arma "conversaciones" agrupadas para el historial de la plataforma — un
// hilo por group_uuid real (mismo agrupamiento que ya usa contextoGrupo()
// para darle contexto al agente al responder, así el historial coincide
// exactamente con lo que el bot ve). Un grupo de WhatsApp real mezcla
// SOFIA/NOA/humanos en un solo hilo; un 1:1 es un hilo por número de
// contacto (nota: si el mismo contacto le escribe a más de un bot 1:1,
// hoy comparten canal — mismo comportamiento que ya tiene el webhook al
// armar el contexto, no es algo nuevo de esta vista).
function listarConversaciones() {
  const porCanal = {};
  for (const m of cache) {
    if (!porCanal[m.group_uuid]) porCanal[m.group_uuid] = [];
    porCanal[m.group_uuid].push(m);
  }
  return Object.entries(porCanal).map(([canalUuid, mensajes]) => {
    const esGrupo = !canalUuid.startsWith('1a1:');
    const ultimo = mensajes[mensajes.length - 1];
    const primerEntrante = mensajes.find(m => m.direction === 'incoming');
    // Último agente que respondió en el hilo — solo para la etiqueta visual
    // en 1:1; en grupo se etiqueta genérico porque puede haber más de uno.
    const ultimoAgente = [...mensajes].reverse().find(m => m.agent)?.agent;
    // Personas reales que escribieron en el hilo (no el nombre del grupo en
    // sí) — dedup por teléfono, para mostrar quién participó.
    const participantes = [...new Map(
      mensajes.filter(m => m.direction === 'incoming' && m.sender_phone)
        .map(m => [m.sender_phone, { nombre: m.sender_name || null, telefono: m.sender_phone }])
    ).values()];
    return {
      sessionId: `2chat:${canalUuid}`,
      agente: esGrupo ? 'grupo' : (ultimoAgente || 'desconocido'),
      msgs: mensajes.length,
      updatedAt: new Date(ultimo.timestamp).getTime(),
      // El nombre real del grupo se resuelve aparte (vía API de 2Chat, no
      // vive en estos mensajes) — server-lite.js lo sobreescribe si lo tiene
      // en caché; este es solo el fallback.
      nombre: esGrupo ? 'Grupo de WhatsApp' : (primerEntrante?.sender_name || 'Contacto WhatsApp'),
      empresa: null,
      telefono: esGrupo ? null : (primerEntrante?.sender_phone || null),
      participantes,
      resumen: null,
    };
  });
}

// Historial completo de un hilo (grupo o 1:1) a partir del sessionId
// sintético que arma listarConversaciones() — usado por el detalle del
// historial de la plataforma.
function historialDeConversacion(sessionId) {
  const canalUuid = sessionId.replace(/^2chat:/, '');
  const mensajes = contextoGrupo(canalUuid, 500);
  const esGrupo = !canalUuid.startsWith('1a1:');
  const ultimoAgente = [...mensajes].reverse().find(m => m.agent)?.agent;
  const historial = mensajes.map(m => ({
    role: m.direction === 'outgoing' ? 'assistant' : 'user',
    content: m.direction === 'outgoing' ? m.message_text : `${m.sender_name}: ${m.message_text}`,
    ts: new Date(m.timestamp).getTime(),
  }));
  return { agente: esGrupo ? 'grupo' : (ultimoAgente || 'desconocido'), historial };
}

module.exports = {
  registrar, existeMensaje, agentePorMessageId, contextoGrupo, limpiar,
  listarConversaciones, historialDeConversacion,
};
