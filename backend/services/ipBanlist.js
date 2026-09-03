// ─── IP BANLIST — bloqueo permanente por IP ──────────────────────────────────
// Por instrucción directa de Diego: si alguien intenta sacarle a SARA/SOFIA/NOA
// su proceso/metodología/reglas internas (ver promptLeakGuard.js), esa IP queda
// baneada para siempre — nunca más puede volver a abrir el chat con ninguna de
// las 3 IA, en ningún canal. Memoria + disco (siempre) + Postgres (sobrevive
// redeploys) — igual patrón que sessionIp.js y leads.js.
const fs   = require('fs');
const path = require('path');
const { pool } = require('../db/db');

const FILE = path.join(__dirname, '../../data/ip-banlist.json');

function loadFromDisk() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return {};
}

// Set en memoria para chequeo instantáneo y síncrono en cada mensaje —
// nunca debe frenar el chat esperando una consulta a la DB.
const cache = loadFromDisk(); // { [ip]: { motivo, agente, sessionId, bannedAt } }

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(cache, null, 2)); }
    catch (e) { console.error('[ipBanlist] Error guardando en disco:', e.message); }
  }, 1000);
}

let tableReady = !pool;
async function ensureTable() {
  if (tableReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ip_banlist (
        ip         TEXT PRIMARY KEY,
        motivo     TEXT,
        agente     VARCHAR(10),
        session_id TEXT,
        banned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    tableReady = true;
  } catch (e) {
    console.error('[ipBanlist] Error creando tabla ip_banlist:', e.message);
  }
}

// Precarga desde Postgres al arrancar — el archivo en disco ya cubre el hueco
// mientras esto resuelve, pero así el ban sobrevive aunque el disco del
// contenedor se haya reseteado con el redeploy.
(async () => {
  if (!pool) return;
  try {
    await ensureTable();
    const { rows } = await pool.query('SELECT * FROM ip_banlist');
    rows.forEach(r => {
      cache[r.ip] = { motivo: r.motivo, agente: r.agente, sessionId: r.session_id, bannedAt: r.banned_at };
    });
    if (rows.length) scheduleSave();
  } catch (e) {
    console.error('[ipBanlist] Error precargando desde DB:', e.message);
  }
})();

function estaBaneada(ip) {
  if (!ip) return false;
  return Boolean(cache[ip]);
}

async function banear({ ip, motivo, agente, sessionId }) {
  if (!ip) return;
  if (cache[ip]) return; // ya estaba baneada, no hay nada que actualizar

  cache[ip] = { motivo, agente, sessionId, bannedAt: new Date().toISOString() };
  scheduleSave();
  console.log(`[ipBanlist] IP ${ip} baneada permanentemente — motivo: ${motivo}`);

  if (!pool) return;
  try {
    await ensureTable();
    await pool.query(`
      INSERT INTO ip_banlist (ip, motivo, agente, session_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (ip) DO NOTHING
    `, [ip, motivo || null, agente || null, sessionId || null]);
  } catch (e) {
    console.error('[ipBanlist] Error guardando en DB:', e.message);
  }
}

function listar() {
  return Object.entries(cache).map(([ip, datos]) => ({ ip, ...datos }));
}

module.exports = { estaBaneada, banear, listar };
