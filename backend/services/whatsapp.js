require('dotenv').config();

const BASE_URL = process.env.WHATSAPP_BASE_URL || 'https://waba.360dialog.io/v1';
const API_KEY  = process.env.WHATSAPP_API_KEY;
const WA_LIVE  = !!(API_KEY && API_KEY !== 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');

async function enviarMensaje(telefono, texto) {
  if (!WA_LIVE) {
    console.log(`[WhatsApp STUB] → ${telefono}: ${texto}`);
    return { status: 'stub', to: telefono, message: texto };
  }

  const res = await fetch(`${BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'D360-API-KEY': API_KEY,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'text',
      text: { body: texto },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[WhatsApp] Error ${res.status}: ${err}`);
  }

  return res.json();
}

async function enviarTemplate(telefono, templateName, componentes = []) {
  if (!WA_LIVE) {
    console.log(`[WhatsApp STUB] Template "${templateName}" → ${telefono}`);
    return { status: 'stub', to: telefono, template: templateName };
  }

  const res = await fetch(`${BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'D360-API-KEY': API_KEY,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'es_MX' },
        components: componentes,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[WhatsApp] Error ${res.status}: ${err}`);
  }

  return res.json();
}

async function notificarDisponibilidad(telefono, origen, destino, fecha, tipoUnidad) {
  const mensaje = `Buenos días, soy SOFIA de ABSTORAGES. Tengo disponible un viaje de ${origen} a ${destino} para el ${fecha}. ¿Tienes unidad disponible tipo ${tipoUnidad}? Favor confirmar.`;
  return enviarMensaje(telefono, mensaje);
}

async function confirmarAnticipo(telefono, nombre, monto, origen, fecha, hora) {
  const mensaje = `Perfecto ${nombre}, el viaje está confirmado. Estamos procesando tu anticipo de $${monto}. Te confirmaremos el comprobante en cuanto esté liberado. Recuerda presentarte en ${origen} el ${fecha} a las ${hora}.`;
  return enviarMensaje(telefono, mensaje);
}

async function checkDeRuta(telefono, nombre) {
  const mensaje = `Hola ${nombre}, check de ruta ABSTORAGES. ¿Cómo va el viaje? Por favor confírmame: 1) Ubicación actual, 2) Sin novedades / novedad: [describir]. Gracias.`;
  return enviarMensaje(telefono, mensaje);
}

async function solicitarAcuse(telefono, nombre) {
  const mensaje = `¡Excelente ${nombre}, entrega confirmada! Para tramitar tu pago final, necesito: 1) Foto del acuse sellado por el cliente AHORA, y 2) El acuse original en físico a nuestras oficinas. En cuanto lo recibamos, procesamos tu pago de inmediato.`;
  return enviarMensaje(telefono, mensaje);
}

module.exports = {
  enviarMensaje,
  enviarTemplate,
  notificarDisponibilidad,
  confirmarAnticipo,
  checkDeRuta,
  solicitarAcuse,
};
