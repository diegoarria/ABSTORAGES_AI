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
  `esos son solo para el chat escrito y no aplican aquí. No hay límite de tiempo — deja que la llamada ` +
  `termine naturalmente cuando se resuelva el motivo de la llamada o la persona se despida.\n\n` +
  `**Interrupciones poco claras:** si la persona te interrumpe con un sonido corto o poco claro ` +
  `(ej. "a", "eh", "mm", una palabra suelta sin sentido) y luego no dice nada más, NO intentes adivinar ` +
  `qué quiso decir ni sigas tu idea anterior como si nada — responde siempre exactamente: ` +
  `"Perdón, no te escuché, ¿lo puedes repetir?" y espera su respuesta.\n\n` +
  `**Habla como una persona real, no como un asistente de IA.** Prohibido usar muletillas de ` +
  `validación tipo "excelente pregunta", "excelente comentario", "qué buena pregunta", "entiendo perfectamente", ` +
  `"por supuesto, con gusto" u otras frases de relleno antes de responder — ve directo al grano, como haría ` +
  `alguien del equipo que ya sabe la respuesta y te la dice sin rodeos. Nada de sonar como script leído ni de ` +
  `narrar lo que vas a hacer ("voy a buscar esa información", "permíteme verificar") — simplemente responde. ` +
  `Está bien usar muletillas naturales de conversación real ("mira", "a ver", "oye", pausas breves) con moderación, ` +
  `pero nunca frases de manual de atención al cliente.`;

// Eslogan de marca — solo SOFIA y SARA (llamadas comerciales/operativas), no NOA
const ESLOGAN = 'ABSTORAGES, la empresa de logística más confiable del país';
const CIERRE_ESLOGAN =
  `\n\nAntes de terminar la llamada y despedirte, SIEMPRE di exactamente esta frase de cierre: ` +
  `"Gracias por confiar en ${ESLOGAN}, ¡hasta pronto!"`;

// Store en memoria: resultados de llamadas por folio
const resultadosPorFolio = new Map();

// Ajustes de voz de SOFIA: responde más rápido y no se queda callada si hay
// cruce de voces — solo corta si la interrupción es real (3+ palabras), y
// retoma la conversación casi de inmediato en vez de quedarse en silencio.
const SOFIA_VOZ_EXTRA =
  `\n\n**Si se cruzan las voces (hablan al mismo tiempo):** no te quedes callada ni sueltes la conversación. ` +
  `Si la interrupción fue real (la persona dijo algo con sentido), deja que termine y responde a eso. ` +
  `Si fue solo un cruce breve sin que te haya dicho nada claro, retoma tu idea exactamente donde ibas — ` +
  `no te detengas a mitad de frase y no te quedes en silencio esperando; sigue la conversación.`;

const VOZ_TUNING_RAPIDA = {
  startSpeakingPlan: { waitSeconds: 0.4, smartEndpointingPlan: { provider: 'vapi' } },
  stopSpeakingPlan: { numWords: 3, voiceSeconds: 0.2, backoffSeconds: 0.5 },
  serverMessages: ['status-update', 'transcript', 'speech-update', 'end-of-call-report', 'hang'],
};

