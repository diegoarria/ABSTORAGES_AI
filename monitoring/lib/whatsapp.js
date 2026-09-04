// ── Envío de alertas por WhatsApp — reimplementación propia con Twilio,
// aislada a propósito (no importa backend/services/* de negocio).
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const SID   = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TO    = process.env.ALERT_WHATSAPP_TO;

async function enviarAlertaWhatsApp(texto) {
  if (!SID || !TOKEN || !TO) {
    console.warn('[monitoring/whatsapp] Faltan credenciales o número destino — alerta no enviada.');
    return { ok: false, error: 'Credenciales o ALERT_WHATSAPP_TO faltantes' };
  }

  const auth = Buffer.from(`${SID}:${TOKEN}`).toString('base64');
  const body = new URLSearchParams({
    From: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER || ''}`,
    To: `whatsapp:${TO}`,
    Body: texto,
  });

  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data.message || `HTTP ${r.status}` };
    return { ok: true, sid: data.sid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { enviarAlertaWhatsApp };
