// ── Conexión del panel admin — usa MONITORING_ADMIN_DATABASE_URL (rol
// monitoring_admin: solo lectura + UPDATE acotado a resolved/resolved_at en
// incidents, forzado por RLS real — ver monitoring/db/schema.sql). Nunca la
// de monitoring_service (esa es solo para los jobs) ni DATABASE_URL.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');

if (!process.env.MONITORING_ADMIN_DATABASE_URL) {
  throw new Error('MONITORING_ADMIN_DATABASE_URL no configurada — ver monitoring/README.md');
}

const pool = new Pool({
  connectionString: process.env.MONITORING_ADMIN_DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.MONITORING_ADMIN_DATABASE_URL) ? false : { rejectUnauthorized: false },
});

module.exports = { pool };
