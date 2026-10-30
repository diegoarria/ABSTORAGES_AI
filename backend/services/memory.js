// Memoria persistente por cliente — almacenamiento en JSON por sesión/teléfono
const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '../../data/sessions');
const MAX_CONTEXT_MSGS = 30;   // máximo de turnos enviados a Claude como contexto (no se borran del disco)
const MAX_CHARS  = 4000; // máximo de caracteres en el resumen

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(id) {
  // sanitizar el id para que sea un nombre de archivo válido
  const safe = id.replace(/[^a-zA-Z0-9_\-+]/g, '_');
  return path.join(DATA_DIR, `${safe}.json`);
}

function getSession(id) {
  ensureDir();
  const fp = filePath(id);
  if (!fs.existsSync(fp)) {
    // SARA → MARÍA (oct-2026): si se pide una sesión "...maria..." y el archivo
    // no existe pero sí existe su equivalente "...sara..." de antes del rename,
    // se migra el archivo al vuelo para no perder conversaciones viejas.
    if (id.includes('maria')) {
      const legacyFp = filePath(id.replace(/maria/g, 'sara'));
      if (fs.existsSync(legacyFp)) fs.renameSync(legacyFp, fp);
    }
  }
  if (!fs.existsSync(fp)) {
    return { id, history: [], summary: '', hechos: [], meta: {}, createdAt: Date.now(), updatedAt: Date.now() };
  }
  try {
    const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!Array.isArray(s.hechos)) s.hechos = []; // sesiones viejas, de antes de que existiera este campo
    return s;
  }
  catch { return { id, history: [], summary: '', hechos: [], meta: {}, createdAt: Date.now(), updatedAt: Date.now() }; }
}

function saveSession(id, session) {
  ensureDir();
  session.updatedAt = Date.now();
  fs.writeFileSync(filePath(id), JSON.stringify(session, null, 2));
}

// Agrega un mensaje y recorta si supera MAX_MSGS
function addMessage(id, role, content) {
  const session = getSession(id);
  session.history.push({ role, content, ts: Date.now() });
  // El historial completo se conserva siempre en disco; solo se recorta
  // lo que se envía como contexto a Claude (ver getHistory/buildContext).
  saveSession(id, session);
  return session;
}

// Devuelve el historial completo de la sesión (sin recortar) — para revisión/auditoría
function getFullHistory(id) {
  const session = getSession(id);
  return session.history.map(m => ({ role: m.role, content: m.content, ts: m.ts }));
}

// Devuelve el historial reciente como array de {role, content} listo para la API de Claude
function getHistory(id) {
  const session = getSession(id);
  return session.history.slice(-MAX_CONTEXT_MSGS).map(m => ({ role: m.role, content: m.content }));
}

// Devuelve el contexto completo: resumen anterior + hechos aprendidos + historial reciente
function buildContext(id) {
  const session = getSession(id);
  const parts = [];

  if (session.summary) {
    parts.push(`[CONTEXTO PREVIO DEL CLIENTE]\n${session.summary}\n[FIN CONTEXTO]`);
  }
  if (session.hechos?.length) {
    parts.push(`[HECHOS APRENDIDOS SOBRE ESTA PERSONA EN CONVERSACIONES ANTERIORES]\n${session.hechos.map(h => `- ${h}`).join('\n')}\n[FIN HECHOS]`);
  }

  return {
    contextBlock : parts.join('\n'),
    history      : session.history.slice(-MAX_CONTEXT_MSGS).map(m => ({ role: m.role, content: m.content })),
    meta         : session.meta,
  };
}

// Guarda metadatos del cliente (nombre, empresa, teléfono, última cotización, etc.)
function updateMeta(id, data) {
  const session = getSession(id);
  session.meta = { ...session.meta, ...data };
  saveSession(id, session);
}

