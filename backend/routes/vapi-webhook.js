const express = require('express');
const router = express.Router();
const { procesarResultadoLlamada, obtenerEstadoLlamadas } = require('../services/vapi');
const { publicarActividad } = require('../services/redis');

// POST /api/vapi/webhook — Vapi manda aquí el resultado de cada llamada
router.post('/webhook', express.json(), async (req, res) => {
  const evento = req.body;
  res.sendStatus(200); // responder rápido a Vapi

  try {
    const tipo = evento.message?.type || evento.type;

    if (tipo !== 'end-of-call-report' && tipo !== 'call-ended') return;

    const resultado = procesarResultadoLlamada({
      call: evento.message?.call || evento.call || evento,
    });

    if (!resultado) return;

    console.log(`[Vapi Webhook] Folio ${resultado.folio} | Proveedor ${resultado.proveedorId} | Disponible: ${resultado.disponible} | Precio: ${resultado.precio}`);

    // Publicar resultado a actividad (Centro de Mando lo ve en tiempo real)
    await publicarActividad('SOFIA', 'VAPI_RESULTADO',
      `${resultado.proveedorId} → ${resultado.disponible ? `DISPONIBLE ${resultado.precio || '(precio pendiente)'}` : 'NO DISPONIBLE'}`,
      { folio: resultado.folio, ...resultado }
    ).catch(() => {});

    // Si hay ganador, publicar evento especial
    const estado = obtenerEstadoLlamadas(resultado.folio);
    if (estado?.ganador?.proveedorId === resultado.proveedorId) {
      await publicarActividad('SOFIA', 'PROVEEDOR_GANADOR',
        `Folio ${resultado.folio} → ${resultado.proveedorId} a ${resultado.precio}`,
        { folio: resultado.folio, ganador: estado.ganador }
      ).catch(() => {});
    }
  } catch (err) {
    console.error('[Vapi Webhook] Error procesando resultado:', err);
  }
});

// GET /api/vapi/estado/:folio — estado de las llamadas de un folio
router.get('/estado/:folio', (req, res) => {
  const estado = obtenerEstadoLlamadas(req.params.folio);
  if (!estado) return res.status(404).json({ error: 'Folio no encontrado o sin llamadas' });
  res.json(estado);
});

module.exports = router;
