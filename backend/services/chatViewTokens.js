// Tokens de solo lectura para el botón "Ver chat en tiempo real" del email de
// SOFIA — permiten abrir UNA conversación puntual sin iniciar sesión en el
// portal. El token es opaco (no es el sessionId) para que no se pueda adivinar
// ni enumerar otras conversaciones a partir de él.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '../../data/chat-view-tokens.json');
let tokens = {};
try { tokens = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}

function guardar() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(tokens));
  } catch (e) {
    console.error('[chatViewTokens] no se pudo guardar:', e.message);
  }
}

// Reutiliza el token si ya existe uno para esa sesión, así el link no cambia
// cada vez que llega un mensaje nuevo en la misma conversación.
function crear(sessionId, meta = {}) {
  const existente = Object.entries(tokens).find(([, v]) => v.sessionId === sessionId);
  if (existente) {
    const [token, data] = existente;
    if (meta.nombre) data.nombre = meta.nombre;
    if (meta.telefono) data.telefono = meta.telefono;
    guardar();
    return token;
  }
  const token = crypto.randomBytes(24).toString('hex');
  tokens[token] = { sessionId, nombre: meta.nombre || null, telefono: meta.telefono || null, creadoEn: Date.now() };
  guardar();
  return token;
}

function resolver(token) {
  return tokens[token] || null;
}

module.exports = { crear, resolver };
