const express = require('express');
const router = express.Router();
const { chatStream } = require('../services/claude');
const { publicarActividad, suscribirNuevaOrden } = require('../services/redis');
const { guardarMensaje, obtenerHistorialConversacion, registrarActividad, actualizarEstatusFolio, obtenerFolioActivo, obtenerMetricas } = require('../db/db');
const mem = require('../services/sessionMemory');
const SOFIA_SYSTEM_PROMPT = require('../agents/sofia-prompt');

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

  try {
    // Memoria en tiempo real (funciona sin PostgreSQL)
    mem.addMessage('SOFIA', sessionId, 'user', message);
    const historial = mem.getHistory('SOFIA', sessionId);

    // Sync con DB en background (sin bloquear)
    guardarMensaje('SOFIA', sessionId, 'user', message).catch(() => {});
    publicarActividad('SOFIA', 'MENSAJE_USUARIO', message.substring(0, 160), { sessionId }).catch(() => {});

    await chatStream(
      SOFIA_SYSTEM_PROMPT,
      historial,
      (chunk) => {
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
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
          res.write(`data: ${JSON.stringify({ type: 'folio_update', ...actualizacion })}\n\n`);
        }
      }
    );

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[SOFIA] Error en chat:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Error al procesar tu mensaje' })}\n\n`);
    res.end();
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
