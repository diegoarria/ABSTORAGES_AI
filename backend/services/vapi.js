// ── Vapi.ai — Llamadas salientes en paralelo a proveedores ────────────────────
// Cuando SOFIA recibe un folio, lanza llamadas simultáneas a toda la red.
// El primero que confirme disponibilidad y mejor precio gana la asignación.
require('dotenv').config();

const API_KEY           = process.env.VAPI_API_KEY;
const PHONE_NUMBER_ID   = process.env.VAPI_PHONE_NUMBER_ID;
const ASSISTANT_ID      = process.env.VAPI_ASSISTANT_ID;
const WEBHOOK_URL       = process.env.VAPI_WEBHOOK_URL; // URL pública del servidor
const BASE_URL          = 'https://api.vapi.ai';

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

  const payload = {
    phoneNumberId: PHONE_NUMBER_ID,
    customer: { number: proveedor.telefono, name: proveedor.nombre },
    assistantOverrides: {
      firstMessage: primerMensaje,
      model: {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        messages: [{
          role: 'system',
          content:
            `Eres SOFIA, ejecutiva de operaciones de ABSTORAGES Logistics Solutions. ` +
            `Estás llamando al transportista ${proveedor.nombre} para el folio ${orden.folio}. ` +
            `Ruta: ${orden.ruta} | Unidad: ${orden.tipo_unidad} | Fecha: ${orden.fecha_carga}. ` +
            `Tu objetivo: confirmar disponibilidad y obtener el precio más bajo posible. ` +
            `Si tiene disponibilidad, negocia. El margen mínimo de ABSTORAGES es 20%. ` +
            `Si acepta, dile que le confirmamos en los próximos minutos. ` +
            `Sé directa, rápida y profesional. Máximo 2 minutos de llamada.`,
        }],
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

  // Usar assistantId pre-configurado si existe, si no construir inline
  if (ASSISTANT_ID) {
    payload.assistantId = ASSISTANT_ID;
    delete payload.assistantOverrides.model;
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

module.exports = {
  lanzarLlamadasProveedores,
  procesarResultadoLlamada,
  obtenerEstadoLlamadas,
  llamarTransportistaSinRespuesta,
  llamarCheckDeRuta,
};
