const express = require('express');
const router = express.Router();
const { chatStream } = require('../services/claude');
const { publicarNuevaOrden, publicarActividad } = require('../services/redis');
const { guardarMensaje, obtenerHistorialConversacion, registrarActividad } = require('../db/db');
const SARA_SYSTEM_PROMPT = require('../agents/sara-prompt');

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

  try {
    let historial = [];
    try { historial = await obtenerHistorialConversacion('SARA', sessionId); } catch (_) {}
    historial.push({ role: 'user', content: message });

    try { await guardarMensaje('SARA', sessionId, 'user', message); } catch (_) {}
    publicarActividad('SARA', 'MENSAJE_USUARIO', message.substring(0, 160), { sessionId }).catch(() => {});

    let respuestaCompleta = '';

    await chatStream(
      SARA_SYSTEM_PROMPT,
      historial,
      (chunk) => {
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
      },
      async (fullText) => {
        respuestaCompleta = fullText;
        try { await guardarMensaje('SARA', sessionId, 'assistant', fullText); } catch (_) {}
        try { await registrarActividad('SARA', 'INFO', null, `Respuesta generada para sesión ${sessionId}`); } catch (_) {}
        publicarActividad('SARA', 'MENSAJE_SARA', fullText.substring(0, 160), { sessionId }).catch(() => {});

        // Detectar si SARA está cerrando una venta y publicar evento
        if (detectarCierreVenta(fullText, message)) {
          const datosServicio = extraerDatosServicio(message, fullText);
          if (datosServicio) {
            await publicarNuevaOrden(datosServicio);
            await publicarActividad('SARA', 'CIERRE_VENTA', `Nueva orden publicada: ${datosServicio.folio || 'pendiente'}`, datosServicio);
            res.write(`data: ${JSON.stringify({ type: 'nueva_orden', datos: datosServicio })}\n\n`);
          }
        }
      }
    );

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[SARA] Error en chat:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Error al procesar tu mensaje' })}\n\n`);
    res.end();
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
  const triggers = [
    'servicio confirmado', 'venta cerrada', 'pasando a sofia', 'servicio registrado',
    'folio generado', 'orden creada', 'confirmo el servicio', 'publicando a sofia'
  ];
  const textoLower = (respuesta + ' ' + mensaje).toLowerCase();
  return triggers.some(t => textoLower.includes(t));
}

function extraerDatosServicio(mensaje, respuesta) {
  // Extracción básica — en producción, usar tool_use de Claude para estructurar datos
  const textoCompleto = mensaje + ' ' + respuesta;
  const folioMatch = textoCompleto.match(/ABST-\d{6}/i);
  return folioMatch ? { folio: folioMatch[0], fuente: 'chat_sara' } : null;
}

module.exports = router;
