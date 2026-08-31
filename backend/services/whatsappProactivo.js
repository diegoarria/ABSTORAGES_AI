// ── Mensajes proactivos de SARA/SOFIA por WhatsApp (Twilio, plantilla) ──────
// Mismo motivo que saraProactivo.js/alertasStaff.js: fuera de la ventana de
// 24h, WhatsApp Business exige plantilla aprobada por Meta — no se puede
// mandar texto libre inventado en el momento. Estas 3 son nuevas (pedidas
// 20-ago-2026), pendientes de aprobación — los ContentSid llegan por
// variable de entorno; mientras no estén configurados, cae a modo stub y
// no intenta mandar nada.
//
// NOA no tiene número de WhatsApp de Twilio propio todavía — para lo
// equivalente (avisar al equipo, dar estatus) sigue usando llamadas
// (alertasStaff.llamarATodos / vapi.llamarStatusChofer·Cliente), no pasa
// por aquí.
//
// Plantillas — texto exacto acordado con el usuario, pendientes de someter
// a aprobación de Meta vía Twilio Content API:
//   1. Disponibilidad de unidad (SOFIA → proveedores compatibles):
//      "Hola {{1}}, soy SOFIA de ABSTORAGES. Buscamos unidad {{2}} para la
//       ruta {{3}} → {{4}}, salida {{5}}. ¿Tienes disponibilidad?
//       Contáctanos por este medio."
//   2. Aviso al equipo (SARA/SOFIA → 1 o varios del staff):
//      "Aviso de {{1}}: {{2}}"
//   3. Estatus de folio (SARA/SOFIA → cliente o proveedor):
//      "Hola {{1}}, este es un estatus de tu envío. Folio {{2}}: {{3}}."
require('dotenv').config();
const STAFF = require('../data/staff-contacts.json');

const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA_FROM = {
  sara:  (process.env.TWILIO_WHATSAPP_NUMBER_SARA  || '').replace(/^whatsapp:/, ''),
  sofia: (process.env.TWILIO_WHATSAPP_NUMBER_SOFIA || '').replace(/^whatsapp:/, ''),
};

// Pendientes de aprobación — se llenan en Railway en cuanto Meta las apruebe.
const CONTENT_SID_DISPONIBILIDAD = process.env.TWILIO_CONTENT_SID_DISPONIBILIDAD || null;
const CONTENT_SID_AVISO_EQUIPO   = process.env.TWILIO_CONTENT_SID_AVISO_EQUIPO   || null;
const CONTENT_SID_ESTATUS_FOLIO  = process.env.TWILIO_CONTENT_SID_ESTATUS_FOLIO  || null;

function telefonoValido(t) {
  return t && t !== '—' && /\d{8,}/.test(String(t));
}

async function enviarPlantilla(agente, to, contentSid, variables) {
  const from = TWILIO_WA_FROM[agente];
  const live = !!(TWILIO_SID && TWILIO_TOKEN && from);
  if (!live) {
    console.log(`[whatsappProactivo STUB] ${agente} → ${to}: ${contentSid} ${JSON.stringify(variables)}`);
    return { status: 'stub', to };
  }
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const body = new URLSearchParams({
    From: `whatsapp:${from}`,
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

// ── 1. Disponibilidad de unidad — SOFIA a proveedores compatibles ─────────
async function preguntarDisponibilidad(proveedor, orden) {
  if (!CONTENT_SID_DISPONIBILIDAD) { console.warn('[whatsappProactivo] Plantilla de disponibilidad aún no aprobada — se omite'); return null; }
  if (!telefonoValido(proveedor?.telefono)) return null;
  const [origen, destino] = (orden.ruta || '').split('→').map(s => (s || '').trim());
  return enviarPlantilla('sofia', proveedor.telefono, CONTENT_SID_DISPONIBILIDAD, {
    '1': proveedor.nombre || 'ahí',
    '2': orden.tipo_unidad || 'caja seca',
    '3': origen || orden.origen || '—',
    '4': destino || orden.destino || '—',
    '5': orden.fecha_carga || 'por confirmar',
  });
}

// Misma lista de proveedores compatibles que ya usan las llamadas — se le
// pasa desde afuera (vapi.filtrarProveedores) para no duplicar el criterio.
async function preguntarDisponibilidadATodos(proveedoresCompatibles, orden) {
  const resultados = await Promise.allSettled(
    (proveedoresCompatibles || []).map(p => preguntarDisponibilidad(p, orden))
  );
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[whatsappProactivo] Error preguntando disponibilidad a ${proveedoresCompatibles[i]?.nombre}:`, r.reason?.message);
  });
  return resultados;
}

// ── 2. Aviso al equipo — SARA/SOFIA a uno o varios del staff ──────────────
async function avisarEquipo(agente, remitenteLabel, mensaje, destinatariosClaves) {
  if (!CONTENT_SID_AVISO_EQUIPO) { console.warn('[whatsappProactivo] Plantilla de aviso al equipo aún no aprobada — se omite'); return null; }
  const destinatarios = (destinatariosClaves || []).map(k => STAFF[k]).filter(Boolean);
  if (!destinatarios.length) return null;
  const resultados = await Promise.allSettled(
    destinatarios.map(d => enviarPlantilla(agente, d.telefono, CONTENT_SID_AVISO_EQUIPO, {
      '1': remitenteLabel || agente.toUpperCase(),
      '2': mensaje,
    }))
  );
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[whatsappProactivo] Error avisando a ${destinatarios[i]?.nombre}:`, r.reason?.message);
  });
  return resultados;
}

// ── 3. Estatus de folio — SARA/SOFIA a cliente o proveedor ────────────────
async function enviarEstatusFolio(agente, telefono, nombre, folio, resumen) {
  if (!CONTENT_SID_ESTATUS_FOLIO) { console.warn('[whatsappProactivo] Plantilla de estatus de folio aún no aprobada — se omite'); return null; }
  if (!telefonoValido(telefono)) return null;
  return enviarPlantilla(agente, telefono, CONTENT_SID_ESTATUS_FOLIO, {
    '1': nombre || 'ahí',
    '2': folio || '—',
    '3': resumen || 'sin novedades',
  });
}

module.exports = { preguntarDisponibilidad, preguntarDisponibilidadATodos, avisarEquipo, enviarEstatusFolio };
