// ── Alertas y estatus proactivos al equipo — sin que nadie tenga que activarlos ──
// Dispara automáticamente cuando NOA detecta una alerta crítica (robo, accidente)
// o cuando reúne suficiente información de estatus de un folio en curso.
// Usa Twilio directo (mismo proveedor y mismas env vars que server-lite.js —
// ABSTORAGES no usa 360dialog, por eso NO pasa por backend/services/whatsapp.js).
//
// WhatsApp Business exige plantilla aprobada por Meta para mensajes que el
// negocio inicia sin que el destinatario haya escrito antes en las últimas 24h
// (nuestro caso: NADIE le escribe primero a NOA, la alerta sale sola). Por eso
// NO se manda texto libre — se manda vía Content API de Twilio.
//   abstorages_alerta_critica          → HX78a10be1500919f208490671ce141b33 (04-ago-2026)
//   abstorages_estatus_seguimiento_v2  → HX9dc6738a6e114cfb9287bccf9b3d106d (04-ago-2026)
//   (la v1 de estatus, HX03e437c037c1a85f60d5826b88da5fbd, fue RECHAZADA por
//   Meta — terminaba en variable, "no puede empezar/terminar en variable")
// Las 2 de arriba quedaron APROBADAS pero HUÉRFANAS — el WABA se volvió a
// armar después y Twilio siguió mostrando "Approved" aunque Meta ya no las
// reconociera (error real en vivo: 63027 "Template does not exist for a
// language and locale"). Recreadas y resometidas el 01-sep-2026, mismo texto,
// pendientes de aprobación bajo el WABA actual:
//   abstorages_alerta_critica_2         → HX7ab1abf9fcdf735c3bdeea00b13a4955
//   abstorages_estatus_seguimiento_v3   → HXfdaff679cd6a4222201401f616bd7a05
require('dotenv').config();
const STAFF = require('../data/staff-contacts.json');
const vapi  = require('./vapi');
const incidentesNOA = require('./incidentesNOA');
const twochat = require('./twochat');

const TWILIO_SID      = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA_FROM  = (process.env.TWILIO_WHATSAPP_NUMBER || '').replace(/^whatsapp:/, ''); // número real de SARA — NOA no tiene número propio de Twilio, solo llamadas
const WA_LIVE = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_WA_FROM);

const CONTENT_SID_ALERTA_CRITICA = 'HX7ab1abf9fcdf735c3bdeea00b13a4955';
const CONTENT_SID_ESTATUS        = 'HXfdaff679cd6a4222201401f616bd7a05';

const EQUIPO_ALERTA_CRITICA = ['dante', 'rafael', 'manuel', 'gabriel', 'diego'];
const EQUIPO_ESTATUS        = ['dante', 'rafael', 'diego'];

// Interruptor general — apagado por default. Pedido explícito del usuario
// (20-ago-2026) tras la restricción de WhatsApp en SARA/SOFIA: NINGUNA de
// las 3 IA manda nada masivo (ni la alerta crítica al staff) hasta que se
// reactive a mano con MENSAJES_MASIVOS=true en el entorno. El incidente se
// sigue registrando igual (incidentesNOA) y la actividad se sigue viendo en
// el ops-center — lo que se apaga es el envío real de WhatsApp/llamadas a
// varias personas, no la visibilidad del evento.
const MASIVOS_HABILITADO = process.env.MENSAJES_MASIVOS === 'true';

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

// Whitelist explícita de grupos reales de ABSTORAGES (wa_group_id, el id
// universal — no el uuid, que es distinto por cada canal) — SIN esto, se
// publicaría en CUALQUIER grupo donde el número de 2Chat esté metido,
// incluyendo grupos ajenos a ABSTORAGES si el número ya tenía WhatsApp
// activo antes (pasó con SARA: su número ya estaba en ~12 grupos de otro
// tipo). Eso además de ser una fuga de datos es justo el patrón de "ráfaga
// a muchos grupos distintos" que dispara restricciones de WhatsApp.
const GRUPOS_ALERTA_WHITELIST = (process.env.TWOCHAT_GRUPOS_ALERTA || '').split(',').map(s => s.trim()).filter(Boolean);

