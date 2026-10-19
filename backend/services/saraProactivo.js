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
const memory = require('./memory');
const agentPause = require('./agentPause');
const outboundRateLimit = require('./outboundRateLimit');
const monitoringControl = require('./monitoringControl');
const kapso = require('./kapso');

// Tiene que coincidir EXACTO con el `phone` que arma el webhook de WhatsApp
// (server-lite.js, From de Twilio) para que sea la misma sesión cuando la
// persona responda.
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
