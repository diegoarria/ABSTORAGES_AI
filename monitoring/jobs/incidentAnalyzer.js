// ── INCIDENT-ANALYZER — corre cada 15 min, o al instante si un evento urgente
// lo dispara (ver shared.js / analizarSiHayAlgoUrgente) ──────────────────────
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../lib/db');
const { enviarAlertaWhatsApp } = require('../lib/whatsapp');
const { registrarAnalizador } = require('./shared');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Ventana desde la última corrida — evita reprocesar los mismos eventos en
// cada ejecución (a diferencia de una ventana fija, que los duplicaría).
let desde = new Date(Date.now() - 15 * 60 * 1000);

async function juntarSenales(ventanaDesde) {
  const [checks, eventos] = await Promise.all([
    pool.query(
      `SELECT id, service_name, status, latency_ms, status_code, checked_at
       FROM service_checks
       WHERE checked_at > $1 AND status IN ('down', 'degraded')
       ORDER BY checked_at DESC`,
      [ventanaDesde]
    ),
    pool.query(
      `SELECT id, event_type, severity, source_ip, details, detected_at
       FROM security_events
       WHERE detected_at > $1
       ORDER BY detected_at DESC`,
      [ventanaDesde]
    ),
  ]);
  return { checks: checks.rows, eventos: eventos.rows };
}

function severidadNumerica(s) {
  return { low: 1, medium: 2, high: 3, critical: 4 }[s] || 0;
}

async function clasificarConClaude(checks, eventos) {
  const prompt = `Eres el analista técnico de un sistema de monitoreo 24/7 para una empresa de logística (ABSTORAGES). Recibiste estas señales de la última ventana de tiempo:

SERVICE CHECKS CON PROBLEMAS:
${checks.length ? JSON.stringify(checks, null, 2) : '(ninguno)'}

EVENTOS DE SEGURIDAD:
${eventos.length ? JSON.stringify(eventos, null, 2) : '(ninguno)'}

Clasifica la severidad GLOBAL de este conjunto (low, medium, high o critical) y redacta un resumen accionable en español, de 3 a 5 líneas, dirigido a la persona técnica que va a atenderlo — directo, sin relleno, mencionando qué pasó y qué revisar primero.

Responde ÚNICAMENTE con este JSON, sin texto adicional ni bloque de código:
{"severity": "...", "summary": "..."}`;

  // Un sistema de monitoreo no se puede caer solo porque Claude (uno de los
  // servicios que él mismo vigila) esté caído, sin cuota, o tarde en
  // responder — por eso TODO lo que dependa de la API, no solo el parseo del
  // JSON, cae al mismo respaldo determinístico si algo sale mal.
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const texto = msg.content?.[0]?.text?.trim() || '{}';
    const parsed = JSON.parse(texto);
    if (!['low', 'medium', 'high', 'critical'].includes(parsed.severity)) throw new Error('severity inválida');
    return parsed;
  } catch (e) {
    console.error('[incident-analyzer] Claude no disponible o no regresó JSON válido, degradando a clasificación local:', e.message);
    return clasificacionDeRespaldo(checks, eventos, resumirMotivoFalla(e));
  }
}

// El mensaje crudo de la API (JSON con comillas, dos puntos, guiones bajos)
// se ve feo en WhatsApp y algunos caracteres pueden confundir el renderizado
// de formato de WhatsApp (_texto_ = itálicas) — mejor una razón corta y humana.
function resumirMotivoFalla(e) {
  const msg = e?.message || '';
  if (e?.status === 429 || /usage limits|rate limit/i.test(msg)) return 'límite de uso de la API alcanzado';
  if (e?.status === 401 || /authentication|invalid.*api.?key/i.test(msg)) return 'error de autenticación con la API';
  if (e?.status >= 500) return 'la API de Claude está caída';
  if (/severity inválida/i.test(msg)) return 'respuesta en formato inesperado';
  return 'no disponible';
}

function clasificacionDeRespaldo(checks, eventos, motivoFalla) {
  const peorEvento = eventos.reduce((max, e) => Math.max(max, severidadNumerica(e.severity)), 0);
  const hayDown = checks.some(c => c.status === 'down');
  const severity = hayDown || peorEvento >= 4 ? 'critical' : peorEvento === 3 ? 'high' : checks.length || eventos.length ? 'medium' : 'low';
  return {
    severity,
    summary: `Análisis automático de respaldo — Claude no estuvo disponible para redactar el resumen (${motivoFalla}). ${checks.length} chequeo(s) con problemas, ${eventos.length} evento(s) de seguridad en esta ventana. Revisar incidents/security_events directamente.`,
  };
}

async function analizar() {
  const ventanaDesde = desde;
  desde = new Date(); // siguiente corrida solo ve lo nuevo desde ahora

  const { checks, eventos } = await juntarSenales(ventanaDesde);
  if (!checks.length && !eventos.length) return; // nada que reportar, no gastar una llamada a Claude

  const { severity, summary } = await clasificarConClaude(checks, eventos);
  const relatedIds = eventos.map(e => e.id);

  const { rows } = await pool.query(
    `INSERT INTO incidents (severity, summary_text, related_event_ids)
     VALUES ($1, $2, $3) RETURNING id`,
    [severity, summary, relatedIds]
  );
  const incidentId = rows[0].id;
  console.log(`[incident-analyzer] Incidente ${incidentId} creado — severidad ${severity}`);

  if (severity === 'high' || severity === 'critical') {
    const textoAlerta = `🚨 ABSTORAGES Monitoring [${severity.toUpperCase()}]\n\n${summary}`;
    const resultado = await enviarAlertaWhatsApp(textoAlerta);
    await pool.query(
      `INSERT INTO alert_log (incident_id, channel, delivery_status) VALUES ($1, 'whatsapp', $2)`,
      [incidentId, resultado.ok ? 'sent' : 'failed']
    );
    if (!resultado.ok) console.error('[incident-analyzer] Falló el envío de alerta:', resultado.error);
  }
}

registrarAnalizador(analizar); // permite que health-check/security-scanner disparen esto sin esperar el cron

module.exports = { analizar };
