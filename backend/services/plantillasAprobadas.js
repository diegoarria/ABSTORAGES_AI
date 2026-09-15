// ── Plantillas de WhatsApp aprobadas por Meta — única fuente de verdad ───────
// Todo lo que el equipo puede pedirle a SARA/SOFIA/NOA que le mande a un
// cliente, proveedor u operador fuera de la ventana de 24h vive AQUÍ. Si un
// ContentSid no está en esta lista para ese agente, se rechaza el envío —
// tanto en el endpoint (/api/contactos/:id/plantilla) como en lo que cada
// agente tiene permitido ofrecerle al equipo. Nunca se manda texto libre
// inventado en el momento; por orden explícita del usuario (15-sep-2026).
const PLANTILLAS = {
  sara: [
    { sid: 'HXd4594e8561e81c02c8d8f59a635ffdf8', nombre: 'Seguimiento de lead',
      campos: [{ key: '1', label: 'Nombre' }, { key: '2', label: 'Ruta (ej. Monterrey a Guadalajara)' }] },
    { sid: 'HXffc1ba05d5857ff12a3cf56aa9730adf', nombre: 'Cotización',
      campos: [{ key: '1', label: 'Nombre' }, { key: '2', label: 'Ruta' }, { key: '3', label: 'Precio (ej. $19,000 MXN)' }] },
    { sid: 'HXf43876d80588e3323741f01ec3f90f61', nombre: 'Venta cerrada',
      campos: [{ key: '1', label: 'Nombre' }, { key: '2', label: 'Folio' }] },
    { sid: 'HX18bea3252df319e388e9fe33bd568350', nombre: 'Estatus de folio',
      campos: [{ key: '1', label: 'Nombre' }, { key: '2', label: 'Folio' }, { key: '3', label: 'Resumen del estatus' }] },
  ],
  sofia: [
    { sid: 'HXee19ff61023459698ee2fbff871d2eaa', nombre: 'Disponibilidad de unidad',
      campos: [{ key: '1', label: 'Nombre' }, { key: '2', label: 'Tipo de unidad' }, { key: '3', label: 'Origen' }, { key: '4', label: 'Destino' }, { key: '5', label: 'Fecha de salida' }] },
    { sid: 'HX18bea3252df319e388e9fe33bd568350', nombre: 'Estatus de folio',
      campos: [{ key: '1', label: 'Nombre' }, { key: '2', label: 'Folio' }, { key: '3', label: 'Resumen del estatus' }] },
  ],
  noa: [
    { sid: 'HXfdaff679cd6a4222201401f616bd7a05', nombre: 'Estatus de seguimiento',
      campos: [{ key: '1', label: 'Folio' }, { key: '2', label: 'Detalle' }] },
    { sid: 'HX7ab1abf9fcdf735c3bdeea00b13a4955', nombre: 'Alerta crítica',
      campos: [{ key: '1', label: 'Folio' }, { key: '2', label: 'Motivo' }] },
    { sid: 'HX7564d868917b794d09150846c4a75ee6', nombre: 'Aviso al equipo',
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
