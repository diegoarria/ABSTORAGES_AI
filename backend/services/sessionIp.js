// ─── SESSION IPS — registra la IP de cada sesión que le escribe a cualquier
// IA (SARA, SOFIA, NOA, HÉCTOR), desde el primer mensaje, sin excepción.
// Igual que leads.js: memoria + disco (siempre) + Postgres (si hay DATABASE_URL,
// sobrevive redeploys). Nunca debe tirar la conversación si falla — todo va
// envuelto en try/catch.
const fs   = require('fs');
const path = require('path');
const { pool } = require('../db/db');

const FILE = path.join(__dirname, '../../data/session-ips.json');

function loadFromDisk() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return {};
}

const cache = loadFromDisk();

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(cache, null, 2)); }
    catch (e) { console.error('[sessionIp] Error guardando en disco:', e.message); }
  }, 1000);
}

let tableReady = !pool;
async function ensureTable() {
  if (tableReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS session_ips (
        session_id  TEXT PRIMARY KEY,
        agente      VARCHAR(10) NOT NULL,
        ip          TEXT,
        first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        mensajes    INT NOT NULL DEFAULT 0
      )
    `);
    tableReady = true;
  } catch (e) {
    console.error('[sessionIp] Error creando tabla session_ips:', e.message);
  }
}

// Se llama en cada mensaje entrante, antes que cualquier otra lógica —
// nunca debe bloquear ni tumbar el chat si algo falla.
async function registrar(sessionId, agente, ip) {
  if (!sessionId) return;
  const now = new Date().toISOString();

  const existing = cache[sessionId];
  if (existing) {
    existing.lastSeen = now;
    existing.mensajes = (existing.mensajes || 0) + 1;
    if (ip) existing.ip = ip;
  } else {
    cache[sessionId] = { agente, ip: ip || null, firstSeen: now, lastSeen: now, mensajes: 1 };
  }
  scheduleSave();

  if (!pool) return;
  try {
    await ensureTable();
    await pool.query(`
      INSERT INTO session_ips (session_id, agente, ip, first_seen, last_seen, mensajes)
      VALUES ($1, $2, $3, NOW(), NOW(), 1)
      ON CONFLICT (session_id) DO UPDATE SET
        ip        = COALESCE(EXCLUDED.ip, session_ips.ip),
        last_seen = NOW(),
        mensajes  = session_ips.mensajes + 1
    `, [sessionId, agente, ip || null]);
  } catch (e) {
    console.error('[sessionIp] Error guardando en DB:', e.message);
  }
}

async function obtener(sessionId) {
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT * FROM session_ips WHERE session_id = $1', [sessionId]);
      if (rows[0]) return rows[0];
    } catch (e) {
      console.error('[sessionIp] Error consultando DB:', e.message);
    }
  }
  return cache[sessionId] || null;
}

module.exports = { registrar, obtener };
