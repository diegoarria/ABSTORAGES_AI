// ── Cadencia de seguimiento real de María — 4 pasos (día 2/5/10/20) ────────
// Pedido explícito del usuario (19-oct-2026): la escalera de seguimiento que
// describe el prompt de María (P-COM-04) nunca tuvo un cron real detrás —
// solo existía como texto; el único barrido que corría de verdad
// (revisarLeadsSinRespuesta, server-lite.js) mandaba un único mensaje
// genérico, sin escalera. Esto construye los 4 pasos reales.
//
// Criterio de "silencio": se mide desde el ÚLTIMO MENSAJE de la conversación
// guardada en memory.js, no desde la fecha de creación del lead. Si el
// último mensaje es de María (assistant) y ya pasaron los días del siguiente
// paso sin que el lead conteste, toca mandar ese paso. Si el último mensaje
// es del lead (user) — ya contestó, la conversación está activa — no se
// interviene, el flujo normal de chat se encarga solo.
//
// Un solo paso por lead por corrida (nunca dos de golpe, aunque el lead
// llevara 25 días en silencio y se le hubiera saltado el día 10) — manda el
// primer paso pendiente y se detiene, el siguiente lo manda la corrida
// siguiente si el lead sigue sin contestar.
//
// Apagado por default — mismo interruptor que el resto de mensajes masivos
// automáticos: MENSAJES_MASIVOS=true en el entorno.
const leads = require('./leads');
const memory = require('./memory');
const agentPause = require('./agentPause');
const saraProactivo = require('./saraProactivo');

const HABILITADO = () => process.env.MENSAJES_MASIVOS === 'true';
const CHEQUEO_MS = 30 * 60 * 1000; // mismo intervalo que revisarLeadsSinRespuesta

// Orden ascendente — importante para el `break` de abajo (se detiene en el
// primer paso que todavía no toca).
const PASOS = [
  { paso: 'dia2',  dias: 2,  plantilla: 'seguimiento_lead_maria_v2',
    texto: nombre => `Hola ${nombre || ''}, soy María de ABSTORAGES. ¿Pudiste revisar lo que platicamos sobre tu ruta?` },
  { paso: 'dia5',  dias: 5,  plantilla: 'seguimiento_dia5_maria',
    texto: nombre => `Hola ${nombre || ''}, soy María de ABSTORAGES. Tengo disponibilidad para esa ruta esta semana. ¿La reservamos?` },
  { paso: 'dia10', dias: 10, plantilla: 'seguimiento_dia10_maria',
    texto: nombre => `Hola ${nombre || ''}, soy María de ABSTORAGES. ¿Cambió algo en tus volúmenes? Puedo ajustar la propuesta.` },
  { paso: 'dia20', dias: 20, plantilla: 'seguimiento_dia20_maria',
    texto: nombre => `Hola ${nombre || ''}, soy María de ABSTORAGES. Si no es el momento, sin problema. ¿Cuándo sería mejor retomar?` },
];

function telefonoValido(t) { return t && t !== '—' && /\d{8,}/.test(String(t)); }

async function correr() {
  if (!HABILITADO()) return;
  if (agentPause.estaPausado('maria')) return;

  let rows;
  try { rows = await leads.list({ limit: 1000 }); }
  catch (e) { console.error('[cadenciaSeguimiento] Error listando leads:', e.message); return; }

  for (const lead of rows) {
    if (!telefonoValido(lead.telefono)) continue;
    if (lead.sara_nota === 'cierre_de_venta') continue;
    if (lead.intent === 'trabajo' || lead.intent === 'mudanzas') continue; // nunca a estos, no son prospectos reales
    if (!lead.sessionId) continue;

    let historial;
    try { historial = memory.getFullHistory(lead.sessionId); } catch { continue; }
    if (!historial.length) continue;
    const ultimo = historial[historial.length - 1];
    if (ultimo.role !== 'assistant') continue; // el lead ya respondió — conversación activa, no se interviene

    const diasSilencio = (Date.now() - (ultimo.ts || 0)) / 86400000;
    const cadencia = lead.cadencia || {};
    const nombre = lead.nombre && lead.nombre !== '—' ? lead.nombre : '';

    // El barrido viejo (revisarLeadsSinRespuesta, server-lite.js) ya manda un
    // primer contacto de rescate (WhatsApp + llamada) entre 2 y 168 horas de
    // creado el lead — si ya corrió para este lead, el paso día 2 de aquí se
    // da por cumplido sin volver a mandar nada, para no duplicar el mensaje.
    if (lead.seguimiento_enviado && !cadencia.dia2) {
      leads.marcarPasoCadencia(lead.id, 'dia2');
      cadencia.dia2 = true;
    }

    for (const p of PASOS) {
      if (cadencia[p.paso]) continue; // ya se mandó este paso, pasa al siguiente
      if (diasSilencio < p.dias) break; // todavía no toca ninguno de los que siguen
      try {
        const r = await saraProactivo.enviarPlantilla(lead.telefono, p.plantilla, { '1': nombre || 'ahí' });
        if (r?.status !== 'paused' && r?.status !== 'rate_limited') {
          saraProactivo.registrarEnMemoria(lead.telefono, p.texto(nombre));
          leads.marcarPasoCadencia(lead.id, p.paso);
          console.log(`[cadenciaSeguimiento] ${p.paso} enviado a lead ${lead.id} (${lead.telefono})`);
        }
      } catch (e) { console.error(`[cadenciaSeguimiento] Error mandando ${p.paso} a lead ${lead.id}:`, e.message); }
      break; // un solo paso por lead por corrida
    }
  }
}

function iniciar() {
  if (!HABILITADO()) { console.log('[cadenciaSeguimiento] Desactivado (MENSAJES_MASIVOS != "true")'); return; }
  setInterval(() => correr().catch(e => console.error('[cadenciaSeguimiento]', e.message)), CHEQUEO_MS);
  console.log('[cadenciaSeguimiento] Activo — escalera día 2/5/10/20, revisión cada 30 min');
}

module.exports = { correr, iniciar };
