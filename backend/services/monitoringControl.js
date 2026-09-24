// ── Puente HTTP hacia monitoring — agent_control + outbound_contact_log ──────
// El negocio nunca tiene credenciales de la base de monitoring (mismo
// principio que ipIntel.js) — todo pasa por HTTP con el secreto compartido
// (MONITORING_INTAKE_URL + MONITORING_INTAKE_SECRET). Si monitoring no está
// configurado o no responde, todo aquí degrada a no-op — nunca rompe el
// flujo de negocio por esto.
//
// Por qué existe: el 22-sep-2026 encontramos que la pausa de agentes vivía
// solo en data/agent-pause.json, un volumen persistente de Railway la tapaba,
// y nadie se enteró en una semana. Este módulo hace que monitoring (base
// separada, con su propio panel) sea la fuente de verdad — al arrancar y
// cada pocos minutos, el negocio se resincroniza contra monitoring en vez de
// confiar ciegamente en su propio disco.
const agentPause = require('./agentPause');
const actividadBus = require('./actividadBus');
const contactos = require('./contactos');

const URL    = (process.env.MONITORING_INTAKE_URL || '').replace(/\/$/, '');
const SECRET = process.env.MONITORING_INTAKE_SECRET;
const HABILITADO = !!(URL && SECRET);

async function fetchConTimeout(path, opts = {}) {
  const res = await fetch(`${URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Intake-Secret': SECRET, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`monitoring HTTP ${res.status}`);
  return res.json();
}

// Trae el estado real desde monitoring y lo adopta en el caché local —
// llamado al arrancar (antes de que corra cualquier scheduler) y en cada
// resincronización periódica.
async function sincronizar() {
  if (!HABILITADO) return;
  try {
    const estado = await fetchConTimeout('/internal/agent-control');
    agentPause.establecerEstadoCompleto(estado);
  } catch (e) {
    console.error('[monitoringControl] Error sincronizando agent-control (se queda con el último estado conocido):', e.message);
  }
}

// Empuja un cambio de pausa/reanudación hacia monitoring — se llama justo
// después de agentPause.pausar()/reanudar() local, así monitoring queda
// como el registro autoritativo, no solo un espejo.
async function empujar(agente, paused, motivo) {
  if (!HABILITADO) return;
  try {
    await fetchConTimeout(`/internal/agent-control/${agente}`, {
      method: 'POST',
      body: JSON.stringify({ paused, motivo, changedBy: 'negocio' }),
    });
  } catch (e) {
    console.error(`[monitoringControl] Error empujando estado de ${agente} a monitoring:`, e.message);
  }
}

// Reporta un contacto proactivo real (nunca uno omitido por pausa/límite) —
// fire-and-forget, no bloquea el envío real por esto.
// Feed "En vivo": cada contacto saliente real aparece como evento con el
// nombre de la persona (si está en la Base de Datos) — el texto lo arma el
// sistema con datos reales, nunca la IA.
async function emitirActividad({ agente, canal, destinatario, detalle }) {
  try {
    const c = destinatario ? await contactos.buscarPorTelefono(destinatario, agente).catch(() => null) : null;
    const nombre = c?.nombre_completo ? `${c.nombre_completo}${c.empresa ? ' (' + c.empresa + ')' : ''}` : (detalle?.proveedor || destinatario || 'un contacto');
    const A = String(agente || '').toUpperCase();
    const mensaje = canal === 'llamada'
      ? `${A} está llamando a ${nombre}${detalle?.folio ? ` (folio ${detalle.folio})` : ''}`
      : `${A} le escribió a ${nombre} (plantilla de WhatsApp)`;
    actividadBus.emitir({ agente: A, tipo: 'CONTACTO_SALIENTE', mensaje, metadata: { canal, telefono: destinatario || null } });
  } catch (e) { console.error('[monitoringControl] Error emitiendo actividad:', e.message); }
}

function reportarContactoSaliente({ agente, canal, destinatario, detalle }) {
  emitirActividad({ agente, canal, destinatario, detalle });
  if (!HABILITADO) return;
  fetchConTimeout('/internal/outbound-contact', {
    method: 'POST',
    body: JSON.stringify({ agente, canal, destinatario, detalle }),
  }).catch(e => console.error('[monitoringControl] Error reportando outbound-contact:', e.message));
}

// Resincronización periódica — si monitoring y el disco local alguna vez se
// desalinean otra vez (por lo que sea), esto los vuelve a juntar solo, sin
// esperar a que alguien pregunte.
const RESYNC_MS = 5 * 60 * 1000;
async function iniciar() {
  if (!HABILITADO) {
    console.log('[monitoringControl] Desactivado (falta MONITORING_INTAKE_URL o MONITORING_INTAKE_SECRET) — agentPause solo usa el disco local.');
    return;
  }
  await sincronizar(); // adoptar el estado real ANTES de que arranque cualquier scheduler
  setInterval(sincronizar, RESYNC_MS);
  console.log(`[monitoringControl] Activo — resincronizando agent-control cada ${RESYNC_MS / 60000} min`);
}

module.exports = { iniciar, sincronizar, empujar, reportarContactoSaliente, HABILITADO };
