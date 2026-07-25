// ── Vapi.ai — Llamadas salientes en paralelo a proveedores ────────────────────
// Cuando SOFIA recibe un folio, lanza llamadas simultáneas a toda la red.
// El primero que confirme disponibilidad y mejor precio gana la asignación.
require('dotenv').config();
const SOFIA_SYSTEM_PROMPT = require('../agents/sofia-prompt');
const SARA_SYSTEM_PROMPT  = require('../agents/sara-prompt');
const NOA_SYSTEM_PROMPT   = require('../agents/noa-prompt');

const API_KEY               = process.env.VAPI_API_KEY;
const PHONE_NUMBER_ID       = process.env.VAPI_PHONE_NUMBER_ID;             // SOFIA
const PHONE_NUMBER_ID_SARA  = process.env.VAPI_PHONE_NUMBER_ID_SARA || PHONE_NUMBER_ID;
const PHONE_NUMBER_ID_NOA   = process.env.VAPI_PHONE_NUMBER_ID_NOA  || PHONE_NUMBER_ID;
const ASSISTANT_ID          = process.env.VAPI_ASSISTANT_ID;       // SOFIA
const ASSISTANT_ID_SARA     = process.env.VAPI_ASSISTANT_ID_SARA;  // SARA (opcional)
const ASSISTANT_ID_NOA      = process.env.VAPI_ASSISTANT_ID_NOA;   // NOA (opcional)
const WEBHOOK_URL           = process.env.VAPI_WEBHOOK_URL; // URL pública del servidor
const BASE_URL              = 'https://api.vapi.ai';

// Bloque de modo-voz — mismo criterio para cualquier agente en llamada telefónica
const MODO_VOZ =
  `\n\n---\n\n## 🎙️ MODO LLAMADA DE VOZ\n` +
  `Estás en una llamada telefónica real, no en el chat escrito. Responde en oraciones cortas y naturales, ` +
  `sin listas, sin markdown, sin asteriscos — como se habla por teléfono. ` +
  `NO digas en voz alta tokens de control de texto como NUEVA_ORDEN, LEAD_DATA, CERRAR_CHAT o ESCALAR_HUMANO — ` +
  `esos son solo para el chat escrito y no aplican aquí. Máximo 2 minutos de llamada.`;

// Store en memoria: resultados de llamadas por folio
const resultadosPorFolio = new Map();

