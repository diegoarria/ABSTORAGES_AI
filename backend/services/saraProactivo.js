// ── Mensajes proactivos de MARÍA por WhatsApp — fuera de la ventana de 24h ────
// Igual que alertasStaff.js: WhatsApp Business exige plantilla aprobada por
// Meta para que MARÍA le escriba primero a un lead sin que él le haya escrito
// antes.
//
// Migrado de Twilio a Kapso (oct-2026) — Twilio queda fuera por completo,
// mismo criterio que whatsappProactivo.js/difusionGeneral.js/difusionClientes.js.
// Los ContentSid de Twilio de abajo quedan como referencia histórica (nunca
// llegaron a tener una plantilla viva y aprobada bajo el WABA actual); los
// nombres de plantilla reales de Kapso están en KAPSO_TEMPLATE_* más abajo.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const memory = require('./memory');
const agentPause = require('./agentPause');
const outboundRateLimit = require('./outboundRateLimit');
const monitoringControl = require('./monitoringControl');
const kapso = require('./kapso');
const phoneBanlist = require('./phoneBanlist');

// MARÍA no tenía NINGUNA de las protecciones que SOFIA sí tiene en
// whatsappProactivo.js (baneo, candado de "1 contacto al día") — se
// descubrió al revisar a fondo el incidente de spam de SOFIA del
// 05-nov-2026. Mismo criterio, duplicado aquí a propósito (igual que
// normalizarE164 ya estaba duplicado entre los dos archivos).
const FILE_CONTACTO_DIARIO = path.join(__dirname, '../../data/maria-contacto-diario.json');
let contactoDiario = {};
try { contactoDiario = JSON.parse(fs.readFileSync(FILE_CONTACTO_DIARIO, 'utf8')); } catch {}
function guardarContactoDiario() {
  try { fs.writeFileSync(FILE_CONTACTO_DIARIO, JSON.stringify(contactoDiario)); }
  catch (e) { console.error('[saraProactivo] Error guardando candado diario:', e.message); }
}
function fechaMTY() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Monterrey' }).format(new Date()); }
function claveContactoDiario(to) { return `${(to || '').replace(/\D/g, '').slice(-10)}|${fechaMTY()}`; }
function yaContactadoHoy(to) { return !!contactoDiario[claveContactoDiario(to)]; }
function marcarContactadoHoy(to) { contactoDiario[claveContactoDiario(to)] = Date.now(); guardarContactoDiario(); }

// Tiene que coincidir EXACTO con el `phone` que arma /webhook/kapso
// (server-lite.js: phone = '+' + dígitos de `from`, tal cual los manda
// Meta/Kapso, SIN el "1" móvil que Twilio sí agregaba) para que sea la
// misma sesión cuando la persona responda.
function normalizarE164(telefono) {
  const raw = String(telefono || '').replace(/\D/g, '');
  if (!raw) return null;
  // BUG REAL encontrado 04-nov-2026 — ver el mismo comentario en
  // whatsappProactivo.js: esta función seguía agregando el "1" al estilo
  // Twilio después de la migración a Kapso (oct-2026), así que los mensajes
  // proactivos de MARÍA se guardaban en una sesión de memoria distinta a la
  // real. Corregido para igualar el formato real de Kapso.
  if (raw.length === 10) return `+52${raw}`;
  if (raw.startsWith('521') && raw.length === 13) return `+52${raw.slice(3)}`;
  if (raw.startsWith('52') && raw.length === 12) return `+${raw}`;
  return `+${raw}`;
}

// Sin esto, cuando el cliente responde a un mensaje proactivo, MARÍA no
// tiene ningún registro de qué le mandó — contesta a ciegas.
function registrarEnMemoria(telefono, texto) {
  const tel = normalizarE164(telefono);
  if (!tel) return;
  try { memory.addMessage(`wa_maria_${tel}`, 'assistant', texto); } // wa_sara_ → wa_maria_ (oct-2026), igual que server-lite.js
  catch (e) { console.error('[saraProactivo] Error registrando en memoria:', e.message); }
}

// Nombres de plantilla de Kapso/Meta — sometidas oct-2026, pendientes de
// aprobación (ver comentario al fondo del archivo con los IDs). Mientras no
// estén APPROVED, kapso.enviarPlantilla() hace fallback a stub (solo log).
const CONTENT_SID_SEGUIMIENTO_LEAD   = process.env.KAPSO_TEMPLATE_SEGUIMIENTO_LEAD   || 'seguimiento_lead_maria_v2';
const CONTENT_SID_VENTA_CERRADA      = process.env.KAPSO_TEMPLATE_VENTA_CERRADA      || 'venta_cerrada_maria_v3';
const CONTENT_SID_UNIDAD_CONFIRMADA  = process.env.KAPSO_TEMPLATE_UNIDAD_CONFIRMADA  || 'unidad_confirmada_maria';

