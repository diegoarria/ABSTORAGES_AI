// ─── EMERGENCY SHUTDOWN — interruptor de apagado total de SARA/SOFIA/NOA ────
// A diferencia de MANTENIMIENTO_HASTA (server-lite.js, fecha fija en código —
// requiere editar y desplegar), esto es un switch que se prende/apaga en
// caliente, sin redeploy, para un ataque en curso donde cada minuto cuenta.
// Memoria + disco + Postgres — mismo patrón que ipBanlist/phoneBanlist.
const fs   = require('fs');
const path = require('path');
const { pool } = require('../db/db');

const FILE = path.join(__dirname, '../../data/emergency-shutdown.json');

function loadFromDisk() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return { activo: false };
}

// Chequeo síncrono en cada mensaje — nunca debe esperar una consulta a la DB.
let estado = loadFromDisk(); // { activo, motivo, activadoPor, activadoEn }

function guardarEnDisco() {
  try { fs.writeFileSync(FILE, JSON.stringify(estado, null, 2)); }
  catch (e) { console.error('[emergencyShutdown] Error guardando en disco:', e.message); }
}

let tableReady = !pool;
async function ensureTable() {
  if (tableReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS emergency_shutdown (
        id           INT PRIMARY KEY DEFAULT 1,
        activo       BOOLEAN NOT NULL DEFAULT FALSE,
        motivo       TEXT,
        activado_por TEXT,
        activado_en  TIMESTAMPTZ,
        CHECK (id = 1)
      )
    `);
    await pool.query(`INSERT INTO emergency_shutdown (id, activo) VALUES (1, false) ON CONFLICT (id) DO NOTHING`);
    tableReady = true;
  } catch (e) {
    console.error('[emergencyShutdown] Error creando tabla:', e.message);
  }
}

// Precarga desde Postgres al arrancar — sobrevive redeploys aunque el disco
// del contenedor se resetee sin volumen.
(async () => {
  if (!pool) return;
  try {
    await ensureTable();
    const { rows } = await pool.query('SELECT * FROM emergency_shutdown WHERE id = 1');
    if (rows[0]) {
      estado = { activo: rows[0].activo, motivo: rows[0].motivo, activadoPor: rows[0].activado_por, activadoEn: rows[0].activado_en };
      guardarEnDisco();
    }
  } catch (e) {
    console.error('[emergencyShutdown] Error precargando desde DB:', e.message);
  }
})();

function estaActivo() {
  return Boolean(estado.activo);
}

function obtenerEstado() {
  return { ...estado };
}

async function activar({ motivo, activadoPor }) {
  estado = { activo: true, motivo: motivo || 'Sin motivo especificado', activadoPor: activadoPor || 'desconocido', activadoEn: new Date().toISOString() };
  guardarEnDisco();
  console.warn(`[emergencyShutdown] 🔴 ACTIVADO por ${estado.activadoPor} — motivo: ${estado.motivo}`);

  if (!pool) return;
  try {
    await ensureTable();
    await pool.query(
      `UPDATE emergency_shutdown SET activo = true, motivo = $1, activado_por = $2, activado_en = NOW() WHERE id = 1`,
      [estado.motivo, estado.activadoPor]
    );
  } catch (e) {
    console.error('[emergencyShutdown] Error guardando activación en DB:', e.message);
  }
}

async function desactivar({ desactivadoPor }) {
  estado = { activo: false, motivo: null, activadoPor: null, activadoEn: null };
  guardarEnDisco();
  console.log(`[emergencyShutdown] 🟢 Desactivado por ${desactivadoPor || 'desconocido'}`);

  if (!pool) return;
  try {
    await ensureTable();
    await pool.query(`UPDATE emergency_shutdown SET activo = false, motivo = NULL, activado_por = NULL, activado_en = NULL WHERE id = 1`);
  } catch (e) {
    console.error('[emergencyShutdown] Error guardando desactivación en DB:', e.message);
  }
}

module.exports = { estaActivo, obtenerEstado, activar, desactivar };
