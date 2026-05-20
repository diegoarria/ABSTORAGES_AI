// In-memory conversation store — funciona con o sin PostgreSQL
// Guarda el historial de cada sesión en memoria mientras el proceso vive

const store = new Map(); // key: "AGENTE:sessionId" → [{ role, content }]
const MAX_MESSAGES = 60; // 30 exchanges por sesión

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
}

module.exports = { getHistory, addMessage, clearSession };
