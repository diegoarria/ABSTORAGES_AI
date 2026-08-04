// ── Alertas y estatus proactivos al equipo — sin que nadie tenga que activarlos ──
// Dispara automáticamente cuando NOA detecta una alerta crítica (robo, accidente)
// o cuando reúne suficiente información de estatus de un folio en curso.
const whatsapp = require('./whatsapp');
const STAFF = require('../data/staff-contacts.json');

const EQUIPO_ALERTA_CRITICA = ['dante', 'rafael', 'manuel', 'gabriel', 'diego'];
const EQUIPO_ESTATUS        = ['dante', 'rafael', 'diego'];

async function enviarATodos(nombresClave, texto) {
  const destinatarios = nombresClave.map(k => STAFF[k]).filter(Boolean);
  const resultados = await Promise.allSettled(
    destinatarios.map(d => whatsapp.enviarMensaje(d.telefono, texto))
  );
  resultados.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[alertasStaff] Error enviando a ${destinatarios[i].nombre}:`, r.reason?.message);
    }
  });
  return resultados;
}

async function alertarCriticoStaff({ folio, motivo, detalle }) {
  const texto =
    `🚨 *ALERTA CRÍTICA — ABSTORAGES*\n` +
    `Folio: ${folio || '—'}\n` +
    `Motivo: ${motivo || 'Sin detalle'}\n` +
    (detalle ? `${detalle}\n` : '') +
    `\nAtiende de inmediato — NOA detectó esto en automático.`;
  console.log(`[alertasStaff] Alerta crítica folio ${folio || '—'} → equipo`);
  return enviarATodos(EQUIPO_ALERTA_CRITICA, texto);
}

async function enviarEstatusSeguimiento({ folio, resumen }) {
  const texto =
    `📦 *Estatus de seguimiento — Folio ${folio || '—'}*\n` +
    `${resumen || 'Sin detalles adicionales.'}`;
  console.log(`[alertasStaff] Estatus de seguimiento folio ${folio || '—'} → equipo`);
  return enviarATodos(EQUIPO_ESTATUS, texto);
}

module.exports = { alertarCriticoStaff, enviarEstatusSeguimiento };
