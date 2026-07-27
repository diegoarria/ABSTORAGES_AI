// ── Aplica schema.sql contra DATABASE_URL — seguro de correr más de una vez ──
// Uso: node backend/db/migrate.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL no configurada — nada que migrar.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
});

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('[migrate] Aplicando schema.sql...');
  await pool.query(sql);
  console.log('[migrate] Listo.');
  await pool.end();
}

main().catch(e => {
  console.error('[migrate] Error:', e.message);
  process.exit(1);
});
