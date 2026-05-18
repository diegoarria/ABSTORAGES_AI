// Memoria persistente por cliente — almacenamiento en JSON por sesión/teléfono
const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '../../data/sessions');
const MAX_MSGS   = 30;   // máximo de turnos guardados por sesión
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
    return { id, history: [], summary: '', meta: {}, createdAt: Date.now(), updatedAt: Date.now() };
  }
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return { id, history: [], summary: '', meta: {}, createdAt: Date.now(), updatedAt: Date.now() }; }
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
  if (session.history.length > MAX_MSGS) {
    session.history = session.history.slice(-MAX_MSGS);
  }
  saveSession(id, session);
  return session;
}

// Devuelve el historial como array de {role, content} listo para la API de Claude
function getHistory(id) {
  const session = getSession(id);
  return session.history.map(m => ({ role: m.role, content: m.content }));
}

// Devuelve el contexto completo: resumen anterior + historial reciente
function buildContext(id) {
  const session = getSession(id);
  const parts = [];

  if (session.summary) {
    parts.push(`[CONTEXTO PREVIO DEL CLIENTE]\n${session.summary}\n[FIN CONTEXTO]`);
  }

  return {
    contextBlock : parts.join('\n'),
    history      : session.history.map(m => ({ role: m.role, content: m.content })),
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

module.exports = { getSession, addMessage, getHistory, buildContext, updateMeta, saveSummary, listSessions };
