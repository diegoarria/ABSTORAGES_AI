// ── Aplica monitoring/db/schema.sql contra MONITORING_OWNER_DATABASE_URL ────
// Usa las credenciales DUEÑAS de la base dedicada de monitoring (las mismas
// con las que corriste roles.sql) — monitoring_service/monitoring_admin no
// tienen privilegios para crear tablas ni políticas, solo para usarlas.
// Uso: node monitoring/db/migrate.js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.MONITORING_OWNER_DATABASE_URL) {
  console.error('MONITORING_OWNER_DATABASE_URL no configurada — nada que migrar.');
  console.error('¿Ya corriste roles.sql y pusiste la connection string del dueño de la base en monitoring/.env?');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.MONITORING_OWNER_DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.MONITORING_OWNER_DATABASE_URL) ? false : { rejectUnauthorized: false },
});

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('[monitoring migrate] Aplicando schema.sql...');
  await pool.query(sql);
  console.log('[monitoring migrate] Listo.');
  await pool.end();
}

main().catch(e => {
  console.error('[monitoring migrate] Error:', e.message);
  process.exit(1);
});
