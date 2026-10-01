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
const agentPause = require('./agentPause');
const outboundRateLimit = require('./outboundRateLimit');
const fs = require('fs');
const path = require('path');
const monitoringControl = require('./monitoringControl');

// Normaliza a E.164 (+52XXXXXXXXXX) — tiene que coincidir EXACTO con el
// `phone` que arma el webhook de WhatsApp (server-lite.js, From de Twilio)
// para que la sesión de memoria sea la misma cuando la persona responda.
function normalizarE164(telefono) {
  const raw = String(telefono || '').replace(/\D/g, '');
  if (!raw) return null;
  // Twilio entrega los celulares mexicanos entrantes como +521XXXXXXXXXX (con
  // el "1" móvil). Si aquí se guardara sin ese "1", la sesión de memoria de lo
  // que mandamos NO coincidiría con la de la respuesta, y la IA contestaría
  // como si no hubiera mandado nada (pasó con Aziel el 24-sep-2026).
  if (raw.length === 10 || ((raw.startsWith('52') || raw.startsWith('521')) && raw.length >= 12)) return `+521${raw.slice(-10)}`;
  return `+${raw}`;
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
const CONTENT_SID_RECLAMO_PAGO   = process.env.TWILIO_CONTENT_SID_RECLAMO_PAGO   || null;
const CONTENT_SID_SEGUIMIENTO_DISP = process.env.TWILIO_CONTENT_SID_SEGUIMIENTO_DISPONIBILIDAD || null;
const CONTENT_SID_SEGUIMIENTO_REVISION = process.env.TWILIO_CONTENT_SID_SEGUIMIENTO_REVISION || null;

function telefonoValido(t) {
  return t && t !== '—' && /\d{8,}/.test(String(t));
}

// ── Candado contra plantillas repetidas al mismo número — PERMANENTE ───────
// Pedido explícito del usuario (29-sep-2026): si una plantilla ya se le
// mandó a un contacto, el sistema JAMÁS se la vuelve a mandar por su cuenta
// — sin importar cuánto tiempo pase. Cubre TODOS los caminos automáticos
// (escalera por olas, recordatorio, seguimiento de "reviso", requerimientos
// nuevos que lo vuelven a elegir, la ronda diaria, avisos al equipo) porque
// todos pasan por esta misma función. La ÚNICA forma de repetirla es que el
// equipo la mande a propósito, a mano, desde Base de Datos con el botón
// "Enviar plantilla" de un contacto — ese camino no pasa por aquí, manda
// directo por Twilio (ver server-lite.js), así que nunca queda bloqueado.
// Memoria + disco — mismo patrón que outboundRateLimit.js, sobrevive un redeploy.
const CANDADO_FILE = path.join(__dirname, '../../data/plantilla-enviada.json');
let plantillasEnviadas = {};
try { if (fs.existsSync(CANDADO_FILE)) plantillasEnviadas = JSON.parse(fs.readFileSync(CANDADO_FILE, 'utf8')); } catch (e) { console.error('[whatsappProactivo] No se pudo leer el candado de plantillas:', e.message); }
let guardarTimer = null;
function guardarCandado() {
  clearTimeout(guardarTimer);
  guardarTimer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(CANDADO_FILE), { recursive: true }); fs.writeFileSync(CANDADO_FILE, JSON.stringify(plantillasEnviadas)); }
    catch (e) { console.error('[whatsappProactivo] Error guardando el candado de plantillas:', e.message); }
  }, 300);
}
function claveCandado(agente, to, contentSid) { return `${agente}|${(to || '').replace(/\D/g, '').slice(-10)}|${contentSid}`; }
function yaSeEnvio(agente, to, contentSid) { return !!plantillasEnviadas[claveCandado(agente, to, contentSid)]; }
// Para que un envío hecho por fuera de esta función (el botón manual de Base de
// Datos, que manda directo por Twilio) también quede registrado en el mismo candado.
function marcarComoEnviada(agente, to, contentSid) { plantillasEnviadas[claveCandado(agente, to, contentSid)] = Date.now(); guardarCandado(); }

