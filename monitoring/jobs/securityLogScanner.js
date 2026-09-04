// ── SECURITY-LOG-SCANNER — corre cada 10 min ──────────────────────────────────
// El plan original asumía Supabase Auth (auth.audit_log_entries) — este
// proyecto no usa Supabase, así que no existe ese log. Para no romper el
// aislamiento importando el sistema de sesiones de negocio, este scanner
// vigila únicamente señales que le pertenecen por completo a monitoring:
//
//   1. Fallas de autenticación repetidas CONTRA los servicios integrados
//      (401/403 en service_checks) — credenciales revocadas/mal configuradas
//      o alguien las cambió sin avisar.
//   2. Picos de rate-limit (429) contra esos mismos servicios.
//   3. Conexiones inesperadas a la propia base de datos de monitoring
//      (pg_stat_activity) — cualquier rol que no sea monitoring_service o
//      monitoring_admin conectado aquí es, por definición, alguien que no
//      debería tener estas credenciales.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../lib/db');
const { registrarSecurityEvent, analizarSiHayAlgoUrgente } = require('./shared');

const VENTANA = '10 minutes';
const ROLES_ESPERADOS = ['monitoring_service', 'monitoring_admin'];

async function escanearFallasDeAuth() {
  const { rows } = await pool.query(
    `SELECT service_name, status_code, COUNT(*) AS n
     FROM service_checks
     WHERE checked_at > NOW() - INTERVAL '${VENTANA}'
       AND status_code IN (401, 403, 429)
     GROUP BY service_name, status_code
     HAVING COUNT(*) >= 2`
  );

  for (const row of rows) {
    const esRateLimit = row.status_code === 429;
    const severidad = row.n >= 5 ? 'critical' : row.n >= 3 ? 'high' : 'medium';
    await registrarSecurityEvent({
      event_type: esRateLimit ? 'rate_limit_spike' : 'failed_login',
      severity: severidad,
      details: {
        servicio: row.service_name,
        status_code: row.status_code,
        ocurrencias: Number(row.n),
        ventana: VENTANA,
      },
    });
    if (severidad === 'high' || severidad === 'critical') analizarSiHayAlgoUrgente();
  }
}

async function escanearConexionesInesperadas() {
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT usename, client_addr, application_name, backend_start
       FROM pg_stat_activity
       WHERE datname = current_database()`
    ));
  } catch (e) {
    // pg_monitor no concedido, o el proveedor de Postgres restringe
    // pg_stat_activity — se degrada sin tronar el scanner.
    console.warn('[security-log-scanner] No se pudo leer pg_stat_activity:', e.message);
    return;
  }

  const inesperadas = rows.filter(r => r.usename && !ROLES_ESPERADOS.includes(r.usename));
  if (!inesperadas.length) return;

  await registrarSecurityEvent({
    event_type: 'unusual_access',
    severity: 'critical',
    source_ip: inesperadas[0].client_addr || null,
    details: {
      motivo: 'Conexión a la base de monitoring desde un rol no esperado',
      conexiones: inesperadas.map(r => ({ rol: r.usename, ip: r.client_addr, app: r.application_name })),
    },
  });
  analizarSiHayAlgoUrgente();
}

async function correrSecurityScan() {
  await Promise.allSettled([escanearFallasDeAuth(), escanearConexionesInesperadas()]);
}

module.exports = { correrSecurityScan };
