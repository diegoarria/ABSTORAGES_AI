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
const memory = require('./memory');

// Normaliza a E.164 (+52XXXXXXXXXX) — tiene que coincidir EXACTO con el
// `phone` que arma el webhook de WhatsApp (server-lite.js, From de Twilio)
// para que la sesión de memoria sea la misma cuando la persona responda.
function normalizarE164(telefono) {
  const raw = String(telefono || '').replace(/\D/g, '');
  if (!raw) return null;
  return raw.startsWith('52') ? `+${raw}` : `+52${raw}`;
}

// Registra el mensaje saliente en la MISMA memoria de sesión que usa el
// webhook de WhatsApp (server-lite.js: session = wa_<agente>_<phone>) — sin
// esto, cuando la persona responde al mensaje proactivo, la IA no tiene
// ningún registro de qué le preguntó/avisó, y contesta a ciegas.
function registrarEnMemoria(agente, telefono, texto) {
  const tel = normalizarE164(telefono);
  if (!tel) return;
  const session = `wa_${agente}_${tel}`;
  try { memory.addMessage(session, 'assistant', texto); }
  catch (e) { console.error('[whatsappProactivo] Error registrando en memoria:', e.message); }
}

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
  const tipoUnidad = orden.tipo_unidad || 'caja seca';
  const org = origen || orden.origen || '—';
  const dst = destino || orden.destino || '—';
  const fecha = orden.fecha_carga || 'por confirmar';
  const resultado = await enviarPlantilla('sofia', proveedor.telefono, CONTENT_SID_DISPONIBILIDAD, {
    '1': proveedor.nombre || 'ahí', '2': tipoUnidad, '3': org, '4': dst, '5': fecha,
  });
  registrarEnMemoria('sofia', proveedor.telefono,
    `Hola ${proveedor.nombre || ''}, soy SOFIA de ABSTORAGES. Buscamos unidad ${tipoUnidad} para la ruta ${org} → ${dst}, salida ${fecha}. ¿Tienes disponibilidad? Contáctanos por este medio.`);
  return resultado;
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
  const remitente = remitenteLabel || agente.toUpperCase();
  const resultados = await Promise.allSettled(
    destinatarios.map(d => enviarPlantilla(agente, d.telefono, CONTENT_SID_AVISO_EQUIPO, {
      '1': remitente, '2': mensaje,
    }))
  );
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[whatsappProactivo] Error avisando a ${destinatarios[i]?.nombre}:`, r.reason?.message);
    else registrarEnMemoria(agente, destinatarios[i].telefono, `Aviso de ${remitente}: ${mensaje} — ABSTORAGES Logistics Solutions`);
  });
  return resultados;
}

// ── 3. Estatus de folio — SARA/SOFIA a cliente o proveedor ────────────────
async function enviarEstatusFolio(agente, telefono, nombre, folio, resumen) {
  if (!CONTENT_SID_ESTATUS_FOLIO) { console.warn('[whatsappProactivo] Plantilla de estatus de folio aún no aprobada — se omite'); return null; }
  if (!telefonoValido(telefono)) return null;
  const f = folio || '—';
  const r = resumen || 'sin novedades';
  const resultado = await enviarPlantilla(agente, telefono, CONTENT_SID_ESTATUS_FOLIO, {
    '1': nombre || 'ahí', '2': f, '3': r,
  });
  registrarEnMemoria(agente, telefono, `Hola ${nombre || ''}, este es un estatus de tu envío. Folio ${f}: ${r} — ABSTORAGES Logistics Solutions`);
  return resultado;
}

module.exports = { preguntarDisponibilidad, preguntarDisponibilidadATodos, avisarEquipo, enviarEstatusFolio };
