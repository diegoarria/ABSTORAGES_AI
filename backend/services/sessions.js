const crypto = require('crypto');

const store = new Map();
const TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

function create(user) {
  const id = crypto.randomBytes(32).toString('hex');
  store.set(id, { ...user, _ts: Date.now() });
  return id;
}

function get(id) {
  if (!id) return null;
  const s = store.get(id);
  if (!s) return null;
  if (Date.now() - s._ts > TTL_MS) { store.delete(id); return null; }
  return s;
}

function destroy(id) {
  store.delete(id);
}

module.exports = { create, get, destroy };