// Guarda un resumen generado por IA sobre el cliente
function saveSummary(id, summary) {
  const session = getSession(id);
  // truncar si es muy largo
  session.summary = summary.slice(0, MAX_CHARS);
  saveSession(id, session);
}

// Máximo de hechos aprendidos que se guardan por sesión — un número chico a
// propósito: esto es para patrones/preferencias/comportamiento de la
// RELACIÓN con esta persona (ej. "siempre contesta de noche", "tiende a
// regatear fuerte y luego acepta"), no un historial completo — ver
// reflexionMemoria.js, que es quien llama a esta función.
const MAX_HECHOS = 15;
const MAX_CHARS_HECHO = 220;

// Agrega un hecho aprendido sobre la persona de esta sesión — a diferencia
// de saveSummary (que SOBREESCRIBE un resumen puntual, ej. "ya le preguntaste
// disponibilidad para esta ruta"), esto ACUMULA hechos de relación a lo
// largo de muchas conversaciones distintas. Deduplicado por texto exacto
// (normalizado) para no repetir el mismo hecho dicho con las mismas
// palabras varias veces; recorta el más viejo cuando se pasa de MAX_HECHOS.
function agregarHecho(id, hecho) {
  const texto = String(hecho || '').trim().slice(0, MAX_CHARS_HECHO);
  if (!texto) return null;
  const session = getSession(id);
  const normalizado = texto.toLowerCase();
  if (session.hechos.some(h => h.toLowerCase() === normalizado)) return session; // ya existe, no duplicar
  session.hechos.push(texto);
  if (session.hechos.length > MAX_HECHOS) session.hechos.shift(); // el más viejo se va primero
  saveSession(id, session);
  return session;
}

// Fusiona el historial completo de `fromId` dentro de `intoId` (orden
// cronológico por ts) y deja a `fromId` marcada como fusionada, para no
// repetir la fusión en llamadas futuras. No borra `fromId` — queda como
// respaldo. Pensado para unificar la memoria de un mismo contacto cuando
// pasa de una sesión anónima (chat web) a una identidad conocida (teléfono),
// de forma que de ahí en adelante toda la conversación —sin importar el
// canal— viva en un solo lugar (ver server-lite.js, handleChat).
function mergeInto(fromId, intoId) {
  if (!fromId || !intoId || fromId === intoId) return null;
  const from = getSession(fromId);
  if (from.meta?.mergedInto === intoId) return getSession(intoId); // ya fusionada, no repetir
  const into = getSession(intoId);
  into.history = [...into.history, ...from.history].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const hechosFusionados = [...(from.hechos || []), ...(into.hechos || [])];
  into.hechos = [...new Set(hechosFusionados.map(h => h.toLowerCase()))].map(h => hechosFusionados.find(x => x.toLowerCase() === h)).slice(-MAX_HECHOS);
  into.meta = { ...from.meta, ...into.meta }; // lo de intoId (si ya existía) pisa lo de fromId
  delete into.meta.canonicalId; // intoId es el id canónico, no apunta a sí mismo
  delete into.meta.mergedInto;
  saveSession(intoId, into);
  from.meta = { ...from.meta, mergedInto: intoId, mergedAt: Date.now() };
  saveSession(fromId, from);
  return into;
}

// Borra una sesión por completo (archivo en disco) — borrado manual desde el
// Historial de la plataforma. No hay papelera: una vez borrado, no hay forma
// de recuperar esos mensajes.
function deleteSession(id) {
  const fp = filePath(id);
  if (!fs.existsSync(fp)) return false;
  fs.unlinkSync(fp);
  return true;
}

// Lista todas las sesiones con su metadata
function listSessions() {
  ensureDir();
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        return {
          id: s.id,
          msgs: s.history.length,
          meta: s.meta,
          updatedAt: s.updatedAt,
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

module.exports = { getSession, addMessage, getHistory, getFullHistory, buildContext, updateMeta, saveSummary, agregarHecho, listSessions, deleteSession, mergeInto };
