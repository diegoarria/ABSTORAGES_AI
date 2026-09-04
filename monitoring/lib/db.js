// ── Conexión aislada a la base de monitoring — usa MONITORING_SERVICE_DATABASE_URL,
// nunca DATABASE_URL (esa es la de SARA/SOFIA/NOA). Rol de bajo privilegio,
// no superusuario — ver monitoring/db/roles.sql.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');

if (!process.env.MONITORING_SERVICE_DATABASE_URL) {
  throw new Error('MONITORING_SERVICE_DATABASE_URL no configurada — ver monitoring/README.md');
}

const pool = new Pool({
  connectionString: process.env.MONITORING_SERVICE_DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.MONITORING_SERVICE_DATABASE_URL) ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => console.error('[monitoring/db] Error inesperado en el pool:', err.message));

module.exports = { pool };
