// ── Notificaciones automáticas de hitos al cliente ──────────────────────────
// Pedido explícito del usuario (12-oct-2026): "nivel Uber Freight" — que el
// cliente se entere solo, sin que nadie le avise, cuando su unidad sale de
// origen o llega a destino.
//
// Fuente de los hitos: el TMS real, NO colocaciones.js (colocaciones.js solo
// se actualiza cuando un folio pasó por el flujo de búsqueda propio de
// SOFIA — en la práctica casi ningún folio real lo hace; mismo hallazgo que
// ya corrigió el mapa de flota en server-lite.js). Se detecta el hito por
// transición de campo (vacío → con fecha) comparando contra la última
// consulta, no por un webhook — el TMS no empuja cambios, solo se puede
// consultar.
//
// Plantilla: reusa "Estatus de folio" (HX18bea3252df319e388e9fe33bd568350),
// ya aprobada por Meta en Twilio — no se creó ninguna plantilla nueva.
// No se reusa whatsappProactivo.enviarPlantilla() porque ese tiene un
// candado de "nunca repetir la misma plantilla al mismo número" (pensado
// para campañas de una sola vez) — aquí SÍ hace falta mandarla varias veces
// (un hito real distinto cada vez), así que el candado es propio, por
// folio+evento, no por plantilla+número.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tms = require('./tms');
const contactos = require('./contactos');
const plantillasAprobadas = require('./plantillasAprobadas');
const agentPause = require('./agentPause');
const outboundRateLimit = require('./outboundRateLimit');
const monitoringControl = require('./monitoringControl');

const HABILITADO = (process.env.MARIA_HITOS_CLIENTE || process.env.SARA_HITOS_CLIENTE) === 'true'; // apagado por default — son mensajes reales y automáticos a clientes reales
const TICK_MS = Number(process.env.MARIA_HITOS_CLIENTE_TICK_MIN || process.env.SARA_HITOS_CLIENTE_TICK_MIN || 10) * 60 * 1000;

const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA_FROM_MARIA = (process.env.TWILIO_WHATSAPP_NUMBER_MARIA || process.env.TWILIO_WHATSAPP_NUMBER_SARA || process.env.TWILIO_WHATSAPP_NUMBER || '').replace(/^whatsapp:/, '');
const LIVE = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_WA_FROM_MARIA);

// SARA → MARÍA (oct-2026): se busca primero bajo 'maria'; mientras esa lista
// siga vacía (plantillas nuevas de Kapso pendientes), se usa la misma
// plantilla genérica "Estatus de folio" que ya estaba aprobada bajo 'sara'.
const PLANTILLA_ESTATUS = plantillasAprobadas.buscarPlantilla('maria', 'HX18bea3252df319e388e9fe33bd568350')
  || plantillasAprobadas.buscarPlantilla('sara', 'HX18bea3252df319e388e9fe33bd568350');

const FILE = path.join(__dirname, '../../data/hitos-cliente-avisados.json');
function cargar() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } }
let avisados = cargar(); // { "FOLIO:evento": "2026-10-12T..." }
function guardar() { try { fs.writeFileSync(FILE, JSON.stringify(avisados, null, 2)); } catch (e) { console.error('[hitosCliente] Error guardando:', e.message); } }

// Busca el teléfono del cliente por nombre de empresa (campo "Cliente" del
// TMS) contra la cartera real de MARÍA (contactos.js) — el TMS no trae el
// teléfono del cliente, solo el del Planner interno que lleva el folio.
async function telefonoCliente(nombreEmpresa) {
  if (!nombreEmpresa) return null;
  try {
    const lista = await contactos.listarPorAgente('MARIA', { tipo: 'cliente', q: nombreEmpresa });
    const q = nombreEmpresa.trim().toLowerCase();
    const exacto = lista.find(c => (c.empresa || '').trim().toLowerCase() === q);
    return (exacto || lista[0])?.telefono || null;
  } catch (e) {
    console.error(`[hitosCliente] Error buscando teléfono de "${nombreEmpresa}":`, e.message);
    return null;
  }
}

