const express = require('express');
const router = express.Router();
const { chatStream } = require('../services/claude');
const { publicarActividad, suscribirNuevaOrden } = require('../services/redis');
const { guardarMensaje, obtenerHistorialConversacion, registrarActividad, actualizarEstatusFolio, obtenerFolioActivo, obtenerMetricas } = require('../db/db');
const mem = require('../services/sessionMemory');
const tariff = require('../services/tariff');
const ordersStore = require('../services/ordersStore');
const { lanzarLlamadasProveedores } = require('../services/vapi');
const { lanzarNegociacion } = require('../services/negociacion-wa');
const SOFIA_SYSTEM_PROMPT = require('../agents/sofia-prompt');

const PROVEEDORES = (() => {
  try { return require('../data/proveedores.json'); } catch { return []; }
})();

// POST /api/sofia/chat — streaming SSE
router.post('/chat', async (req, res) => {
  const { message, sessionId = 'default' } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message requerido' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const safeWrite = (payload) => {
    if (controller.signal.aborted || res.writableEnded) return;
    try { res.write(payload); } catch (_) { controller.abort(); }
  };

  try {
    // Memoria en tiempo real (funciona sin PostgreSQL)
    mem.addMessage('SOFIA', sessionId, 'user', message);
    const historial = mem.getHistory('SOFIA', sessionId);

    // Sync con DB en background (sin bloquear)
    guardarMensaje('SOFIA', sessionId, 'user', message).catch(() => {});
    publicarActividad('SOFIA', 'MENSAJE_USUARIO', message.substring(0, 160), { sessionId }).catch(() => {});

    // ── Resolución de folio activo ────────────────────────────────────────────
    // 1. ¿El mensaje actual trae un folio?
    let orden = ordersStore.obtenerOrden(message);

    // 2. Si no, ¿esta sesión ya tiene un folio activo de un mensaje anterior?
    if (!orden) {
      const folioSesion = mem.getActiveFolio('SOFIA', sessionId);
      if (folioSesion) orden = ordersStore.obtenerOrdenPorFolio(folioSesion);
    }

    // 3. Si encontramos folio nuevo, persistirlo para el resto de la sesión
    if (orden?.folio) {
      const folioAnterior = mem.getActiveFolio('SOFIA', sessionId);
      if (folioAnterior !== orden.folio) {
        mem.setActiveFolio('SOFIA', sessionId, orden.folio);
        console.log(`[SOFIA] Folio activo para sesión ${sessionId}: ${orden.folio}`);

        // Primera vez que se detecta este folio en esta sesión → lanzar operaciones
        if (PROVEEDORES.length) {
          lanzarLlamadasProveedores(orden, PROVEEDORES)
            .then(r => publicarActividad('SOFIA', 'VAPI_LANZADO',
              `${r.llamadas || 0} llamadas Vapi para ${orden.folio}`, r).catch(() => {}))
            .catch(err => console.error('[SOFIA] Error Vapi:', err));

          lanzarNegociacion(orden, PROVEEDORES)
            .then(r => publicarActividad('SOFIA', 'WA_NEGOCIACION_INICIADA',
              `${r?.enviados || 0} carriers contactados vía WA — ${orden.folio}`, r).catch(() => {}))
            .catch(err => console.error('[SOFIA] Error NegWA:', err));
        }
      }
    }

    const ordenContext = orden ? buildOrdenContext(orden) : '';
    const systemPrompt = SOFIA_SYSTEM_PROMPT + tariff.getContext().prompt + ordenContext;

    await chatStream(
      systemPrompt,
      historial,
      (chunk) => {
        safeWrite(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
      },
      async (fullText) => {
        // Guardar respuesta en memoria inmediatamente
        mem.addMessage('SOFIA', sessionId, 'assistant', fullText);
        guardarMensaje('SOFIA', sessionId, 'assistant', fullText).catch(() => {});
        registrarActividad('SOFIA', 'INFO', null, `Respuesta generada para sesión ${sessionId}`).catch(() => {});
        publicarActividad('SOFIA', 'MENSAJE_SOFIA', fullText.substring(0, 160), { sessionId }).catch(() => {});

        // Detectar actualización de estatus de folio
        const actualizacion = detectarActualizacionFolio(fullText);
        if (actualizacion) {
          safeWrite(`data: ${JSON.stringify({ type: 'folio_update', ...actualizacion })}\n\n`);
        }
      },
      controller.signal
    );

    safeWrite(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    if (!res.writableEnded) res.end();
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('[SOFIA] Error en chat:', err);
      safeWrite(`data: ${JSON.stringify({ type: 'error', message: 'Error al procesar tu mensaje' })}\n\n`);
    }
    if (!res.writableEnded) res.end();
  }
});

// GET /api/sofia/folios — folios activos
router.get('/folios', async (req, res) => {
  try {
    const folios = await obtenerFolioActivo();
    res.json(folios);
  } catch (err) {
    console.error('[SOFIA] Error obteniendo folios:', err);
    res.status(500).json({ error: 'Error al obtener folios' });
  }
});

