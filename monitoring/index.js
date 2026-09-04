// ── Monitoring — proceso independiente ────────────────────────────────────────
// Se corre aparte del backend de negocio (otro servicio en Railway, otro
// `npm start`, lo que prefieras) — nunca se importa desde server-lite.js ni
// backend/server.js. Uso: node monitoring/index.js
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { correrHealthChecks } = require('./jobs/healthCheckCron');
const { correrSecurityScan } = require('./jobs/securityLogScanner');
const { analizar } = require('./jobs/incidentAnalyzer'); // se auto-registra en shared.js al cargarse

const MIN = 60 * 1000;

function correrYAgendar(nombre, fn, cadaMs) {
  const tick = () => fn().catch(e => console.error(`[monitoring] Error en ${nombre}:`, e.message));
  tick(); // primera corrida inmediata al arrancar, no esperar el primer intervalo
  setInterval(tick, cadaMs);
}

console.log('[monitoring] Arrancando — health-check cada 5min, security-scan cada 10min, analyzer cada 15min');
correrYAgendar('health-check-cron', correrHealthChecks, 5 * MIN);
correrYAgendar('security-log-scanner', correrSecurityScan, 10 * MIN);
correrYAgendar('incident-analyzer', analizar, 15 * MIN);

process.on('SIGTERM', () => { console.log('[monitoring] SIGTERM recibido, cerrando.'); process.exit(0); });