async function enviarEstatus(telefono, folio, resumen) {
  if (agentPause.estaPausado('maria')) { console.warn(`[hitosCliente] MARÍA pausada — se omite aviso a ${telefono} (folio ${folio})`); return; }
  const limite = outboundRateLimit.registrarYVerificar('maria');
  if (!limite.permitido) { console.error(`[hitosCliente] 🛑 MARÍA alcanzó su límite diario — se omite aviso a ${telefono} (folio ${folio})`); return; }
  if (!PLANTILLA_ESTATUS) { console.error('[hitosCliente] Plantilla "Estatus de folio" no encontrada en plantillasAprobadas.js'); return; }
  monitoringControl.reportarContactoSaliente({ agente: 'maria', canal: 'whatsapp_plantilla', destinatario: telefono, detalle: { contentSid: PLANTILLA_ESTATUS.sid, folio } });
  if (!LIVE) { console.log(`[hitosCliente STUB] → ${telefono} (folio ${folio}): ${resumen}`); return; }
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  const body = new URLSearchParams({
    From: `whatsapp:${TWILIO_WA_FROM_MARIA}`,
    To: `whatsapp:${telefono.replace(/^whatsapp:/, '')}`,
    ContentSid: PLANTILLA_ESTATUS.sid,
    ContentVariables: JSON.stringify({ '1': 'ahí', '2': folio, '3': resumen }),
  });
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${auth}` }, body,
    });
    const resp = await r.text();
    if (!r.ok) throw new Error(`Twilio ${r.status}: ${resp.slice(0, 300)}`);
    console.log(`[hitosCliente] OK → ${telefono} (folio ${folio}): ${resumen}`);
  } catch (e) {
    console.error(`[hitosCliente] Error enviando a ${telefono} (folio ${folio}):`, e.message);
  }
}

async function evaluarFolio(f) {
  const folio = f['Folio de servicio'];
  if (!folio) return;
  const eventos = [
    { clave: 'salio', condicion: !!f['Hora de salida carga'], resumen: `Tu unidad ya salió de ${f['Cuidad Origen'] || 'origen'} rumbo a ${f['Cuidad destino'] || 'destino'}.` },
    { clave: 'llego', condicion: !!f['Llegada a descarga'], resumen: `Tu unidad llegó a ${f['Cuidad destino'] || 'destino'}. En breve el equipo confirma la entrega.` },
  ];
  for (const ev of eventos) {
    const clave = `${folio}:${ev.clave}`;
    if (!ev.condicion || avisados[clave]) continue;
    const telefono = await telefonoCliente(f['Cliente']);
    if (!telefono) { console.log(`[hitosCliente] Folio ${folio}: hito "${ev.clave}" detectado pero sin teléfono de cliente para "${f['Cliente']}" — no se avisa, se reintenta después.`); continue; }
    avisados[clave] = new Date().toISOString(); // se marca ANTES de mandar — dos ticks casi simultáneos no duplican el aviso
    guardar();
    await enviarEstatus(telefono, folio, ev.resumen);
  }
}

async function tick() {
  if (!HABILITADO) return;
  if (!tms.ENABLED) return;
  let folios;
  try { folios = await tms.foliosActivosNOA(); } catch (e) { console.error('[hitosCliente] Error consultando TMS:', e.message); return; }
  await Promise.allSettled((folios || []).map(evaluarFolio));
}

function iniciar() {
  if (!HABILITADO) { console.log('[hitosCliente] Desactivado (MARIA_HITOS_CLIENTE / SARA_HITOS_CLIENTE != "true")'); return; }
  setInterval(() => tick().catch(e => console.error('[hitosCliente]', e.message)), TICK_MS);
  console.log(`[hitosCliente] Activo — revisa hitos cada ${TICK_MS / 60000} min`);
}

module.exports = { iniciar, tick, evaluarFolio, telefonoCliente };
