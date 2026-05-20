const express = require('express');
const router = express.Router();
const { chatStream } = require('../services/claude');
const { guardarMensaje, obtenerHistorialConversacion, registrarActividad } = require('../db/db');
const LUCA_SYSTEM_PROMPT = require('../agents/luca-prompt');

// POST /api/luca/chat — streaming SSE
router.post('/chat', async (req, res) => {
  const { message, sessionId = 'luca-default' } = req.body;

  if (!message) return res.status(400).json({ error: 'message requerido' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    let historial = [];
    try { historial = await obtenerHistorialConversacion('LUCA', sessionId); } catch (_) {}
    historial.push({ role: 'user', content: message });

    try { await guardarMensaje('LUCA', sessionId, 'user', message); } catch (_) {}

    await chatStream(
      LUCA_SYSTEM_PROMPT,
      historial,
      (chunk) => {
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
      },
      async (fullText) => {
        try { await guardarMensaje('LUCA', sessionId, 'assistant', fullText); } catch (_) {}
        try { await registrarActividad('LUCA', 'INFO', null, `Respuesta generada para sesión ${sessionId}`); } catch (_) {}

        // Detectar registro completo
        if (fullText.includes('REGISTRO_CARRIER_COMPLETO:')) {
          try {
            const jsonMatch = fullText.match(/REGISTRO_CARRIER_COMPLETO:\s*(\{[\s\S]*?\})/);
            if (jsonMatch) {
              const datos = JSON.parse(jsonMatch[1]);
              await guardarCarrier(datos, sessionId);
              res.write(`data: ${JSON.stringify({ type: 'carrier_registrado', datos })}\n\n`);
            }
          } catch (_) {}
        }
      }
    );

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    console.error('[LUCA] Error:', err);
    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Error al procesar tu mensaje' })}\n\n`);
    res.end();
  }
});

async function guardarCarrier(datos, sessionId) {
  try {
    const { pool } = require('../db/db');
    await pool.query(
      `INSERT INTO carriers (nombre, telefono, unidades, zona, disponibilidad, capacidad, documentacion, session_id, registered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (telefono) DO UPDATE SET
         nombre=$1, unidades=$3, zona=$4, disponibilidad=$5, capacidad=$6, documentacion=$7, session_id=$8`,
      [
        datos.nombre,
        datos.telefono,
        JSON.stringify(datos.unidades || []),
        datos.zona,
        datos.disponibilidad,
        datos.capacidad,
        JSON.stringify(datos.documentacion || {}),
        sessionId,
      ]
    );
  } catch (_) {}
}

module.exports = router;
