// ─── PHONE BANLIST — bloqueo permanente por número de WhatsApp ───────────────
// Mismo concepto que ipBanlist.js pero para el canal de WhatsApp, donde no
// hay IP — si un número manda por WhatsApp cualquiera de las frases que
// promptLeakGuard detecta, ese número queda baneado para siempre en las 3 IA.
const fs   = require('fs');
const path = require('path');
const { pool } = require('../db/db');

const FILE = path.join(__dirname, '../../data/phone-banlist.json');

function normalizar(telefono) {
  return String(telefono || '').replace(/\D/g, '').slice(-10);
}

function loadFromDisk() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return {};
}

const cache = loadFromDisk(); // { [telefonoNormalizado]: { motivo, agente, bannedAt } }

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(cache, null, 2)); }
    catch (e) { console.error('[phoneBanlist] Error guardando en disco:', e.message); }
  }, 1000);
}

let tableReady = !pool;
async function ensureTable() {
  if (tableReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS phone_banlist (
        telefono   TEXT PRIMARY KEY,
        motivo     TEXT,
        agente     VARCHAR(10),
        banned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    tableReady = true;
  } catch (e) {
    console.error('[phoneBanlist] Error creando tabla phone_banlist:', e.message);
  }
}

(async () => {
  if (!pool) return;
  try {
    await ensureTable();
    const { rows } = await pool.query('SELECT * FROM phone_banlist');
    rows.forEach(r => { cache[r.telefono] = { motivo: r.motivo, agente: r.agente, bannedAt: r.banned_at }; });
    if (rows.length) scheduleSave();
  } catch (e) {
    console.error('[phoneBanlist] Error precargando desde DB:', e.message);
  }
})();

function estaBaneado(telefono) {
  const t = normalizar(telefono);
  if (!t) return false;
  return Boolean(cache[t]);
}

async function banear({ telefono, motivo, agente }) {
  const t = normalizar(telefono);
  if (!t) return;
  if (cache[t]) return;

  cache[t] = { motivo, agente, bannedAt: new Date().toISOString() };
  scheduleSave();
  console.log(`[phoneBanlist] Teléfono ${t} baneado permanentemente — motivo: ${motivo}`);

  if (!pool) return;
  try {
    await ensureTable();
    await pool.query(`
      INSERT INTO phone_banlist (telefono, motivo, agente)
      VALUES ($1, $2, $3)
      ON CONFLICT (telefono) DO NOTHING
    `, [t, motivo || null, agente || null]);
  } catch (e) {
    console.error('[phoneBanlist] Error guardando en DB:', e.message);
  }
}

function listar() {
  return Object.entries(cache).map(([telefono, datos]) => ({ telefono, ...datos }));
}

module.exports = { estaBaneado, banear, listar, normalizar };
