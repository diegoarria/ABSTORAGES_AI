// ── WhatsApp de MARÍA (antes SARA) y SOFIA vía Kapso ────────────────────────
// Segunda vía de WhatsApp, independiente de Twilio (ver sendWhatsApp en
// server-lite.js). Kapso expone la Cloud API de Meta directamente, no una
// API propia de alto nivel como el Content API de Twilio.
// Un número por agente, igual que ya existe con Twilio (WA_NUMBERS en
// server-lite.js) — NUNCA se cruzan entre sí.
//
// Números conectados y verificados en Kapso (proyecto "Nuvos AI",
// diego.arria19@gmail.com):
//   SOFIA — +52 1 81 3590 9778 — phone_number_id 1433231719864226 (06-oct-2026)
//   MARÍA — +52 1 81 8685 8950 — phone_number_id 1457395780780302 (15-oct-2026, re-registrado tras borrar el número viejo de Twilio)
//           (antes "SARA" — renombrada a María Fernández en oct-2026; el identificador
//           técnico ahora es 'maria'. El env var nuevo es KAPSO_PHONE_NUMBER_ID_MARIA,
//           con KAPSO_PHONE_NUMBER_ID_SARA como respaldo mientras se renombra en Railway.)
//   NOA   — +52 1 81 3590 9641 — phone_number_id 1406980499159394 (15-oct-2026)
// Webhook único (/webhook/kapso en server-lite.js) registrado contra los tres
// números — el payload entrante trae su propio phone_number_id, con eso se
// decide a qué agente pertenece el mensaje (ver resolverAgente abajo).
const crypto = require('crypto');

const API_BASE   = 'https://api.kapso.ai';
const KAPSO_KEY  = process.env.KAPSO_API_KEY;
const WEBHOOK_SECRET = process.env.KAPSO_WEBHOOK_SECRET; // mismo secret para todos los números del proyecto

// phone_number_id por agente.
const PHONE_IDS = {
  sofia: process.env.KAPSO_PHONE_NUMBER_ID,       // ya existía, se mantiene el nombre del env var para no romper producción
  maria: process.env.KAPSO_PHONE_NUMBER_ID_MARIA || process.env.KAPSO_PHONE_NUMBER_ID_SARA,
  noa:   process.env.KAPSO_PHONE_NUMBER_ID_NOA,
};
const LIVE = !!KAPSO_KEY;

// A qué agente pertenece un phone_number_id entrante del webhook.
function resolverAgente(phoneNumberId) {
  const entrada = Object.entries(PHONE_IDS).find(([, id]) => id && id === String(phoneNumberId));
  return entrada ? entrada[0] : null;
}

async function enviarMensaje(to, texto, agente = 'sofia') {
  const destino = String(to || '').replace(/\D/g, '');
  if (!destino) return null;
  const phoneId = PHONE_IDS[agente === 'sara' ? 'maria' : agente]; // 'sara' = alias heredado de 'maria'
  if (!LIVE || !phoneId) {
    console.log(`[kapso STUB] (${agente}) → ${destino}: ${String(texto || '').slice(0, 80)}`);
    return { status: 'stub', to: destino };
  }
  const r = await fetch(`${API_BASE}/meta/whatsapp/v24.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KAPSO_KEY },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: destino,
      type: 'text',
      text: { body: String(texto || '') },
    }),
  });
  const resp = await r.text();
  if (!r.ok) throw new Error(`Kapso ${r.status}: ${resp.slice(0, 300)}`);
  return JSON.parse(resp);
}

// Verifica la firma HMAC-SHA256 del webhook contra el body crudo (sin
// parsear) — igual que validarFirmaTwilio en server-lite.js, el mismo
// motivo: nunca confiar en un POST a /webhook/kapso sin validar que de
// verdad viene de Kapso.
function verificarFirma(rawBody, firmaHeader) {
  if (!WEBHOOK_SECRET || !firmaHeader) return false;
  const esperada = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(firmaHeader));
  } catch {
    return false; // longitudes distintas u otro error de formato
  }
}

module.exports = { enviarMensaje, verificarFirma, resolverAgente, LIVE };
