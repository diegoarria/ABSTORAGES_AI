// Conexión PostgreSQL — solo activa cuando DATABASE_URL está en el entorno
const { Pool } = require('pg');

let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id              TEXT PRIMARY KEY,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      nombre          TEXT,
      empresa         TEXT,
      rfc             TEXT,
      telefono        TEXT,
      email           TEXT,
      origen          TEXT,
      destino         TEXT,
      tipo_carga      TEXT,
      tipo_unidad     TEXT,
      peso_toneladas  TEXT,
      precio_cotizado TEXT,
      folio           TEXT,
      intent          TEXT,
      sara_nota       TEXT,
      primer_mensaje  TEXT,
      resumen         TEXT,
      session_id      TEXT,
      webhook_status  TEXT DEFAULT 'sent'
    )
  `).then(() => console.log('[DB] Tabla leads lista'))
    .catch(e => console.error('[DB] Error creando tabla:', e.message));
}

module.exports = { pool };
