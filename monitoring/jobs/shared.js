// ── Helpers compartidos entre los 3 jobs ──────────────────────────────────────
const { pool } = require('../lib/db');

async function registrarSecurityEvent({ event_type, severity, source_ip = null, details = {} }) {
  await pool.query(
    `INSERT INTO security_events (event_type, severity, source_ip, details)
     VALUES ($1, $2, $3, $4)`,
    [event_type, severity, source_ip, JSON.stringify(details)]
  );
  console.warn(`[security-event] ${event_type} (${severity})`, details);
}

// Referencia diferida a incidentAnalyzer — evita import circular (analyzer no
// necesita llamar a shared, pero shared sí necesita disparar al analyzer
// cuando algo urgente pasa, sin esperar su intervalo normal de 15 min).
let _analizarAhora = null;
function registrarAnalizador(fn) { _analizarAhora = fn; }
function analizarSiHayAlgoUrgente() {
  if (_analizarAhora) _analizarAhora().catch(e => console.error('[shared] Error en análisis disparado por evento urgente:', e.message));
}

module.exports = { registrarSecurityEvent, registrarAnalizador, analizarSiHayAlgoUrgente };
