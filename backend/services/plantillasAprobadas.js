// ── Plantillas de WhatsApp aprobadas por Meta — única fuente de verdad ───────
// Todo lo que el equipo puede pedirle a SARA/SOFIA/NOA que le mande a un
// cliente, proveedor u operador fuera de la ventana de 24h vive AQUÍ. Si un
// ContentSid no está en esta lista para ese agente, se rechaza el envío —
// tanto en el endpoint (/api/contactos/:id/plantilla) como en lo que cada
// agente tiene permitido ofrecerle al equipo. Nunca se manda texto libre
// inventado en el momento; por orden explícita del usuario (15-sep-2026).
const PLANTILLAS = {
  sara: [
    { sid: 'HXd4594e8561e81c02c8d8f59a635ffdf8', nombre: 'Seguimiento de lead', texto: "Hola {{1}}, soy Sara de ABSTORAGES Logistics. Sigo al pendiente de tu solicitud de flete {{2}}. Cualquier duda, aqui estoy para ayudarte.",
      campos: [{ key: '1', label: 'Nombre' }, { key: '2', label: 'Ruta (ej. Monterrey a Guadalajara)' }] },
    { sid: 'HXffc1ba05d5857ff12a3cf56aa9730adf', nombre: 'Cotización', texto: "Hola {{1}}, aqui tu cotizacion ABSTORAGES para la ruta {{2}}: {{3}}. Contactame para confirmar tu servicio.",
      campos: [{ key: '1', label: 'Nombre' }, { key: '2', label: 'Ruta' }, { key: '3', label: 'Precio (ej. $19,000 MXN)' }] },
    { sid: 'HXf43876d80588e3323741f01ec3f90f61', nombre: 'Venta cerrada', texto: "Hola {{1}}, tu servicio ABSTORAGES quedo confirmado. Folio {{2}}. En breve el equipo de operaciones te contacta con los detalles del viaje.",
      campos: [{ key: '1', label: 'Nombre' }, { key: '2', label: 'Folio' }] },
    { sid: 'HX18bea3252df319e388e9fe33bd568350', nombre: 'Estatus de folio', texto: "Hola {{1}}, este es un estatus de tu envío. Folio {{2}}: {{3}} — ABSTORAGES Logistics Solutions",
      campos: [{ key: '1', label: 'Nombre' }, { key: '2', label: 'Folio' }, { key: '3', label: 'Resumen del estatus' }] },
  ],
  sofia: [
    { sid: 'HXee19ff61023459698ee2fbff871d2eaa', nombre: 'Disponibilidad de unidad', texto: "Hola {{1}}, soy SOFIA de ABSTORAGES. Buscamos unidad {{2}} para la ruta {{3}} → {{4}}, salida {{5}}. ¿Tienes disponibilidad?",
      campos: [{ key: '1', label: 'Nombre' }, { key: '2', label: 'Tipo de unidad' }, { key: '3', label: 'Origen' }, { key: '4', label: 'Destino' }, { key: '5', label: 'Fecha de salida' }] },
    { sid: 'HX18bea3252df319e388e9fe33bd568350', nombre: 'Estatus de folio', texto: "Hola {{1}}, este es un estatus de tu envío. Folio {{2}}: {{3}} — ABSTORAGES Logistics Solutions",
      campos: [{ key: '1', label: 'Nombre' }, { key: '2', label: 'Folio' }, { key: '3', label: 'Resumen del estatus' }] },
    { sid: 'HX098ade5f03dfa87b2b294ba40b060a21', nombre: 'Presentación SOFIA a proveedores', texto: "¡Hola {{1}}! Soy SOFIA Novak, de ABSTORAGES Logistics Solutions. Te escribo para presentarme — a partir de ahora voy a ser quien coordine contigo las cargas y el seguimiento de cada viaje. Cualquier duda sobre disponibilidad, rutas o un servicio en curso, escríbeme directo por aquí.",
      campos: [{ key: '1', label: 'Nombre del proveedor' }] },
  ],
  noa: [
    { sid: 'HXfdaff679cd6a4222201401f616bd7a05', nombre: 'Estatus de seguimiento', texto: "📦 Estatus de seguimiento. Folio {{1}}. Detalle: {{2}}. Reporte automatico de NOA, ABSTORAGES.",
      campos: [{ key: '1', label: 'Folio' }, { key: '2', label: 'Detalle' }] },
    { sid: 'HX7ab1abf9fcdf735c3bdeea00b13a4955', nombre: 'Alerta crítica', texto: "🚨 ALERTA CRITICA ABSTORAGES\nFolio: {{1}}\nMotivo: {{2}}\n\nAtiende de inmediato. NOA detecto esto en automatico.",
      campos: [{ key: '1', label: 'Folio' }, { key: '2', label: 'Motivo' }] },
    { sid: 'HX7564d868917b794d09150846c4a75ee6', nombre: 'Aviso al equipo', texto: "Aviso de {{1}}: {{2}} — ABSTORAGES Logistics Solutions",
      campos: [{ key: '1', label: 'Remitente' }, { key: '2', label: 'Mensaje' }] },
  ],
};

function listarPorAgente(agente) {
  return PLANTILLAS[(agente || '').toLowerCase()] || [];
}

function buscarPlantilla(agente, contentSid) {
  return listarPorAgente(agente).find(p => p.sid === contentSid) || null;
}

function esPlantillaValida(agente, contentSid) {
  return !!buscarPlantilla(agente, contentSid);
}

module.exports = { PLANTILLAS, listarPorAgente, buscarPlantilla, esPlantillaValida };
