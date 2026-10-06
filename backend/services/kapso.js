// ── WhatsApp de SOFIA vía Kapso (número +52 1 81 3590 9778) ──────────────────
// Segunda vía de WhatsApp, independiente de Twilio (ver sendWhatsApp en
// server-lite.js, que hoy maneja el número de Twilio de SARA/SOFIA). Este
// número nuevo es específicamente el de SOFIA — no reemplaza el de SARA.
// Kapso expone la Cloud API de Meta directamente, no una API propia de alto
// nivel como el Content API de Twilio.
// Setup hecho el 06-oct-2026: número conectado y verificado en Kapso
// (status CONNECTED, code_verification_status VERIFIED), login de CLI hecho
// como diego.arria19@gmail.com, proyecto "Nuvos AI". Webhook de recepción
// AÚN NO registrado contra este servidor (falta correr
// `kapso whatsapp webhooks new --url <url pública>/webhook/kapso
// --phone-number-id 1433231719864226 --event whatsapp.message.received
// --active` una vez que haya una URL pública estable).
// Este archivo solo trae la plomería (enviar + verificar firma de entrada);
// todavía NO está conectado a la lógica de SOFIA (ver webhook en
// server-lite.js) — ese cableado es un paso aparte, a propósito, para no
// tocar el flujo de Twilio que ya está en producción. Cuando se conecte,
// debe mapear este número SOLO al agente 'sofia' (igual que WA_NUMBERS.sofia
// en server-lite.js), nunca a SARA.
const crypto = require('crypto');

const API_BASE   = 'https://api.kapso.ai';
const KAPSO_KEY  = process.env.KAPSO_API_KEY;
const PHONE_ID   = process.env.KAPSO_PHONE_NUMBER_ID;
const WEBHOOK_SECRET = process.env.KAPSO_WEBHOOK_SECRET; // se define al crear el webhook (--secret-key)
const LIVE = !!(KAPSO_KEY && PHONE_ID);

async function enviarMensaje(to, texto) {
  const destino = String(to || '').replace(/\D/g, '');
  if (!destino) return null;
  if (!LIVE) {
    console.log(`[kapso STUB] → ${destino}: ${String(texto || '').slice(0, 80)}`);
    return { status: 'stub', to: destino };
  }
  const r = await fetch(`${API_BASE}/meta/whatsapp/v24.0/${PHONE_ID}/messages`, {
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

module.exports = { enviarMensaje, verificarFirma, LIVE };
