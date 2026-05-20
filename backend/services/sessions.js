const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, '../../data/sessions.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

function load() {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    // Limpiar expiradas al cargar
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      if (now - v._ts > TTL_MS) delete obj[k];
    }
    return obj;
  } catch (_) {
    return {};
  }
}

function save(store) {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store), 'utf8');
  } catch (_) {}
}

const store = load();

function create(user) {
  const id = crypto.randomBytes(32).toString('hex');
  store[id] = { ...user, _ts: Date.now() };
  save(store);
  return id;
}

function get(id) {
  if (!id) return null;
  const s = store[id];
  if (!s) return null;
  if (Date.now() - s._ts > TTL_MS) { delete store[id]; save(store); return null; }
  return s;
}

function destroy(id) {
  delete store[id];
  save(store);
}

module.exports = { create, get, destroy };