async function enviarPlantilla(agente, to, contentSid, variables) {
  if (yaSeEnvio(agente, to, contentSid)) {
    console.warn(`[whatsappProactivo] 🔁 Plantilla repetida bloqueada para siempre — ${agente} ya le mandó esta plantilla a ${to} antes. Solo se repite si el equipo la manda a mano desde Base de Datos.`);
    return { status: 'duplicado', to };
  }
  if (agentPause.estaPausado(agente)) {
    console.warn(`[whatsappProactivo] ${agente?.toUpperCase()} pausado — se omite plantilla a ${to}`);
    return { status: 'paused', to };
  }
  const limite = outboundRateLimit.registrarYVerificar(agente);
  if (!limite.permitido) {
    console.error(`[whatsappProactivo] 🛑 ${agente?.toUpperCase()} alcanzó su límite diario (${limite.count}/${limite.limite}) — se omite plantilla a ${to}`);
    return { status: 'rate_limited', to };
  }
  monitoringControl.reportarContactoSaliente({ agente, canal: 'whatsapp_plantilla', destinatario: to, detalle: { contentSid } });
  const from = TWILIO_WA_FROM[agente];
  const live = !!(TWILIO_SID && TWILIO_TOKEN && from);
  if (!live) {
    console.log(`[whatsappProactivo STUB] ${agente} → ${to}: ${contentSid} ${JSON.stringify(variables)}`);
    return { status: 'stub', to };
  }
  marcarComoEnviada(agente, to, contentSid); // se marca ANTES del fetch — dos envíos casi simultáneos no se cuelan los dos
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

// ── 2b. Reclamo de pago de un proveedor — a quien atiende Administración ──
// Plantilla propia (sofia_reclamo_pago): "Reclamo de pago de proveedor.
// Proveedor: {{1}}. Detalle: {{2}}. ..." Si su ContentSid aún no está en
// Railway, cae al aviso genérico al equipo para que la alerta nunca se pierda.
async function avisarReclamoPago(agente, destinatariosClaves, proveedor, detalle) {
  if (!CONTENT_SID_RECLAMO_PAGO) {
    return avisarEquipo(agente, agente.toUpperCase(), `Reclamo de pago — ${proveedor}: ${detalle}. Búscalo en la Base de Datos.`, destinatariosClaves);
  }
  const destinatarios = (destinatariosClaves || []).map(k => STAFF[k]).filter(Boolean);
  const limpio = t => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const resultados = await Promise.allSettled(
    destinatarios.map(d => enviarPlantilla(agente, d.telefono, CONTENT_SID_RECLAMO_PAGO, { '1': limpio(proveedor) || 'un proveedor', '2': limpio(detalle) || 'sin detalle' }))
  );
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[whatsappProactivo] Error avisando reclamo de pago a ${destinatarios[i]?.nombre}:`, r.reason?.message);
    else registrarEnMemoria(agente, destinatarios[i].telefono, `Reclamo de pago de proveedor. Proveedor: ${limpio(proveedor)}. Detalle: ${limpio(detalle)}. Por favor revísalo con Administración y dale seguimiento. — SOFIA, ABSTORAGES Logistics Solutions`);
  });
  return resultados;
}

// ── 2c. Seguimiento de una disponibilidad prometida ─────────────────────────
// Plantilla sofia_seguimiento_disponibilidad: "Hola {{1}}, me comentaste que
// tendrías unidad disponible el {{2}} para {{3}}. ¿Sigue en pie? ..."
// Devuelve null si su ContentSid aún no está configurado (el aviso al equipo sale igual).
// Usa SinCandado a propósito: a un mismo proveedor se le manda esta misma
// plantilla un día antes Y el día de la fecha prometida (pedido explícito del
// usuario, 30-sep-2026) — con el candado normal, el segundo envío se bloquearía
// como "ya se le mandó esta plantilla antes" y el seguimiento del día nunca saldría.
async function enviarSeguimientoDisponibilidad(nombre, telefono, fechaTexto, ruta) {
  if (!CONTENT_SID_SEGUIMIENTO_DISP) { console.warn('[whatsappProactivo] Plantilla de seguimiento de disponibilidad aún no configurada — se omite'); return null; }
  if (!telefonoValido(telefono)) return null;
  const rutaTxt = ruta || 'tus rutas';
  const r = await enviarPlantillaSinCandado('sofia', telefono, CONTENT_SID_SEGUIMIENTO_DISP, { '1': nombre || 'ahí', '2': fechaTexto, '3': rutaTxt });
  registrarEnMemoria('sofia', telefono, `Hola ${nombre || ''}, me comentaste que tendrías unidad disponible el ${fechaTexto} para ${rutaTxt}. ¿Sigue en pie? Cuéntame por este medio. — SOFIA, ABSTORAGES Logistics Solutions`);
  return r;
}

// ── 2d. Seguimiento cuando el proveedor dijo "déjame reviso" ────────────────
// Plantilla sofia_seguimiento_revision: tono amable, sin presionar. Se manda
// una sola vez, un rato después de que el proveedor dijo que iba a checar.
async function enviarSeguimientoRevision(nombre, telefono, ruta) {
  if (!CONTENT_SID_SEGUIMIENTO_REVISION) { console.warn('[whatsappProactivo] Plantilla de seguimiento de revisión aún no configurada — se omite'); return null; }
  if (!telefonoValido(telefono)) return null;
  const rutaTxt = ruta || 'la carga que platicamos';
  const r = await enviarPlantilla('sofia', telefono, CONTENT_SID_SEGUIMIENTO_REVISION, { '1': nombre || 'ahí', '2': rutaTxt });
  registrarEnMemoria('sofia', telefono, `Hola ${nombre || ''}, ¿cómo vas? Nomás para ver si ya pudiste checar si tienes unidad para ${rutaTxt}. Cualquier cosa me avisas por aquí, no hay bronca. — SOFIA, ABSTORAGES Logistics Solutions`);
  return r;
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

// Igual que enviarPlantilla, pero SIN el candado permanente — para campañas
// que se repiten a propósito todos los días (difusión general de disponibilidad).
// Nunca toca el candado de las demás plantillas: no lo lee ni lo marca, así
// que no choca con el "nunca se repite sola" de las plantillas normales, ni
// bloquea que una orden real le vuelva a preguntar disponibilidad después.
async function enviarPlantillaSinCandado(agente, to, contentSid, variables) {
  if (agentPause.estaPausado(agente)) return { status: 'paused', to };
  const limite = outboundRateLimit.registrarYVerificar(agente);
  if (!limite.permitido) return { status: 'rate_limited', to };
  monitoringControl.reportarContactoSaliente({ agente, canal: 'whatsapp_plantilla', destinatario: to, detalle: { contentSid } });
  const from = TWILIO_WA_FROM[agente];
  const live = !!(TWILIO_SID && TWILIO_TOKEN && from);
  if (!live) { console.log(`[whatsappProactivo STUB] ${agente} → ${to}: ${contentSid} ${JSON.stringify(variables)}`); return { status: 'stub', to }; }
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const body = new URLSearchParams({ From: `whatsapp:${from}`, To: `whatsapp:${to.replace(/^whatsapp:/, '')}`, ContentSid: contentSid, ContentVariables: JSON.stringify(variables) });
  const r2 = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` }, body });
  const resp = await r2.text();
  if (!r2.ok) throw new Error(`Twilio ${r2.status}: ${resp.slice(0, 300)}`);
  return JSON.parse(resp);
}

module.exports = { enviarPlantillaSinCandado, yaSeEnvio, marcarComoEnviada, enviarSeguimientoRevision, enviarSeguimientoDisponibilidad, enviarPlantilla, registrarEnMemoria, avisarReclamoPago, preguntarDisponibilidad, preguntarDisponibilidadATodos, avisarEquipo, enviarEstatusFolio };
