// ── Webhook WhatsApp / 360dialog — mensajes entrantes de transportistas ───────
// 360dialog envía a este endpoint cada vez que un carrier responde.
// Ruteamos al motor de negociación correspondiente.

const express = require('express');
const router  = express.Router();
const { procesarRespuesta, obtenerNegociacion } = require('../services/negociacion-wa');
const { publicarActividad } = require('../services/redis');

// POST /api/whatsapp/webhook
// 360dialog llama aquí con cada mensaje entrante
router.post('/webhook', express.json(), async (req, res) => {
  // Responder 200 inmediatamente para que 360dialog no reintente
  res.sendStatus(200);

  try {
    const payload = req.body;

    // 360dialog: estructura statuses + messages en el mismo payload
    const messages = payload?.messages || payload?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;

    for (const msg of messages) {
      // Solo procesar mensajes de texto
      if (msg.type !== 'text') continue;

      const de    = msg.from;           // número del carrier (formato internacional)
      const texto = msg.text?.body || '';
      const ts    = msg.timestamp;

      if (!de || !texto) continue;

      console.log(`[WA Webhook] Mensaje entrante de ${de}: "${texto.substring(0, 100)}"`);

      // Procesar en negociación (async — no bloqueamos el loop)
      const ganador = await procesarRespuesta(de, texto).catch(err => {
        console.error('[WA Webhook] Error procesando respuesta:', err.message);
        return null;
      });

      if (ganador) {
        publicarActividad('SOFIA', 'WA_GANADOR_CONFIRMADO',
          `${ganador.nombre} — $${ganador.precioFinal?.toLocaleString()} MXN`,
          { ganador }
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[WA Webhook] Error general:', err);
  }
});

// GET /api/whatsapp/negociacion/:folio — estado de negociación activa
router.get('/negociacion/:folio', (req, res) => {
  const neg = obtenerNegociacion(req.params.folio);
  if (!neg) return res.status(404).json({ error: 'No hay negociación activa para ese folio' });

  // Resumen sin historial completo (puede ser muy largo)
  const resumen = {
    folio:        neg.folio,
    precioCliente: neg.precioCliente,
    precioTecho:   neg.precioTecho,
    ganador:       neg.ganador,
    inicio:        neg.inicio,
    carriers: Object.fromEntries(
      Object.entries(neg.carriers).map(([tel, c]) => [
        tel,
        { nombre: c.nombre, estado: c.estado, rondas: c.rondas, precioOfertado: c.precioOfertado }
      ])
    ),
  };

  res.json(resumen);
});

module.exports = router;
