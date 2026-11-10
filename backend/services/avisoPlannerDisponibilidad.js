// ─── Aviso por WhatsApp al planner cuando SU proveedor confirma unidad ──────
// Pedido explícito del usuario (09-nov-2026): cuando un proveedor con
// planner humano asignado (Gabriel/Abigail/Claudia/Yamilet — nunca cuando el
// planner es "SOFIA") confirma que tiene unidad disponible, se le avisa a
// ESE planner por WhatsApp a su número personal, con los datos reales del
// proveedor/ruta/unidad/fecha. Un mensaje por cada disponibilidad real
// confirmada, nunca una ronda programada ni un resumen.
//
// Requiere una plantilla aprobada por Meta (KAPSO_TEMPLATE_AVISO_PLANNER) —
// mientras no esté configurada, esta función no hace nada (no se cae, no
// avisa a nadie, solo espera a que se someta y apruebe).
//
// Protecciones aprendidas de los incidentes de spam del 05 y 09-nov-2026:
// - Se marca `plannerAvisadoEn` en el registro de disponibilidad ANTES de
//   intentar el envío (no después) — si la llamada a Kapso truena a medias,
//   nunca se reintenta a ciegas y nunca se manda dos veces el mismo aviso.
// - Usa enviarPlantillaSinCandado con ignorarCapDiario — el candado de "1
//   contacto al día" es para no saturar PROVEEDORES; aquí el destinatario es
//   un planner interno y puede (debe) recibir un aviso por cada unidad
//   distinta que se confirme el mismo día, no solo la primera.
const contactos = require('./contactos');
const whatsappProactivo = require('./whatsappProactivo');
const colocaciones = require('./colocaciones');

const TELEFONOS_PLANNER = {
  'Gabriel Diaz': '+528182746336',
  'Abigail Dianzo': '+528115160377',
  'Claudia Beltran': '+528135909448',
  'Yamilet Gamez': '+528118001081',
};

// Aprobada por Meta (10-nov-2026) con el nombre "disponibilidad_planner".
const CONTENT_SID = process.env.KAPSO_TEMPLATE_AVISO_PLANNER || 'disponibilidad_planner';

async function avisarPlanner(d) {
  if (!CONTENT_SID) return; // plantilla todavía no sometida/aprobada en Meta
  if (!d || !d.id || d.plannerAvisadoEn) return;
  try {
    const contacto = await contactos.buscarPorTelefono(d.telefono, 'sofia');
    const planner = contacto?.planner_asignado;
    if (!planner || planner === 'SOFIA') return; // sin planner humano asignado, nada que avisar
    const telPlanner = TELEFONOS_PLANNER[planner];
    if (!telPlanner) { console.warn(`[avisoPlannerDisponibilidad] Planner "${planner}" sin teléfono configurado — se omite aviso`); return; }

    colocaciones.actualizarDisponibilidad(d.id, { plannerAvisadoEn: new Date().toISOString() });

    const variables = {
      '1': planner.split(' ')[0],
      '2': contacto.nombre_completo || d.nombre || 'un proveedor',
      '3': d.unidad || 'unidad',
      '4': d.ruta || 'ruta por confirmar',
      '5': d.fecha || 'por confirmar',
    };
    await whatsappProactivo.enviarPlantillaSinCandado('sofia', telPlanner, CONTENT_SID, variables, { ignorarCapDiario: true });
  } catch (e) {
    console.error('[avisoPlannerDisponibilidad] Error avisando a planner:', e.message);
  }
}

module.exports = { avisarPlanner, TELEFONOS_PLANNER };
