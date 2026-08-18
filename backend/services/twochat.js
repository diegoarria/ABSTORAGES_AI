// ── 2Chat — WhatsApp Web API (grupos) ─────────────────────────────────────────
// A diferencia de Twilio (WhatsApp Business Platform, sin soporte de grupos),
// 2Chat automatiza una sesión de WhatsApp Web normal — por eso SÍ puede entrar
// a grupos. Se usa solo para el MVP de "ABSTORAGES IA - TEST", números aparte
// de los de producción (Twilio) para no arriesgarlos.
require('dotenv').config();

const API_KEY  = process.env.TWOCHAT_API_KEY;
const BASE_URL = 'https://api.p.2chat.io/open/whatsapp';
const LIVE = !!API_KEY;

async function llamar(path, { method = 'GET', body } = {}) {
  if (!LIVE) throw new Error('TWOCHAT_API_KEY no configurada');
  // path absoluto (empieza con https://) para endpoints fuera de /open/whatsapp,
  // como los de suscripción de webhooks (/open/webhooks/...).
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'X-User-API-Key': API_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`2Chat ${method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
  return data;
}

// ── Canales (números conectados) ──────────────────────────────────────────────
function listarNumeros() {
  return llamar('/get-numbers');
}

function crearCanal(phone_number, friendly_name) {
  return llamar('/channel/create', { method: 'POST', body: { phone_number, friendly_name } });
}

function conectarCanal(uuid) {
  return llamar(`/channel/${uuid}/connect`, { method: 'POST', body: {} });
}

function desconectarCanal(uuid) {
  return llamar(`/channel/${uuid}/disconnect`, { method: 'POST', body: {} });
}

function obtenerQr(uuid) {
  return llamar(`/channel/${uuid}/qr-code`);
}

// url debe ser una imagen accesible públicamente (2Chat la descarga desde
// ahí) — usamos /img/*.png de la plataforma, servido antes del middleware
// de auth. url: null quita la foto de perfil.
function setFotoPerfil(fromNumber, url) {
  return llamar(`/set-profile-picture/${encodeURIComponent(fromNumber)}`, {
    method: 'POST',
    body: { url },
  });
}

// ── Webhooks ───────────────────────────────────────────────────────────────────
// evento ej. 'whatsapp.group.message.received'; groupUuid opcional filtra solo
// ese grupo (si no, "any").
function suscribirWebhook(evento, onNumber, hookUrl, groupUuid) {
  return llamar(`https://api.p.2chat.io/open/webhooks/subscribe/${evento}`, {
    method: 'POST',
    body: { hook_url: hookUrl, on_number: onNumber, ...(groupUuid ? { to_group_uuid: groupUuid } : {}) },
  });
}

// ── Grupos ─────────────────────────────────────────────────────────────────────
function listarGrupos(phoneNumber) {
  return llamar(`/groups/${encodeURIComponent(phoneNumber)}`);
}

// ── Mensajes ───────────────────────────────────────────────────────────────────
async function enviarMensajeGrupo(fromNumber, groupUuid, texto) {
  if (!LIVE) {
    console.log(`[2Chat STUB] → grupo ${groupUuid}: ${texto.slice(0, 80)}`);
    return { success: true, stub: true };
  }
  return llamar('/send-message', {
    method: 'POST',
    body: { from_number: fromNumber, to_group_uuid: groupUuid, text: texto },
  });
}

// Mensaje 1:1 — nunca junto con to_group_uuid en la misma llamada (la API
// de 2Chat los trata como mutuamente excluyentes).
async function enviarMensaje(fromNumber, toNumber, texto) {
  if (!LIVE) {
    console.log(`[2Chat STUB] → ${toNumber}: ${texto.slice(0, 80)}`);
    return { success: true, stub: true };
  }
  return llamar('/send-message', {
    method: 'POST',
    body: { from_number: fromNumber, to_number: toNumber, text: texto },
  });
}

module.exports = {
  listarNumeros, crearCanal, conectarCanal, desconectarCanal, obtenerQr, setFotoPerfil,
  suscribirWebhook, listarGrupos, enviarMensajeGrupo, enviarMensaje,
};