async function enviarPlantilla(to, contentSid, variables) {
  if (phoneBanlist.estaBaneado(to)) {
    console.warn(`[saraProactivo] 🚫 ${to} está baneado — se omite plantilla saliente`);
    return { status: 'baneado', to };
  }
  if (yaContactadoHoy(to)) {
    console.warn(`[saraProactivo] 🔁 MARÍA ya contactó a ${to} hoy — se omite para no mandar más de un mensaje al día.`);
    return { status: 'ya_contactado_hoy', to };
  }
  if (agentPause.estaPausado('maria')) {
    console.warn(`[saraProactivo] MARÍA pausada — se omite plantilla a ${to}`);
    return { status: 'paused', to };
  }
  const limite = outboundRateLimit.registrarYVerificar('maria');
  if (!limite.permitido) {
    console.error(`[saraProactivo] 🛑 MARÍA alcanzó su límite diario (${limite.count}/${limite.limite}) — se omite plantilla a ${to}`);
    return { status: 'rate_limited', to };
  }
  monitoringControl.reportarContactoSaliente({ agente: 'maria', canal: 'whatsapp_plantilla', destinatario: to, detalle: { contentSid } });
  // Se marca ANTES de esperar la respuesta de Kapso — así, si la llamada
  // truena después de que el mensaje ya salió de verdad (timeout, respuesta
  // rara), un reintento del llamador no manda un segundo mensaje real el
  // mismo día. Mismo criterio que el freno agregado a sofiaOperacion.js
  // tras el incidente de spam del 05-nov-2026.
  marcarContactadoHoy(to);
  return kapso.enviarPlantilla(to, 'maria', contentSid, variables);
}

function telefonoValido(t) {
  return t && t !== '—' && /\d{8,}/.test(t);
}

async function enviarSeguimientoLead(telefono, nombre, resumenSolicitud) {
  if (!telefonoValido(telefono)) return null;
  console.log(`[saraProactivo] Seguimiento de lead → ${telefono}`);
  const resultado = await enviarPlantilla(telefono, CONTENT_SID_SEGUIMIENTO_LEAD, { '1': nombre || 'ahí' });
  registrarEnMemoria(telefono, `Hola ${nombre || ''}, soy María de ABSTORAGES. ¿Pudiste revisar lo que platicamos sobre tu ruta?`);
  return resultado;
}

// Mensaje proactivo: SOFIA ya encontró proveedor para el folio — MARÍA le
// avisa al cliente y le pregunta si lo sigue necesitando con esa urgencia.
// Si el cliente contesta que sí, MARÍA emite CONFIRMAR_UNIDAD_URGENTE y el
// backend cierra automático con ese proveedor (ver sofiaOperacion.js).
// NUNCA incluye el precio/tarifa pactada con el transportista — guardrail
// anti-fuga de precios (pedido explícito del usuario, 19-oct-2026): ese dato
// jamás llega al cliente por este ni ningún otro canal, el parámetro
// `precio` se recibe solo para log interno, no se usa en el texto de salida.
async function enviarUnidadConfirmada(telefono, nombre, folio, proveedorNombre, precio) {
  if (!telefonoValido(telefono)) return null;
  console.log(`[saraProactivo] Unidad confirmada → ${telefono} — folio ${folio} (tarifa interna: ${precio || 'n/d'}, nunca se le manda al cliente)`);
  registrarEnMemoria(telefono, `Hola ${nombre || ''}, soy María de ABSTORAGES. Ya tenemos unidad confirmada para tu folio ${folio}. ¿La sigues necesitando?`);
  return enviarPlantilla(telefono, CONTENT_SID_UNIDAD_CONFIRMADA, {
    '1': nombre || 'ahí', '2': folio || '—',
  });
}

async function enviarConfirmacionVenta(telefono, nombre, folio) {
  if (!telefonoValido(telefono)) return null;
  console.log(`[saraProactivo] Confirmación de venta → ${telefono} — folio ${folio}`);
  registrarEnMemoria(telefono, `Hola ${nombre || ''}, soy María de ABSTORAGES. Tu venta quedó confirmada — folio ${folio || '—'}.`);
  return enviarPlantilla(telefono, CONTENT_SID_VENTA_CERRADA, {
    '1': nombre || 'ahí',
    '2': folio || '—',
  });
}

module.exports = { enviarSeguimientoLead, enviarConfirmacionVenta, enviarUnidadConfirmada, normalizarE164, enviarPlantilla, registrarEnMemoria };
