// In-memory conversation store — funciona con o sin PostgreSQL
// Guarda el historial de cada sesión en memoria mientras el proceso vive

const store    = new Map(); // key: "AGENTE:sessionId" → [{ role, content }]
const metadata = new Map(); // key: "AGENTE:sessionId" → { activeFolio, ... }
const MAX_MESSAGES = 60;

function key(agente, sessionId) {
  return `${agente.toUpperCase()}:${sessionId}`;
}

function getHistory(agente, sessionId) {
  return store.get(key(agente, sessionId)) || [];
}

function addMessage(agente, sessionId, role, content) {
  const k = key(agente, sessionId);
  if (!store.has(k)) store.set(k, []);
  const hist = store.get(k);
  hist.push({ role, content });
  if (hist.length > MAX_MESSAGES) hist.splice(0, hist.length - MAX_MESSAGES);
}

function clearSession(agente, sessionId) {
  store.delete(key(agente, sessionId));
  metadata.delete(key(agente, sessionId));
}

// ── Folio activo por sesión ───────────────────────────────────────────────────
// Cuando SOFIA detecta un folio en una sesión, lo persiste para todos los
// mensajes siguientes — el cliente no necesita repetirlo.

function setActiveFolio(agente, sessionId, folio) {
  const k = key(agente, sessionId);
  const m = metadata.get(k) || {};
  m.activeFolio = folio;
  metadata.set(k, m);
}

function getActiveFolio(agente, sessionId) {
  return metadata.get(key(agente, sessionId))?.activeFolio || null;
}

module.exports = { getHistory, addMessage, clearSession, setActiveFolio, getActiveFolio };