// ── Lanzar una llamada a un proveedor ─────────────────────────────────────────
async function llamarProveedor(proveedor, orden) {
  const primerMensaje =
    `Hola ${proveedor.nombre}, soy SOFIA de ABSTORAGES Logistics Solutions. ` +
    `Tenemos un servicio urgente — folio ${orden.folio}. ` +
    `Necesitamos una ${orden.tipo_unidad} de ${orden.ruta} ` +
    `para el ${orden.fecha_carga}, carga de ${orden.tipo_carga || 'mercancía general'}, ` +
    `${orden.peso_toneladas || ''} toneladas. ` +
    `¿Tienes disponibilidad y cuál es tu mejor precio?`;

  // Mismo prompt completo que usa SOFIA en el chat de texto, + modo voz +
  // el contexto específico de este folio (ruta, unidad, fecha, margen).
  const systemPrompt =
    SOFIA_SYSTEM_PROMPT +
    MODO_VOZ +
    `\n\n## CONTEXTO DE ESTA LLAMADA\n` +
    `Estás llamando a ${proveedor.nombre} para el folio ${orden.folio}. ` +
    `Ruta: ${orden.ruta} | Unidad: ${orden.tipo_unidad} | Fecha: ${orden.fecha_carga} | ` +
    `Carga: ${orden.tipo_carga || 'mercancía general'}, ${orden.peso_toneladas || ''} toneladas. ` +
    `Objetivo: confirmar disponibilidad y obtener el mejor precio. El margen mínimo de ABSTORAGES es 20%. ` +
    `Si acepta, dile que le confirmamos en los próximos minutos.`;

  const payload = {
    phoneNumberId: PHONE_NUMBER_ID,
    customer: { number: proveedor.telefono, name: proveedor.nombre },
    assistantOverrides: {
      firstMessage: primerMensaje,
      model: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'system', content: systemPrompt }],
      },
      ...(WEBHOOK_URL && {
        serverUrl: `${WEBHOOK_URL}/api/vapi/webhook`,
      }),
    },
    metadata: {
      folio:        orden.folio,
      proveedor_id: proveedor.id,
      proveedor_nombre: proveedor.nombre,
    },
  };

  // Usar assistantId pre-configurado (voz, nombre, transcriber) pero SIEMPRE
  // sobreescribir el modelo/prompt con el contexto real del folio — si no,
  // SOFIA pierde la inteligencia específica de cada llamada (ruta, unidad,
  // margen, folio) y cae al prompt genérico guardado en el dashboard de Vapi.
  if (ASSISTANT_ID) {
    payload.assistantId = ASSISTANT_ID;
  }

  if (!API_KEY || !PHONE_NUMBER_ID) {
    // Modo stub: simula la llamada sin Vapi real
    console.log(`[Vapi STUB] Llamando a ${proveedor.nombre} (${proveedor.telefono}) — folio ${orden.folio}`);
    return {
      id: `stub-${proveedor.id}-${Date.now()}`,
      status: 'queued',
      stub: true,
      proveedor: proveedor.id,
    };
  }

  const res = await fetch(`${BASE_URL}/call/phone`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vapi error ${res.status}: ${err}`);
  }

  return res.json();
}

// ── Filtrar proveedores compatibles con la orden ──────────────────────────────
function filtrarProveedores(proveedores, orden) {
  const origenMatch = (p) => {
    if (!p.rutas?.length) return true;
    const origen = (orden.ruta || '').split('→')[0].trim().toUpperCase();
    return p.rutas.some(r => origen.includes(r) || r.includes(origen));
  };

  const unidadMatch = (p) => {
    if (!p.tipos_unidad?.length) return true;
    const unidad = (orden.tipo_unidad || '').toLowerCase();
    return p.tipos_unidad.some(u => unidad.includes(u) || u.includes(unidad.split(' ')[0]));
  };

  return proveedores.filter(p => p.activo !== false && origenMatch(p) && unidadMatch(p));
}

// ── Lanzar llamadas en paralelo ───────────────────────────────────────────────
async function lanzarLlamadasProveedores(orden, todosProveedores) {
  const compatibles = filtrarProveedores(todosProveedores, orden);

  if (!compatibles.length) {
    console.warn(`[Vapi] Sin proveedores compatibles para ${orden.folio}`);
    return { ok: false, motivo: 'Sin proveedores compatibles', llamadas: 0 };
  }

  console.log(`[Vapi] Lanzando ${compatibles.length} llamadas para folio ${orden.folio}`);

  // Inicializar store para este folio
  resultadosPorFolio.set(orden.folio, {
    folio:    orden.folio,
    orden,
    llamadas: compatibles.length,
    respuestas: [],
    ganador:  null,
    inicio:   new Date().toISOString(),
  });

  // Lanzar todas en paralelo — Vapi maneja la concurrencia
  const resultados = await Promise.allSettled(
    compatibles.map(p => llamarProveedor(p, orden))
  );

  const llamadasLanzadas = resultados.map((r, i) => ({
    proveedor: compatibles[i].id,
    nombre:    compatibles[i].nombre,
    callId:    r.status === 'fulfilled' ? r.value?.id : null,
    error:     r.status === 'rejected'  ? r.reason?.message : null,
  }));

  return {
    ok: true,
    llamadas: llamadasLanzadas.length,
    detalle: llamadasLanzadas,
  };
}

// ── Procesar resultado de una llamada (desde webhook) ─────────────────────────
function procesarResultadoLlamada(webhookData) {
  const folio       = webhookData.call?.metadata?.folio;
  const proveedorId = webhookData.call?.metadata?.proveedor_id;
  const transcript  = webhookData.call?.transcript || '';
  const duracion    = webhookData.call?.endedReason || '';

  if (!folio) return null;

  // Extraer disponibilidad y precio del transcript
  const disponible = /sí|si|disponible|tengo|puedo|claro|afirmativo/i.test(transcript) &&
                     !/no tengo|no puedo|no disponible|ocupado/i.test(transcript);

  const precioMatch = transcript.match(/(\$[\d,]+|\d[\d,]+\s*(?:pesos|mil|MXN))/i);
  const precio = precioMatch ? precioMatch[0] : null;

  const resultado = {
    folio,
    proveedorId,
    disponible,
    precio,
    transcript: transcript.slice(0, 500),
    timestamp: new Date().toISOString(),
  };

  // Guardar en store
  const store = resultadosPorFolio.get(folio);
  if (store) {
    store.respuestas.push(resultado);
    // Marcar ganador: primer disponible con precio confirmado
    if (disponible && precio && !store.ganador) {
      store.ganador = resultado;
      console.log(`[Vapi] Ganador para ${folio}: ${proveedorId} a ${precio}`);
    }
  }

  return resultado;
}

// ── Obtener estado de llamadas por folio ──────────────────────────────────────
function obtenerEstadoLlamadas(folio) {
  return resultadosPorFolio.get(folio) || null;
}

// ── Llamadas de seguimiento existentes ───────────────────────────────────────
async function llamarTransportistaSinRespuesta(telefono, nombre, folio) {
  const contexto = `Transportista ${nombre} no respondió el check de ruta. Folio ${folio}.`;
  return iniciarLlamadaSimple(telefono, contexto);
}

async function llamarCheckDeRuta(telefono, nombre, folio) {
  const contexto = `Solicitar confirmación de ubicación y novedad. Operador ${nombre}, folio ${folio}.`;
  return iniciarLlamadaSimple(telefono, contexto);
}

async function iniciarLlamadaSimple(telefono, contexto) {
  if (!API_KEY || !PHONE_NUMBER_ID) {
    console.log(`[Vapi STUB] ${contexto}`);
    return { status: 'stub' };
  }
  const res = await fetch(`${BASE_URL}/call/phone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({
      phoneNumberId: PHONE_NUMBER_ID,
      assistantId: ASSISTANT_ID,
      assistantOverrides: { variableValues: { contexto } },
    }),
  });
  if (!res.ok) throw new Error(`Vapi error ${res.status}`);
  return res.json();
}