// ── Lanzar una llamada a un proveedor ─────────────────────────────────────────
async function llamarProveedor(proveedor, orden) {
  const primerMensaje =
    `${ESLOGAN}. Hola ${proveedor.nombre}, soy SOFIA. ` +
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
    SOFIA_VOZ_EXTRA +
    CIERRE_ESLOGAN +
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
      ...VOZ_TUNING_RAPIDA,
      ...(WEBHOOK_URL && {
        serverUrl: `${WEBHOOK_URL}/api/vapi/webhook`,
      }),
    },
    metadata: {
      agente:       'sofia',
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

// ── Llamada "normal" de SOFIA — su prompt real, sin guion de negociación ─────
// Para hablar con alguien del equipo (ej. Gabriel) como la planner que es,
// sin forzar un folio/negociación falsa de prueba.
async function llamarNormal(nombre, telefono) {
  const primerMensaje = `${ESLOGAN}. Hola ${nombre}, soy SOFIA. ¿Cómo estás? ¿En qué te puedo ayudar?`;

  const systemPrompt = SOFIA_SYSTEM_PROMPT + MODO_VOZ + SOFIA_VOZ_EXTRA + CIERRE_ESLOGAN;

  const payload = {
    phoneNumberId: PHONE_NUMBER_ID,
    customer: { number: telefono, name: nombre },
    assistantOverrides: {
      firstMessage: primerMensaje,
      model: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'system', content: systemPrompt }],
      },
      ...VOZ_TUNING_RAPIDA,
      ...(WEBHOOK_URL && { serverUrl: `${WEBHOOK_URL}/api/vapi/webhook` }),
    },
    metadata: { agente: 'sofia', tipo: 'normal', nombre },
  };

  if (ASSISTANT_ID) payload.assistantId = ASSISTANT_ID;

  if (!API_KEY || !PHONE_NUMBER_ID) {
    console.log(`[Vapi STUB] Llamada normal de SOFIA a ${nombre} (${telefono})`);
    return { id: `stub-normal-${Date.now()}`, status: 'queued', stub: true };
  }

  const res = await fetch(`${BASE_URL}/call/phone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Vapi error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log(`[Vapi] Llamada normal de SOFIA a ${nombre} iniciada — callId ${data.id}`);
  return data;
}

// ── Llamada disparada desde el grupo de WhatsApp (2Chat) — SOFIA o NOA ───────
// El agente decide sola, dentro de la conversación de grupo, que hace falta
// una llamada real (token de control INICIAR_LLAMADA) — no es automático en
// cada mensaje. Se le inyecta el resumen de lo que se habló en el grupo para
// que no repita preguntas ya contestadas ahí.
async function llamarDesdeGrupo({ agente, telefono, nombre, motivo, resumenContexto }) {
  const raw = (telefono || '').replace(/\D/g, '');
  if (raw.length < 10) {
    console.log(`[Vapi] Teléfono inválido para llamada desde grupo: ${telefono}`);
    return { status: 'telefono_invalido' };
  }
  const numero = raw.startsWith('52') ? `+${raw}` : `+52${raw}`;
  const esSofia = agente === 'sofia';
  const promptBase = esSofia ? SOFIA_SYSTEM_PROMPT : NOA_SYSTEM_PROMPT;
  const nombreAgente = esSofia ? 'SOFIA' : 'Noa';

  const primerMensaje =
    `${esSofia ? ESLOGAN + '. ' : ''}Hola ${nombre || ''}, soy ${nombreAgente} de ABSTORAGES. ` +
    `Te marco porque ${motivo || 'necesito platicar algo contigo'}.`;

  const systemPrompt =
    promptBase + MODO_VOZ + (esSofia ? SOFIA_VOZ_EXTRA : '') + (esSofia ? CIERRE_ESLOGAN : '') +
    `\n\n## CONTEXTO DE ESTA LLAMADA\n` +
    `Esta llamada la disparó una conversación en el grupo interno de WhatsApp de ABSTORAGES. Motivo: ${motivo || 'sin detalle'}.\n` +
    (resumenContexto ? `Lo que se habló en el grupo relevante a esto:\n${resumenContexto}\n` : '') +
    `Usa esta información para no volver a preguntar lo que ya está contestado ahí.`;

  const phoneNumberId = esSofia ? PHONE_NUMBER_ID : PHONE_NUMBER_ID_NOA;
  const assistantId = esSofia ? ASSISTANT_ID : ASSISTANT_ID_NOA;

  if (!API_KEY || !phoneNumberId) {
    console.log(`[Vapi STUB] Llamada desde grupo (${agente}) a ${nombre} (${numero}) — motivo: ${motivo}`);
    return { status: 'stub' };
  }

  const payload = {
    phoneNumberId,
    customer: { number: numero, name: nombre || 'Contacto' },
    assistantOverrides: {
      firstMessage: primerMensaje,
      model: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', messages: [{ role: 'system', content: systemPrompt }] },
      ...VOZ_TUNING_RAPIDA,
      ...(WEBHOOK_URL && { serverUrl: `${WEBHOOK_URL}/api/vapi/webhook` }),
    },
    metadata: { agente, tipo: 'desde_grupo_wa', nombre, motivo },
  };
  if (assistantId) payload.assistantId = assistantId;

  const res2 = await fetch(`${BASE_URL}/call/phone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!res2.ok) throw new Error(`Vapi error ${res2.status}: ${await res2.text()}`);
  const data = await res2.json();
  console.log(`[Vapi] Llamada desde grupo (${agente}) a ${nombre} iniciada — callId ${data.id}`);
  return data;
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

// ── Helper compartido: dispara una llamada como SARA (mismo número/assistant) ─
async function _llamarComoSARA({ numero, nombreCliente, primerMensaje, systemPrompt, logId, tipo }) {
  if (!API_KEY || !PHONE_NUMBER_ID_SARA) {
    console.log(`[Vapi STUB] Llamada SARA a ${nombreCliente} (${numero})`);
    return { status: 'stub' };
  }

  const payload = {
    phoneNumberId: PHONE_NUMBER_ID_SARA,
    customer: { number: numero, name: nombreCliente || 'Cliente' },
    assistantOverrides: {
      firstMessage: primerMensaje,
      model: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'system', content: systemPrompt }],
      },
      ...VOZ_TUNING_RAPIDA,
      ...(WEBHOOK_URL && { serverUrl: `${WEBHOOK_URL}/api/vapi/webhook` }),
    },
    metadata: { agente: 'sara', tipo: tipo || 'seguimiento', nombre: nombreCliente },
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
  console.log(`[Vapi] Llamada SARA a ${logId} iniciada — callId ${data.id}`);
  return data;
}

// ── Llamada de seguimiento al lead capturado por SARA (ya cotizó/en proceso) ──
async function llamarLead(lead) {
  const raw = (lead.telefono || '').replace(/\D/g, '');
  if (raw.length < 10) {
    console.log(`[Vapi] Teléfono inválido para llamada de seguimiento: ${lead.telefono}`);
    return;
  }
  const numero = raw.startsWith('52') ? `+${raw}` : `+52${raw}`;

  const primerMensaje =
    `${ESLOGAN}. Hola ${lead.nombre || ''}, soy SARA. ` +
    `Estuve platicando contigo sobre tu solicitud de flete. ` +
    `¿Tienes un momento para confirmar los detalles?`;

  // Mismo prompt completo que usa SARA en el chat de texto, + modo voz +
  // el contexto específico de este lead (ruta, unidad, precio cotizado).
  const systemPrompt =
    SARA_SYSTEM_PROMPT +
    MODO_VOZ +
    CIERRE_ESLOGAN +
    `\n\n## CONTEXTO DE ESTA LLAMADA\n` +
    `Estás llamando a ${lead.nombre || 'el cliente'} de ${lead.empresa || ''} para dar seguimiento a su solicitud. ` +
    `Ruta: ${lead.origen} → ${lead.destino} | Unidad: ${lead.tipo_unidad} | Precio cotizado: ${lead.precio_cotizado}. ` +
    `Objetivo: confirmar datos, resolver dudas y cerrar el acuerdo.`;

  return _llamarComoSARA({ numero, nombreCliente: lead.nombre, primerMensaje, systemPrompt, logId: `lead ${lead.id}`, tipo: 'seguimiento' });
}

// ── Llamada de confirmación — SARA acaba de cerrar la venta (NUEVA_ORDEN) ────
async function llamarConfirmacionVenta(lead) {
  const raw = (lead.telefono || '').replace(/\D/g, '');
  if (raw.length < 10) {
    console.log(`[Vapi] Teléfono inválido para llamada de confirmación de venta: ${lead.telefono}`);
    return;
  }
  const numero = raw.startsWith('52') ? `+${raw}` : `+52${raw}`;

  const primerMensaje =
    `${ESLOGAN}. Hola ${lead.nombre || ''}, soy SARA. ` +
    `Te confirmo que tu servicio quedó registrado con el folio ${lead.folio || ''}. ¿Tienes un segundo?`;

  const systemPrompt =
    SARA_SYSTEM_PROMPT +
    MODO_VOZ +
    CIERRE_ESLOGAN +
    `\n\n## CONTEXTO DE ESTA LLAMADA\n` +
    `Acabas de cerrar la venta con ${lead.nombre || 'el cliente'} de ${lead.empresa || ''} — folio ${lead.folio}. ` +
    `Ruta: ${lead.origen} → ${lead.destino} | Unidad: ${lead.tipo_unidad} | Precio: ${lead.precio_cotizado}. ` +
    `Objetivo: confirmarle en voz que el servicio quedó registrado, que el equipo de operaciones ya está buscando transportista, ` +
    `y resolver cualquier duda última que tenga. No renegocies el precio ni cambies datos del folio en esta llamada — si pide un cambio, dile que el equipo lo contacta.`;

  return _llamarComoSARA({ numero, nombreCliente: lead.nombre, primerMensaje, systemPrompt, logId: `confirmación folio ${lead.folio}`, tipo: 'confirmacion_venta' });
}

// ── Llamada de prospección en frío (día 5 de la secuencia de outreach) ───────
// A diferencia de llamarLead, este prospecto NUNCA ha hablado con SARA — solo
// recibió DM de LinkedIn / email / WhatsApp sin responder. No asumas que ya
// cotizó ni que conoce a ABSTORAGES.
async function llamarProspecto(prospecto) {
  const raw = (prospecto.telefono || '').replace(/\D/g, '');
  if (raw.length < 10) {
    console.log(`[Vapi] Teléfono inválido para llamada de prospección: ${prospecto.telefono}`);
    return;
  }
  const numero = raw.startsWith('52') ? `+${raw}` : `+52${raw}`;

  const primerMensaje =
    `${ESLOGAN}. Hola, ¿hablo con ${prospecto.nombre}? Soy SARA, de ABSTORAGES Logistics Solutions. ` +
    `Le escribí hace unos días por LinkedIn y WhatsApp sobre servicios de flete nacional — ` +
    `¿tiene un minuto?`;

  const systemPrompt =
    SARA_SYSTEM_PROMPT +
    MODO_VOZ +
    CIERRE_ESLOGAN +
    `\n\n## CONTEXTO DE ESTA LLAMADA\n` +
    `Esta es una llamada de PROSPECCIÓN EN FRÍO — ${prospecto.nombre}${prospecto.cargo ? ` (${prospecto.cargo})` : ''} de ${prospecto.empresa || 'su empresa'} ` +
    `nunca ha hablado contigo antes, solo recibió mensajes previos por LinkedIn/email/WhatsApp de la secuencia de outreach sin responder. ` +
    `NO asumas que ya tiene una cotización o solicitud en proceso — preséntate, explica brevemente qué hace ABSTORAGES ` +
    `(flete terrestre de carga en México, especialidad en alimentos y bebidas no refrigerados), y pregunta si tiene necesidad de servicios de flete. ` +
    `Si muestra interés, recolecta los datos básicos (qué transporta, rutas, volumen) para que el equipo comercial le dé seguimiento por WhatsApp/correo. ` +
    `Si no tiene interés o no es el momento, agradece y cierra cordialmente sin insistir.`;

  return _llamarComoSARA({
    numero, nombreCliente: prospecto.nombre, primerMensaje, systemPrompt,
    logId: `prospecto ${prospecto.nombre}`, tipo: 'prospeccion',
  });
}

// ── Llamada genérica de estatus (NOA) — usada para chofer/proveedor y cliente ─
async function _llamarStatusNOA({ telefono, nombre, folio, ruta, rol }) {
  if (!telefono) {
    console.log(`[Vapi] NOA — sin teléfono para ${rol} del folio ${folio}, se omite llamada`);
    return { status: 'sin_telefono' };
  }

  const esChofer = rol === 'chofer';
  const primerMensaje = esChofer
    ? `Hola ${nombre}, soy Noa de ABSTORAGES Logistics Solutions, llamando por el folio ${folio}. ¿Cómo va todo con el viaje?`
    : `Hola ${nombre}, soy Noa de ABSTORAGES Logistics Solutions, te llamo para darte un estatus de tu envío, folio ${folio}.`;

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
      ...VOZ_TUNING_RAPIDA,
      ...(WEBHOOK_URL && { serverUrl: `${WEBHOOK_URL}/api/vapi/webhook` }),
    },
    metadata: { agente: 'noa', folio, rol },
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

// ── Llamada de NOA al equipo (staff) por alerta crítica — folio en riesgo real ─
// A diferencia del status normal, esta llamada es urgente: NOA explica la
// situación de viva voz y responde preguntas del equipo sobre lo que sabe.
async function llamarAlertaStaff({ telefono, nombreStaff, folio, motivo }) {
  if (!telefono) return { status: 'sin_telefono' };

  const primerMensaje =
    `Hola ${nombreStaff || ''}, soy Noa, de monitoreo ABSTORAGES. Te marco por una alerta crítica ` +
    `${folio ? `del folio ${folio}` : 'de un servicio activo'} — ${motivo || 'necesito reportarte algo urgente'}.`;

  const systemPrompt =
    NOA_SYSTEM_PROMPT +
    MODO_VOZ +
    `\n\n## CONTEXTO DE ESTA LLAMADA\n` +
    `Le estás llamando a ${nombreStaff || 'un miembro del equipo ABSTORAGES'} porque se activó el protocolo de alerta crítica (P-MON-04) ` +
    `${folio ? `para el folio ${folio}` : ''}. Motivo: ${motivo || 'sin detalle adicional'}. ` +
    `Explica la situación con lo que sabes, responde sus preguntas, y confirma que el equipo está al tanto y tomando acción. ` +
    `No minimices la situación ni des información que no tengas — si no sabes algo, dilo directo.`;

  if (!API_KEY || !PHONE_NUMBER_ID_NOA) {
    console.log(`[Vapi STUB] NOA — llamada de alerta crítica a ${nombreStaff} (${telefono}) — folio ${folio}`);
    return { status: 'stub' };
  }

  const payload = {
    phoneNumberId: PHONE_NUMBER_ID_NOA,
    customer: { number: telefono, name: nombreStaff || 'Equipo' },
    assistantOverrides: {
      firstMessage: primerMensaje,
      model: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'system', content: systemPrompt }],
      },
      ...VOZ_TUNING_RAPIDA,
      ...(WEBHOOK_URL && { serverUrl: `${WEBHOOK_URL}/api/vapi/webhook` }),
    },
    metadata: { agente: 'noa', folio: folio || null, tipo: 'alerta_critica_staff' },
  };

  if (ASSISTANT_ID_NOA) payload.assistantId = ASSISTANT_ID_NOA;

  const res = await fetch(`${BASE_URL}/call/phone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Vapi error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  console.log(`[Vapi] NOA — llamada de alerta crítica a ${nombreStaff} iniciada — callId ${data.id}`);
  return data;
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

async function obtenerNumero(id) {
  if (!API_KEY) throw new Error('VAPI_API_KEY no configurada');
  const res = await fetch(`${BASE_URL}/phone-number/${id}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`Vapi error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function listarNumeros() {
  if (!API_KEY) throw new Error('VAPI_API_KEY no configurada');
  const res = await fetch(`${BASE_URL}/phone-number`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) throw new Error(`Vapi error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Actualiza cualquier campo del assistant (ej. voice, model, firstMessage).
// Vapi reemplaza el objeto anidado completo, no hace merge profundo — quien
// llame debe mandar el objeto completo del campo que está cambiando.
async function actualizarAssistant(id, payload) {
  if (!API_KEY) throw new Error('VAPI_API_KEY no configurada');
  const res = await fetch(`${BASE_URL}/assistant/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Vapi error ${res.status}: ${await res.text()}`);
  return res.json();
}

// Asigna un assistant a un número para que conteste llamadas ENTRANTES
async function asignarAssistantANumero(numeroId, assistantId) {
  if (!API_KEY) throw new Error('VAPI_API_KEY no configurada');
  const res = await fetch(`${BASE_URL}/phone-number/${numeroId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ assistantId }),
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
  llamarConfirmacionVenta,
  llamarProspecto,
  llamarProveedor,
  llamarNormal,
  llamarDesdeGrupo,
  llamarStatusChofer,
  llamarStatusCliente,
  llamarAlertaStaff,
  obtenerAssistant,
  actualizarAssistant,
  obtenerNumero,
  listarNumeros,
  asignarAssistantANumero,
};