// Publica la alerta en los grupos de WhatsApp reales de ABSTORAGES (solo
// los de la whitelist) donde NOA o SOFIA participan, una vez por cada una
// — así ambas quedan "enteradas" y lo dejan ver en el grupo. Envíos
// SECUENCIALES con pausa entre cada uno — nunca en ráfaga, porque 2Chat es
// automatización de WhatsApp Web (no la API oficial de Business) y es
// sensible a patrones de envío masivo.
async function alertarGrupoWA({ folio, motivo }) {
  const numeros = numerosAgentesWA();
  if (!numeros.length) return { ok: false, razon: 'sin números de 2Chat configurados' };
  if (!GRUPOS_ALERTA_WHITELIST.length) {
    console.error('[alertasStaff] TWOCHAT_GRUPOS_ALERTA no configurado — no se publica en ningún grupo (evita spamear grupos ajenos al número)');
    return { ok: false, razon: 'sin whitelist de grupos configurada' };
  }

  const porWaGroupId = {}; // wa_group_id (whitelisteado) → { [agente]: uuid propio de ese agente en ese grupo }
  try {
    const listas = await Promise.all(numeros.map(([agente, num]) => twochat.listarGrupos(num).then(r => [agente, r])));
    for (const [agente, r] of listas) {
      for (const g of (r.data || [])) {
        if (!g.wa_group_id || !GRUPOS_ALERTA_WHITELIST.includes(g.wa_group_id)) continue;
        if (!porWaGroupId[g.wa_group_id]) porWaGroupId[g.wa_group_id] = {};
        porWaGroupId[g.wa_group_id][agente] = g.uuid;
      }
    }
  } catch (e) {
    console.error('[alertasStaff] Error listando grupos de WhatsApp:', e.message);
  }
  const waGroupIds = Object.keys(porWaGroupId);
  if (!waGroupIds.length) return { ok: false, razon: 'ninguno de los grupos de TWOCHAT_GRUPOS_ALERTA fue encontrado' };

  const mensaje = `🚨 ALERTA CRÍTICA${folio ? ` — Folio ${folio}` : ''}\n${motivo || 'Revisar de inmediato'}`;
  let algunoOk = false;
  for (const waGroupId of waGroupIds) {
    for (const [agente, numero] of numeros) {
      const uuidPropio = porWaGroupId[waGroupId][agente];
      if (!uuidPropio) continue; // ese agente no es miembro de este grupo específico
      try {
        await twochat.enviarMensajeGrupo(numero, uuidPropio, `${TWOCHAT_PREFIJO_ALERTA[agente]}\n${mensaje}`);
        algunoOk = true;
      } catch (e) {
        console.error(`[alertasStaff] Error avisando en grupo WA como ${agente}:`, e.message);
      }
    }
  }
  console.log(`[alertasStaff] Alerta en grupo(s) de WhatsApp: ${algunoOk ? 'enviada' : 'falló'} (${waGroupIds.length} grupo(s) permitidos)`);
  return { ok: algunoOk };
}

// Fallback si no se pudo avisar en ningún grupo — mensaje 1:1 por WhatsApp
// (2Chat, texto libre) directo a cada uno de los 5, además de la plantilla
// de Twilio y la llamada que ya se disparan siempre. Secuencial con pausa,
// mismo motivo que arriba.
async function alertarIndividualWA({ folio, motivo }) {
  const [, fromNumber] = numerosAgentesWA()[0] || [];
  if (!fromNumber) return;
  const mensaje = `🚨 ALERTA CRÍTICA${folio ? ` — Folio ${folio}` : ''}\n${motivo || 'Revisar de inmediato'}`;
  const destinatarios = EQUIPO_ALERTA_CRITICA.map(k => STAFF[k]).filter(Boolean);
  for (const d of destinatarios) {
    try {
      await twochat.enviarMensaje(fromNumber, d.telefono, mensaje);
    } catch (e) {
      console.error(`[alertasStaff] Error en WA individual a ${d.nombre}:`, e.message);
    }
  }
}

async function alertarCriticoStaff({ folio, motivo, canal }) {
  // ¿Ya se reportó algo igual/muy parecido en la última hora? — evita
  // re-mandar una alerta masiva sobre algo que el equipo ya está
  // atendiendo (caso real: "lo de Peñafiel", donde la alerta llegó cuando
  // el equipo ya lo tenía controlado desde antes).
  let incidenteReciente = null;
  try { incidenteReciente = incidentesNOA.buscarRecienteSimilar({ folio, motivo }); } catch (e) { console.error('[alertasStaff] Error buscando incidente reciente:', e.message); }
  if (incidenteReciente) {
    const minAtras = Math.round((Date.now() - new Date(incidenteReciente.timestamp).getTime()) / 60000);
    console.warn(`[alertasStaff] 🔁 Alerta folio ${folio || '—'} parece la misma que ${incidenteReciente.id} (hace ${minAtras} min) — se registra como duplicado, NO se re-manda al staff.`);
    try { incidentesNOA.registrar({ folio, motivo, canal, duplicado_de: incidenteReciente.id }); } catch (e) { console.error('[alertasStaff] Error registrando incidente:', e.message); }
    return { ok: false, razon: `duplicado de ${incidenteReciente.id}` };
  }
  try { incidentesNOA.registrar({ folio, motivo, canal }); } catch (e) { console.error('[alertasStaff] Error registrando incidente:', e.message); }
  if (!MASIVOS_HABILITADO) {
    console.warn(`[alertasStaff] 🔇 SUPRIMIDA — alerta crítica folio ${folio || '—'} (${motivo || 'sin motivo'}) — MENSAJES_MASIVOS no está en "true". Nadie del staff fue notificado por WhatsApp/llamada. El evento sí quedó registrado (incidentesNOA) y visible en el ops-center.`);
    return { ok: false, razon: 'MENSAJES_MASIVOS deshabilitado' };
  }
  console.log(`[alertasStaff] Alerta crítica folio ${folio || '—'} → equipo (WhatsApp + llamada)`);
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
  if (!MASIVOS_HABILITADO) {
    console.warn(`[alertasStaff] 🔇 SUPRIMIDO — estatus de seguimiento folio ${folio || '—'} — MENSAJES_MASIVOS no está en "true".`);
    return { ok: false, razon: 'MENSAJES_MASIVOS deshabilitado' };
  }
  console.log(`[alertasStaff] Estatus de seguimiento folio ${folio || '—'} → equipo`);
  return enviarATodos(EQUIPO_ESTATUS, CONTENT_SID_ESTATUS, {
    '1': folio || '—',
    '2': resumen || 'Sin detalles adicionales.',
  });
}

module.exports = { alertarCriticoStaff, enviarEstatusSeguimiento };