// ── Llamada de seguimiento al lead capturado por SARA ─────────────────────────
async function llamarLead(lead) {
  const raw = (lead.telefono || '').replace(/\D/g, '');
  if (raw.length < 10) {
    console.log(`[Vapi] Teléfono inválido para llamada de seguimiento: ${lead.telefono}`);
    return;
  }
  const numero = raw.startsWith('52') ? `+${raw}` : `+52${raw}`;

  const primerMensaje =
    `Hola ${lead.nombre || ''}, soy SARA de ABSTORAGES Logistics Solutions. ` +
    `Estuve platicando contigo sobre tu solicitud de flete. ` +
    `¿Tienes un momento para confirmar los detalles?`;

  // Mismo prompt completo que usa SARA en el chat de texto, + modo voz +
  // el contexto específico de este lead (ruta, unidad, precio cotizado).
  const systemPrompt =
    SARA_SYSTEM_PROMPT +
    MODO_VOZ +
    `\n\n## CONTEXTO DE ESTA LLAMADA\n` +
    `Estás llamando a ${lead.nombre || 'el cliente'} de ${lead.empresa || ''} para dar seguimiento a su solicitud. ` +
    `Ruta: ${lead.origen} → ${lead.destino} | Unidad: ${lead.tipo_unidad} | Precio cotizado: ${lead.precio_cotizado}. ` +
    `Objetivo: confirmar datos, resolver dudas y cerrar el acuerdo.`;

  if (!API_KEY || !PHONE_NUMBER_ID_SARA) {
    console.log(`[Vapi STUB] Llamada de seguimiento a ${lead.nombre} (${numero})`);
    return { status: 'stub' };
  }

  const payload = {
    phoneNumberId: PHONE_NUMBER_ID_SARA,
    customer: { number: numero, name: lead.nombre || 'Cliente' },
    assistantOverrides: {
      firstMessage: primerMensaje,
      model: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'system', content: systemPrompt }],
      },
      ...(WEBHOOK_URL && { serverUrl: `${WEBHOOK_URL}/api/vapi/webhook` }),
    },
  };

  // Usar el assistant dedicado de SARA (voz/transcriber propios) si está
  // configurado, pero SIEMPRE con el prompt/contexto de esta llamada arriba.
  if (ASSISTANT_ID_SARA) {
    payload.assistantId = ASSISTANT_ID_SARA;
  }

  const res = await fetch(`${BASE_URL}/call/phone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Vapi error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log(`[Vapi] Llamada a lead ${lead.id} iniciada — callId ${data.id}`);
  return data;
}

// ── Llamada genérica de estatus (NOA) — usada para chofer/proveedor y cliente ─
async function _llamarStatusNOA({ telefono, nombre, folio, ruta, rol }) {
  if (!telefono) {
    console.log(`[Vapi] NOA — sin teléfono para ${rol} del folio ${folio}, se omite llamada`);
    return { status: 'sin_telefono' };
  }

  const esChofer = rol === 'chofer';
  const primerMensaje = esChofer
    ? `Hola ${nombre}, soy NOA de ABSTORAGES Logistics Solutions, llamando por el folio ${folio}. ¿Cómo va todo con el viaje?`
    : `Hola ${nombre}, soy NOA de ABSTORAGES Logistics Solutions, te llamo para darte un estatus de tu envío, folio ${folio}.`;

  const systemPrompt =
    NOA_SYSTEM_PROMPT +
    MODO_VOZ +
    `\n\n## CONTEXTO DE ESTA LLAMADA\n` +
    (esChofer
      ? `Estás llamando al transportista/proveedor a cargo del folio ${folio} (ruta: ${ruta}) para pedir un estatus rápido del viaje: ` +
        `dónde va, si tiene algún incidente o retraso, y hora estimada de llegada. Es una llamada de seguimiento breve, no de negociación.`
      : `Estás llamando al cliente del folio ${folio} (ruta: ${ruta}) para darle un estatus breve y tranquilizador de su envío. ` +
        `No reveles información interna (proveedor, costos). Si el cliente tiene una duda que no puedes resolver, dile que el equipo lo contacta.`);

  if (!API_KEY || !PHONE_NUMBER_ID_NOA) {
    console.log(`[Vapi STUB] NOA — llamada de estatus a ${rol} ${nombre} (${telefono}) — folio ${folio}`);
    return { status: 'stub' };
  }

  const payload = {
    phoneNumberId: PHONE_NUMBER_ID_NOA,
    customer: { number: telefono, name: nombre || rol },
    assistantOverrides: {
      firstMessage: primerMensaje,
      model: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'system', content: systemPrompt }],
      },
      ...(WEBHOOK_URL && { serverUrl: `${WEBHOOK_URL}/api/vapi/webhook` }),
    },
    metadata: { folio, rol },
  };

  if (ASSISTANT_ID_NOA) payload.assistantId = ASSISTANT_ID_NOA;

  const res = await fetch(`${BASE_URL}/call/phone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Vapi error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log(`[Vapi] NOA — llamada de estatus a ${rol} (folio ${folio}) iniciada — callId ${data.id}`);
  return data;
}

async function llamarStatusChofer({ telefono, nombre, folio, ruta }) {
  return _llamarStatusNOA({ telefono, nombre, folio, ruta, rol: 'chofer' });
}

async function llamarStatusCliente({ telefono, nombre, folio, ruta }) {
  return _llamarStatusNOA({ telefono, nombre, folio, ruta, rol: 'cliente' });
}

// ── Diagnóstico: leer la config real de un assistant directo de la API ───────
async function obtenerAssistant(id) {
  if (!API_KEY) throw new Error('VAPI_API_KEY no configurada');
  const res = await fetch(`${BASE_URL}/assistant/${id}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`Vapi error ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = {
  lanzarLlamadasProveedores,
  procesarResultadoLlamada,
  obtenerEstadoLlamadas,
  llamarTransportistaSinRespuesta,
  llamarCheckDeRuta,
  llamarLead,
  llamarProveedor,
  llamarStatusChofer,
  llamarStatusCliente,
  obtenerAssistant,
};
