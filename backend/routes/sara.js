const express = require('express');
const router = express.Router();
const { chatStream } = require('../services/claude');
const { publicarNuevaOrden, publicarActividad } = require('../services/redis');
const { guardarMensaje, obtenerHistorialConversacion, registrarActividad } = require('../db/db');
const mem = require('../services/sessionMemory');
const tariff = require('../services/tariff');
const ordersStore = require('../services/ordersStore');
const { lanzarNegociacion } = require('../services/negociacion-wa');
const SARA_SYSTEM_PROMPT = require('../agents/sara-prompt');

const PROVEEDORES = (() => {
  try { return require('../data/proveedores.json'); } catch { return []; }
})();

// POST /api/sara/chat — streaming SSE
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
    mem.addMessage('SARA', sessionId, 'user', message);
    const historial = mem.getHistory('SARA', sessionId);

    // Sync con DB en background (sin bloquear)
    guardarMensaje('SARA', sessionId, 'user', message).catch(() => {});
    publicarActividad('SARA', 'MENSAJE_USUARIO', message.substring(0, 160), { sessionId }).catch(() => {});

    let respuestaCompleta = '';

    const systemPrompt = SARA_SYSTEM_PROMPT + tariff.getContext().prompt;

    await chatStream(
      systemPrompt,
      historial,
      (chunk) => {
        safeWrite(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
      },
      async (fullText) => {
        respuestaCompleta = fullText;
        // Guardar respuesta en memoria inmediatamente
        mem.addMessage('SARA', sessionId, 'assistant', fullText);
        guardarMensaje('SARA', sessionId, 'assistant', fullText).catch(() => {});
        registrarActividad('SARA', 'INFO', null, `Respuesta generada para sesión ${sessionId}`).catch(() => {});
        publicarActividad('SARA', 'MENSAJE_SARA', fullText.substring(0, 160), { sessionId }).catch(() => {});

        // Detectar cierre de chat o escalación
        if (/CERRAR_CHAT/i.test(fullText)) {
          safeWrite(`data: ${JSON.stringify({ type: 'cerrar_chat' })}\n\n`);
        }
        if (/ESCALAR_HUMANO/i.test(fullText)) {
          safeWrite(`data: ${JSON.stringify({ type: 'escalar_humano' })}\n\n`);
        }

        // Detectar si SARA está cerrando una venta y publicar evento
        if (detectarCierreVenta(fullText, message)) {
          const datosServicio = extraerDatosServicio(message, fullText);
          if (datosServicio) {
            // Guardar en store para que SOFIA acceda con solo el folio
            ordersStore.guardarOrden(datosServicio);
            await publicarNuevaOrden(datosServicio);
            await publicarActividad('SARA', 'CIERRE_VENTA', `Nueva orden publicada: ${datosServicio.folio || 'pendiente'}`, datosServicio);
            safeWrite(`data: ${JSON.stringify({ type: 'nueva_orden', datos: datosServicio })}\n\n`);

            // SOFIA lanza negociación WhatsApp con todos los carriers en paralelo
            if (PROVEEDORES.length) {
              lanzarNegociacion(datosServicio, PROVEEDORES)
                .then(r => publicarActividad('SOFIA', 'WA_NEGOCIACION_INICIADA',
                  `${r?.enviados || 0}/${r?.carriers || 0} carriers contactados — ${datosServicio.folio}`, r).catch(() => {}))
                .catch(err => console.error('[SARA→NegWA] Error iniciando negociación:', err.message));
            } else {
              console.warn('[SARA→NegWA] Sin proveedores en data/proveedores.json — negociación WA omitida');
            }
          }
        }
      },
      controller.signal
    );

    safeWrite(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    if (!res.writableEnded) res.end();
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('[SARA] Error en chat:', err);
      safeWrite(`data: ${JSON.stringify({ type: 'error', message: 'Error al procesar tu mensaje' })}\n\n`);
    }
    if (!res.writableEnded) res.end();
  }
});

// GET /api/sara/historial/:sessionId
router.get('/historial/:sessionId', async (req, res) => {
  try {
    const historial = await obtenerHistorialConversacion('SARA', req.params.sessionId);
    res.json(historial);
  } catch (err) {
    console.error('[SARA] Error obteniendo historial:', err);
    res.status(500).json({ error: 'Error al obtener historial' });
  }
});

// POST /api/sara/nueva-orden — publicar orden manualmente
router.post('/nueva-orden', async (req, res) => {
  try {
    await publicarNuevaOrden(req.body);
    await registrarActividad('SARA', 'CIERRE_VENTA', req.body.folio, `Nueva orden publicada manualmente`);
    res.json({ ok: true, mensaje: 'Orden publicada a SOFIA' });
  } catch (err) {
    console.error('[SARA] Error publicando orden:', err);
    res.status(500).json({ error: 'Error al publicar orden' });
  }
});

function detectarCierreVenta(respuesta, mensaje) {
  if (/NUEVA_ORDEN\s*:/i.test(respuesta)) return true;
  const triggers = [
    'servicio confirmado', 'venta cerrada', 'pasando a sofia', 'servicio registrado',
    'folio generado', 'orden creada', 'confirmo el servicio', 'publicando a sofia'
  ];
  const textoLower = (respuesta + ' ' + mensaje).toLowerCase();
  return triggers.some(t => textoLower.includes(t));
}

function extraerDatosServicio(mensaje, respuesta) {
  // Parsear el JSON completo que SARA genera al cerrar venta
  const match = respuesta.match(/NUEVA_ORDEN\s*:\s*(\{[\s\S]*?\})/i);
  if (match) {
    try {
      const datos = JSON.parse(match[1]);
      return { ...datos, fuente: 'chat_sara' };
    } catch (e) {
      console.error('[SARA] Error parseando NUEVA_ORDEN JSON:', e);
    }
  }
  // Fallback: solo folio
  const textoCompleto = mensaje + ' ' + respuesta;
  const folioMatch = textoCompleto.match(/ABST-\d{6}/i);
  return folioMatch ? { folio: folioMatch[0], fuente: 'chat_sara' } : null;
}

module.exports = router;
