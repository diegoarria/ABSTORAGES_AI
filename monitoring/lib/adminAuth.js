// ── Auth propio del panel de monitoring — completamente aislado del login de
// negocio (backend/middleware/auth.js + data/sessions.json). Usuario y
// contraseña (con hash real, no texto plano) en monitoring/data/admin-users.json
// (gitignored) — se crea con `node monitoring/scripts/createAdminUser.js`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_FILE = path.join(__dirname, '../data/admin-users.json');
const SESSION_COOKIE = 'monitoring_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — panel técnico, sesiones cortas

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveUsers(users) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const intento = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(intento), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function upsertUser(username, password) {
  const users = loadUsers().filter(u => u.username !== username);
  users.push({ username, passwordHash: hashPassword(password) });
  saveUsers(users);
}

function verificarLogin(username, password) {
  const user = loadUsers().find(u => u.username === username);
  if (!user) return false;
  return verifyPassword(password, user.passwordHash);
}

// ── Sesiones en memoria — el panel es de un solo admin, no necesita nada
// más robusto que esto; se pierden si el proceso se reinicia (aceptable,
// solo obliga a volver a loguearse).
const sesiones = new Map();

function crearSesion(username) {
  const id = crypto.randomBytes(32).toString('hex');
  sesiones.set(id, { username, expira: Date.now() + SESSION_TTL_MS });
  return id;
}

function obtenerSesion(id) {
  const s = sesiones.get(id);
  if (!s) return null;
  if (Date.now() > s.expira) { sesiones.delete(id); return null; }
  return s;
}

function destruirSesion(id) {
  sesiones.delete(id);
}

function parseCookie(header, nombre) {
  if (!header) return null;
  const m = header.match(new RegExp('(?:^|;\\s*)' + nombre + '=([^;]+)'));
  return m ? m[1] : null;
}

// Middleware Express — exige sesión válida de monitoring, nada que ver con
// la sesión de negocio.
function requiereSesion(req, res, next) {
  const id = parseCookie(req.headers.cookie, SESSION_COOKIE);
  const sesion = id && obtenerSesion(id);
  if (!sesion) return res.status(401).json({ error: 'No autenticado' });
  req.monitoringUser = sesion.username;
  next();
}

module.exports = {
  SESSION_COOKIE,
  upsertUser,
  verificarLogin,
  crearSesion,
  obtenerSesion,
  destruirSesion,
  parseCookie,
  requiereSesion,
};
