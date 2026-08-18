// ── Alertas y estatus proactivos al equipo — sin que nadie tenga que activarlos ──
// Dispara automáticamente cuando NOA detecta una alerta crítica (robo, accidente)
// o cuando reúne suficiente información de estatus de un folio en curso.
// Usa Twilio directo (mismo proveedor y mismas env vars que server-lite.js —
// ABSTORAGES no usa 360dialog, por eso NO pasa por backend/services/whatsapp.js).
//
// WhatsApp Business exige plantilla aprobada por Meta para mensajes que el
// negocio inicia sin que el destinatario haya escrito antes en las últimas 24h
// (nuestro caso: NADIE le escribe primero a NOA, la alerta sale sola). Por eso
// NO se manda texto libre — se manda vía Content API de Twilio con los SIDs de
// las plantillas ya creadas y enviadas a aprobación de WhatsApp (04-ago-2026):
//   abstorages_alerta_critica          → HX78a10be1500919f208490671ce141b33
//   abstorages_estatus_seguimiento_v2  → HX9dc6738a6e114cfb9287bccf9b3d106d
//   (la v1 de estatus, HX03e437c037c1a85f60d5826b88da5fbd, fue RECHAZADA por
//   Meta — terminaba en variable, "no puede empezar/terminar en variable")
require('dotenv').config();
const STAFF = require('../data/staff-contacts.json');
const vapi  = require('./vapi');
const incidentesNOA = require('./incidentesNOA');
const twochat = require('./twochat');

const TWILIO_SID      = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA_FROM  = (process.env.TWILIO_WHATSAPP_NUMBER || '').replace(/^whatsapp:/, ''); // número de NOA
const WA_LIVE = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_WA_FROM);

const CONTENT_SID_ALERTA_CRITICA = 'HX78a10be1500919f208490671ce141b33';
const CONTENT_SID_ESTATUS        = 'HX9dc6738a6e114cfb9287bccf9b3d106d';

const EQUIPO_ALERTA_CRITICA = ['dante', 'rafael', 'manuel', 'gabriel', 'diego'];
const EQUIPO_ESTATUS        = ['dante', 'rafael', 'diego'];

async function enviarPlantilla(to, contentSid, variables) {
  if (!WA_LIVE) {
    console.log(`[alertasStaff STUB] → ${to}: ${contentSid} ${JSON.stringify(variables)}`);
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

async function enviarATodos(nombresClave, contentSid, variables) {
  const destinatarios = nombresClave.map(k => STAFF[k]).filter(Boolean);
  const resultados = await Promise.allSettled(
    destinatarios.map(d => enviarPlantilla(d.telefono, contentSid, variables))
  );
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[alertasStaff] Error enviando a ${destinatarios[i].nombre}:`, r.reason?.message);
    } else {
      console.log(`[alertasStaff] Enviado a ${destinatarios[i].nombre} (${destinatarios[i].telefono})`);
    }
  });
  return resultados;
}

async function llamarATodos(nombresClave, folio, motivo) {
  const destinatarios = nombresClave.map(k => STAFF[k]).filter(Boolean);
  const resultados = await Promise.allSettled(
    destinatarios.map(d => vapi.llamarAlertaStaff({ telefono: d.telefono, nombreStaff: d.nombre, folio, motivo }))
  );
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[alertasStaff] Error llamando a ${destinatarios[i].nombre}:`, r.reason?.message);
    } else {
      console.log(`[alertasStaff] Llamada disparada a ${destinatarios[i].nombre} (${destinatarios[i].telefono})`);
    }
  });
  return resultados;
}

// NOA/SOFIA en 2Chat — números propios de cada una (WhatsApp Web, distinto
// de los números de Twilio de arriba). Se usan para que, ante una alerta
// crítica, AMBAS levanten la voz en el/los grupo(s) de WhatsApp donde
// participan, sin importar cuál de las 2 fue quien detectó el problema.
const TWOCHAT_PREFIJO_ALERTA = { noa: '🟨 NOA:', sofia: '🟩 SOFIA:' };
function numerosAgentesWA() {
  return Object.entries({ noa: process.env.TWOCHAT_NUMBER_NOA, sofia: process.env.TWOCHAT_NUMBER_SOFIA })
    .filter(([, n]) => n);
}

