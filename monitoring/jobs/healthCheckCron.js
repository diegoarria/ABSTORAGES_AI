// ── HEALTH-CHECK-CRON — pinga cada servicio integrado cada 5 min ─────────────
// Adaptado del plan original (Supabase Edge Function + pg_cron) a un job de
// Node de larga duración — ver monitoring/index.js para cómo se agenda.
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { pool } = require('../lib/db');
const { registrarSecurityEvent, analizarSiHayAlgoUrgente } = require('./shared');

const TIMEOUT_MS = 8000;

async function fetchConTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Cada checker regresa { status_code, raw } — el status (ok/degraded/down) y
// la latencia se calculan afuera, uniforme para todos.
const CHECKERS = {
  claude: async () => {
    const r = await fetchConTimeout('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
    });
    return { status_code: r.status, raw: { ok: r.ok } };
  },
  vapi: async () => {
    if (!process.env.VAPI_API_KEY) return { status_code: null, raw: { skipped: 'VAPI_API_KEY no configurada' } };
    const r = await fetchConTimeout(process.env.HEALTH_CHECK_URL_VAPI || 'https://api.vapi.ai/assistant', {
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
    });
    return { status_code: r.status, raw: { ok: r.ok } };
  },
  elevenlabs: async () => {
    if (!process.env.ELEVENLABS_API_KEY) return { status_code: null, raw: { skipped: 'ELEVENLABS_API_KEY no configurada' } };
    const r = await fetchConTimeout(process.env.HEALTH_CHECK_URL_ELEVENLABS || 'https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    });
    return { status_code: r.status, raw: { ok: r.ok } };
  },
  whatsapp: async () => { // Twilio — el WhatsApp real de este proyecto, no 360dialog
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      return { status_code: null, raw: { skipped: 'Credenciales de Twilio no configuradas' } };
    }
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const r = await fetchConTimeout(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}.json`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    return { status_code: r.status, raw: { ok: r.ok } };
  },
  cliengo: async () => {
    // Este proyecto no tiene integración de API con Cliengo (es un widget de
    // JS embebido en WordPress, sin credenciales de servidor) — esto es un
    // chequeo de disponibilidad best-effort, no una llamada autenticada real.
    const r = await fetchConTimeout(process.env.CLIENGO_HEALTH_URL || 'https://api.cliengo.com');
    return { status_code: r.status, raw: { ok: true, nota: 'chequeo de disponibilidad, sin auth — no hay integración de API con Cliengo en este proyecto' } };
  },
};

// Consecutivos por servicio — en memoria, vive mientras el proceso vive.
const fallosConsecutivos = {};

function clasificarStatus(statusCode) {
  if (statusCode == null) return 'degraded'; // no configurado / no se pudo checar
  if (statusCode >= 200 && statusCode < 400) return 'ok';
  if (statusCode === 429) return 'degraded';
  return 'down';
}

async function checarServicio(nombre, checker) {
  const inicio = Date.now();
  let statusCode = null, raw = {}, error = null;
  try {
    const r = await checker();
    statusCode = r.status_code;
    raw = r.raw;
  } catch (e) {
    error = e.message;
    raw = { error: e.message };
  }
  const latencia = Date.now() - inicio;
  const status = error ? 'down' : clasificarStatus(statusCode);

  await pool.query(
    `INSERT INTO service_checks (service_name, status, latency_ms, status_code, raw_response)
     VALUES ($1, $2, $3, $4, $5)`,
    [nombre, status, latencia, statusCode, JSON.stringify(raw)]
  );

  if (status === 'down') {
    fallosConsecutivos[nombre] = (fallosConsecutivos[nombre] || 0) + 1;
    if (fallosConsecutivos[nombre] === 2) {
      await registrarSecurityEvent({
        event_type: 'other',
        severity: 'high',
        details: { service: nombre, motivo: 'Fallas consecutivas de health-check', ultimo_error: error, status_code: statusCode },
      });
      analizarSiHayAlgoUrgente(); // dispara el analizador de inmediato, no espera los 15 min
    }
  } else {
    fallosConsecutivos[nombre] = 0;
  }

  console.log(`[health-check] ${nombre}: ${status} (${latencia}ms, HTTP ${statusCode ?? '—'})`);
}

async function correrHealthChecks() {
  const resultados = await Promise.allSettled(
    Object.entries(CHECKERS).map(([nombre, checker]) => checarServicio(nombre, checker))
  );
  // allSettled traga los errores por diseño — sin esto, un fallo real (ej. de
  // permisos en la base) se pierde en silencio y parece que "no pasó nada".
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      const nombre = Object.keys(CHECKERS)[i];
      console.error(`[health-check] ${nombre} falló por completo (no se guardó ningún check):`, r.reason?.message || r.reason);
    }
  });
}

module.exports = { correrHealthChecks };
