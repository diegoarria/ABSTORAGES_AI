require('dotenv').config();

const API_KEY = process.env.VAPI_API_KEY;
const BASE_URL = 'https://api.vapi.ai';

async function iniciarLlamada(telefono, contexto) {
  if (!API_KEY) {
    console.log(`[Vapi STUB] Llamada → ${telefono} | Contexto: ${contexto}`);
    return { status: 'stub', to: telefono, context: contexto };
  }

  const res = await fetch(`${BASE_URL}/call/phone`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      phoneNumberId: process.env.VAPI_PHONE_ID,
      customer: { number: telefono },
      assistantId: process.env.VAPI_ASSISTANT_ID,
      assistantOverrides: {
        variableValues: { contexto },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[Vapi] Error ${res.status}: ${err}`);
  }

  return res.json();
}

async function llamarTransportistaSinRespuesta(telefono, nombre, folio) {
  const contexto = `Transportista ${nombre} no ha respondido sobre el servicio folio ${folio}. Preguntar por disponibilidad o confirmación.`;
  return iniciarLlamada(telefono, contexto);
}

async function llamarCheckDeRuta(telefono, nombre, folio) {
  const contexto = `El operador ${nombre} no ha respondido el check de ruta del servicio folio ${folio}. Solicitar confirmación de ubicación y novedad del viaje.`;
  return iniciarLlamada(telefono, contexto);
}

async function llamarSeguimientoVenta(telefono, nombre, ruta) {
  const contexto = `Seguimiento de venta con ${nombre} para cotización de ruta ${ruta}. Preguntar si recibió la cotización y si tiene preguntas.`;
  return iniciarLlamada(telefono, contexto);
}

async function llamarRecuperacionCliente(telefono, nombre) {
  const contexto = `Recuperación de cliente inactivo ${nombre}. Reactivar relación comercial y presentar rutas disponibles.`;
  return iniciarLlamada(telefono, contexto);
}

module.exports = {
  iniciarLlamada,
  llamarTransportistaSinRespuesta,
  llamarCheckDeRuta,
  llamarSeguimientoVenta,
  llamarRecuperacionCliente,
};
