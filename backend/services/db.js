// Conexión PostgreSQL — solo activa cuando DATABASE_URL está en el entorno
let pool = null;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
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
      session_id      TEXT UNIQUE,
      webhook_status  TEXT DEFAULT 'sent'
    )
  `).then(() => pool.query(`
    CREATE INDEX IF NOT EXISTS leads_session_idx ON leads(session_id);
    CREATE INDEX IF NOT EXISTS leads_created_idx ON leads(created_at DESC);
  `))
   .then(() => pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      session_id TEXT        NOT NULL,
      agente     TEXT        NOT NULL DEFAULT 'sara',
      role       TEXT        NOT NULL,
      content    TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `))
   .then(() => pool.query(`
    CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id, created_at);
  `))
   .then(() => console.log('[DB] Tablas leads + messages listas'))
   .catch(e => console.error('[DB] Error creando tabla:', e.message));
}

async function saveMessage(session_id, agente, role, content) {
  if (!pool) return;
  pool.query(
    'INSERT INTO messages (session_id, agente, role, content) VALUES ($1,$2,$3,$4)',
    [session_id, agente, role, content]
  ).catch(e => console.error('[DB] saveMessage error:', e.message));
}

async function getMessages(session_id) {
  if (!pool || !session_id) return [];
  try {
    const { rows } = await pool.query(
      'SELECT role, content, created_at FROM messages WHERE session_id = $1 ORDER BY created_at ASC',
      [session_id]
    );
    return rows;
  } catch(e) {
    console.error('[DB] getMessages error:', e.message);
    return [];
  }
}

module.exports = { pool, saveMessage, getMessages };
