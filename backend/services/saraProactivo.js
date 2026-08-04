// ── Mensajes proactivos de SARA por WhatsApp — fuera de la ventana de 24h ────
// Igual que alertasStaff.js: WhatsApp Business exige plantilla aprobada por
// Meta para que SARA le escriba primero a un lead sin que él le haya escrito
// antes. Por eso se manda por Content API (ContentSid + variables), no texto
// libre. Plantillas creadas y enviadas a aprobación el 04-ago-2026:
//   abstorages_sara_seguimiento_lead → HX74e936db4d3c50c0acc37a95e66f16e3
//   abstorages_sara_cotizacion       → HXdfa3e32db45810b122cd6e285e6c8ae5
//   abstorages_sara_venta_cerrada    → HX8e4037d3e3ee6464d663c3994a765e07
require('dotenv').config();

const TWILIO_SID     = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA_FROM = (process.env.TWILIO_WHATSAPP_NUMBER_SARA || '').replace(/^whatsapp:/, '');
const WA_LIVE = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_WA_FROM);

const CONTENT_SID_SEGUIMIENTO_LEAD = 'HX74e936db4d3c50c0acc37a95e66f16e3';
const CONTENT_SID_COTIZACION       = 'HXdfa3e32db45810b122cd6e285e6c8ae5';
const CONTENT_SID_VENTA_CERRADA    = 'HX8e4037d3e3ee6464d663c3994a765e07';

async function enviarPlantilla(to, contentSid, variables) {
  if (!WA_LIVE) {
    console.log(`[saraProactivo STUB] → ${to}: ${contentSid} ${JSON.stringify(variables)}`);
    return { status: 'stub', to };
  }
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const body = new URLSearchParams({
    From: `whatsapp:${TWILIO_WA_FROM}`,
    To:   `whatsapp:${to.replace(/^whatsapp:/, '')}`,
    ContentSid: contentSid,
    ContentVariables: JSON.stringify(variables),
  });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
    body,
  });
  const resp = await r.text();
  if (!r.ok) throw new Error(`Twilio ${r.status}: ${resp.slice(0, 300)}`);
  return JSON.parse(resp);
}

function telefonoValido(t) {
  return t && t !== '—' && /\d{8,}/.test(t);
}

async function enviarSeguimientoLead(telefono, nombre, resumenSolicitud) {
  if (!telefonoValido(telefono)) return null;
  console.log(`[saraProactivo] Seguimiento de lead → ${telefono}`);
  return enviarPlantilla(telefono, CONTENT_SID_SEGUIMIENTO_LEAD, {
    '1': nombre || 'ahí',
    '2': resumenSolicitud || 'tu solicitud de flete',
  });
}

async function enviarCotizacion(telefono, nombre, ruta, precio) {
  if (!telefonoValido(telefono)) return null;
  console.log(`[saraProactivo] Cotización → ${telefono}`);
  return enviarPlantilla(telefono, CONTENT_SID_COTIZACION, {
    '1': nombre || 'ahí',
    '2': ruta || 'tu ruta',
    '3': precio || 'consulta el detalle con SARA',
  });
}

async function enviarConfirmacionVenta(telefono, nombre, folio) {
  if (!telefonoValido(telefono)) return null;
  console.log(`[saraProactivo] Confirmación de venta → ${telefono} — folio ${folio}`);
  return enviarPlantilla(telefono, CONTENT_SID_VENTA_CERRADA, {
    '1': nombre || 'ahí',
    '2': folio || '—',
  });
}

module.exports = { enviarSeguimientoLead, enviarCotizacion, enviarConfirmacionVenta };