// Publica la alerta en todos los grupos de WhatsApp donde NOA o SOFIA
// participan, una vez por cada una — así ambas quedan "enteradas" y lo
// dejan ver en el grupo, sin necesidad de un canal de mensajería interno
// entre agentes (el resultado observable es el mismo: las dos avisan).
async function alertarGrupoWA({ folio, motivo }) {
  const numeros = numerosAgentesWA();
  if (!numeros.length) return { ok: false, razon: 'sin números de 2Chat configurados' };

  let gruposUuid = [];
  try {
    const listas = await Promise.all(numeros.map(([, num]) => twochat.listarGrupos(num)));
    const vistos = new Set();
    for (const r of listas) {
      for (const g of (r.data || [])) {
        if (!vistos.has(g.uuid)) { vistos.add(g.uuid); gruposUuid.push(g.uuid); }
      }
    }
  } catch (e) {
    console.error('[alertasStaff] Error listando grupos de WhatsApp:', e.message);
  }
  if (!gruposUuid.length) return { ok: false, razon: 'sin grupos de WhatsApp detectados' };

  const mensaje = `🚨 ALERTA CRÍTICA${folio ? ` — Folio ${folio}` : ''}\n${motivo || 'Revisar de inmediato'}`;
  const envios = [];
  for (const grupoUuid of gruposUuid) {
    for (const [agente, numero] of numeros) {
      envios.push(
        twochat.enviarMensajeGrupo(numero, grupoUuid, `${TWOCHAT_PREFIJO_ALERTA[agente]}\n${mensaje}`)
          .then(() => true)
          .catch(e => { console.error(`[alertasStaff] Error avisando en grupo WA como ${agente}:`, e.message); return false; })
      );
    }
  }
  const resultados = await Promise.all(envios);
  const ok = resultados.some(Boolean);
  console.log(`[alertasStaff] Alerta en grupo(s) de WhatsApp: ${ok ? 'enviada' : 'falló'} (${gruposUuid.length} grupo(s))`);
  return { ok };
}

// Fallback si no se pudo avisar en ningún grupo — mensaje 1:1 por WhatsApp
// (2Chat, texto libre) directo a cada uno de los 5, además de la plantilla
// de Twilio y la llamada que ya se disparan siempre.
async function alertarIndividualWA({ folio, motivo }) {
  const [, fromNumber] = numerosAgentesWA()[0] || [];
  if (!fromNumber) return;
  const mensaje = `🚨 ALERTA CRÍTICA${folio ? ` — Folio ${folio}` : ''}\n${motivo || 'Revisar de inmediato'}`;
  const destinatarios = EQUIPO_ALERTA_CRITICA.map(k => STAFF[k]).filter(Boolean);
  const resultados = await Promise.allSettled(
    destinatarios.map(d => twochat.enviarMensaje(fromNumber, d.telefono, mensaje))
  );
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`[alertasStaff] Error en WA individual a ${destinatarios[i].nombre}:`, r.reason?.message);
  });
}

async function alertarCriticoStaff({ folio, motivo, canal }) {
  console.log(`[alertasStaff] Alerta crítica folio ${folio || '—'} → equipo (WhatsApp + llamada)`);
  try { incidentesNOA.registrar({ folio, motivo, canal }); } catch (e) { console.error('[alertasStaff] Error registrando incidente:', e.message); }
  const whatsapp = enviarATodos(EQUIPO_ALERTA_CRITICA, CONTENT_SID_ALERTA_CRITICA, {
    '1': folio || '—',
    '2': motivo || 'Sin detalle',
  });
  const llamadas = llamarATodos(EQUIPO_ALERTA_CRITICA, folio, motivo);
  const grupoWA = alertarGrupoWA({ folio, motivo }).then(async (r) => {
    if (!r.ok) await alertarIndividualWA({ folio, motivo }).catch(e => console.error('[alertasStaff] Error en fallback individual WA:', e.message));
    return r;
  }).catch(e => console.error('[alertasStaff] Error en alertarGrupoWA:', e.message));
  return Promise.all([whatsapp, llamadas, grupoWA]);
}

async function enviarEstatusSeguimiento({ folio, resumen }) {
  console.log(`[alertasStaff] Estatus de seguimiento folio ${folio || '—'} → equipo`);
  return enviarATodos(EQUIPO_ESTATUS, CONTENT_SID_ESTATUS, {
    '1': folio || '—',
    '2': resumen || 'Sin detalles adicionales.',
  });
}

module.exports = { alertarCriticoStaff, enviarEstatusSeguimiento };