// PATCH /api/sofia/folios/:id/estatus — actualizar estatus
router.patch('/folios/:id/estatus', async (req, res) => {
  const { estatus } = req.body;
  const estatusValidos = ['PENDIENTE', 'EN_BUSQUEDA', 'PROGRAMADO', 'EN_PROCESO', 'ENTREGADO', 'CONCLUIDO'];

  if (!estatusValidos.includes(estatus)) {
    return res.status(400).json({ error: `Estatus inválido. Válidos: ${estatusValidos.join(', ')}` });
  }

  try {
    const folio = await actualizarEstatusFolio(req.params.id, estatus);
    await registrarActividad('SOFIA', 'FOLIO_ACTUALIZADO', folio.folio, `Estatus actualizado a ${estatus}`);
    await publicarActividad('SOFIA', 'FOLIO_ACTUALIZADO', `Folio ${folio.folio} → ${estatus}`, { folio: folio.folio, estatus });
    res.json(folio);
  } catch (err) {
    console.error('[SOFIA] Error actualizando estatus:', err);
    res.status(500).json({ error: 'Error al actualizar estatus' });
  }
});

// GET /api/sofia/historial/:sessionId
router.get('/historial/:sessionId', async (req, res) => {
  try {
    const historial = await obtenerHistorialConversacion('SOFIA', req.params.sessionId);
    res.json(historial);
  } catch (err) {
    console.error('[SOFIA] Error obteniendo historial:', err);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

// GET /api/sofia/orden/:folio — consultar datos de una orden por folio
router.get('/orden/:folio', (req, res) => {
  const orden = ordersStore.obtenerOrden(req.params.folio);
  if (!orden) return res.status(404).json({ error: 'Folio no encontrado' });
  res.json(orden);
});

// GET /api/sofia/metricas
router.get('/metricas', async (req, res) => {
  try {
    const metricas = await obtenerMetricas();
    res.json(metricas);
  } catch (err) {
    console.error('[SOFIA] Error obteniendo métricas:', err);
    res.status(500).json({ error: 'Error al obtener métricas' });
  }
});

function buildOrdenContext(o) {
  const v  = (val) => val || '—';
  const ts = o.guardado ? new Date(o.guardado).toLocaleString('es-MX') : '—';

  return `

════════════════════════════════════════════════════════════════════════
ORDEN ACTIVA — ${o.folio}
Registrada por SARA el ${ts}
════════════════════════════════════════════════════════════════════════

⚠️  REGLA ABSOLUTA: TIENES TODOS LOS DATOS DEL CLIENTE Y DEL SERVICIO.
    ESTÁ PROHIBIDO preguntar al cliente cualquier cosa que esté en este bloque.
    Si el cliente pregunta algo que ya está aquí, respóndelo directamente.
    No pidas confirmación de datos que ya tienes.

── DATOS DEL CLIENTE ───────────────────────────────────────────────────
  Nombre completo : ${v(o.cliente)}
  Empresa         : ${v(o.empresa)}
  RFC             : ${v(o.rfc)}
  Teléfono        : ${v(o.telefono)}
  Email           : ${v(o.email)}

── DETALLES DEL SERVICIO ───────────────────────────────────────────────
  Ruta            : ${v(o.ruta || (o.origen && o.destino ? `${o.origen} → ${o.destino}` : null))}
  Origen          : ${v(o.origen)}
  Destino         : ${v(o.destino)}
  Tipo de unidad  : ${v(o.tipo_unidad)}
  Tipo de carga   : ${v(o.tipo_carga)}
  Mercancía       : ${v(o.descripcion_carga)}
  Peso            : ${v(o.peso_toneladas)} toneladas
  Fecha de carga  : ${v(o.fecha_carga)}
  Hora de cita    : ${v(o.hora_cita)}
  Requisitos esp. : ${v(o.requisitos)}

── DATOS COMERCIALES ───────────────────────────────────────────────────
  Precio cliente  : ${o.precio_cliente ? `$${Number(o.precio_cliente).toLocaleString('es-MX')} MXN` : '—'}
  Folio SARA      : ${v(o.folio)}
  Fuente          : ${v(o.fuente)}

── INSTRUCCIÓN OPERATIVA INMEDIATA ─────────────────────────────────────
  1. Saluda al cliente por su nombre (${v(o.cliente)}) — ya lo conoces.
  2. Confirma el folio ${o.folio} con un resumen compacto de la orden.
  3. Informa que el sistema YA está buscando transportista en paralelo.
  4. Avanza al Paso 3 — verificación de condiciones del carrier ganador.
  5. NO preguntes nada de lo que ya está arriba. CERO preguntas redundantes.

════════════════════════════════════════════════════════════════════════
`;
}

function detectarActualizacionFolio(respuesta) {
  const folioMatch = respuesta.match(/ABST-\d{6}/i);
  if (!folioMatch) return null;

  const estatusMap = {
    'en búsqueda': 'EN_BUSQUEDA',
    'en busqueda': 'EN_BUSQUEDA',
    'programado': 'PROGRAMADO',
    'en proceso': 'EN_PROCESO',
    'entregado': 'ENTREGADO',
    'concluido': 'CONCLUIDO',
  };

  const respuestaLower = respuesta.toLowerCase();
  for (const [texto, estatus] of Object.entries(estatusMap)) {
    if (respuestaLower.includes(texto)) {
      return { folio: folioMatch[0], estatus };
    }
  }
  return null;
}

module.exports = router;
