const express = require('express');
const router  = express.Router();
const { chat } = require('../services/claude');
const { searchAll, apiStatus } = require('../services/prospector-apis');

// GET /api/prospector/status — estado de las API keys configuradas
router.get('/status', (req, res) => {
  res.json(apiStatus());
});

// POST /api/prospector/generate — busca prospectos reales, genera mensajes con IA
router.post('/generate', async (req, res) => {
  const { sector = 'alimentos y bebidas', zona = 'todo-mexico', limit = 10 } = req.body;

  try {
    // 1. Buscar en APIs reales
    const { prospectos: reales, sources } = await searchAll(sector, zona, Number(limit));

    if (reales.length > 0) {
      // 2. Enriquecer con mensaje WhatsApp via Claude (solo para los que tienen empresa)
      const enriquecidos = await agregarMensajes(reales, sector);
      return res.json({ prospectos: enriquecidos, fuentes: sources, modo: 'real' });
    }

    // 3. Fallback: generar con IA cuando no hay APIs activas
    const generados = await generarConIA(sector, zona, Number(limit));
    return res.json({ prospectos: generados, fuentes: ['IA Generativa'], modo: 'ia' });

  } catch (err) {
    console.error('[Prospector] Error:', err.message);
    res.status(500).json({ error: 'Error al buscar prospectos: ' + err.message });
  }
});

// ── Genera mensaje WhatsApp personalizado para cada prospecto ─────────────────
async function agregarMensajes(prospectos, sector) {
  const lista = prospectos.map((p, i) =>
    `${i + 1}. Empresa: ${p.empresa || 'N/A'} | Contacto: ${p.nombre || ''} ${p.cargo ? '(' + p.cargo + ')' : ''} | Giro: ${p.giro || sector} | Ciudad: ${p.ciudad || 'México'}`
  ).join('\n');

  try {
    const prompt = `Eres SARA, ejecutiva comercial de ABSTORAGES Logistics Solutions (empresa de flete y logística 3PL en México).
Genera un mensaje de WhatsApp breve, profesional y personalizado para cada uno de estos prospectos del sector ${sector}.
El objetivo es presentarte y explorar si necesitan servicios de transporte de carga.
Responde SOLO con un JSON array donde cada elemento tiene: {"index": N, "mensaje": "..."}
No incluyas explicaciones, solo el JSON.

Prospectos:
${lista}`;

    const raw = (await chat('', [{ role: 'user', content: prompt }]))
      .trim().replace(/^```json\s*/, '').replace(/```$/, '');
    const mensajes = JSON.parse(raw);
    const mapaM = {};
    for (const m of mensajes) mapaM[m.index - 1] = m.mensaje;
    return prospectos.map((p, i) => ({ ...p, mensaje: mapaM[i] || '' }));
  } catch (_) {
    return prospectos.map(p => ({ ...p, mensaje: '' }));
  }
}

// ── Fallback IA cuando no hay APIs activas ────────────────────────────────────
async function generarConIA(sector, zona, limit) {
  const zonaTexto = zona === 'todo-mexico' ? 'todo México' : zona;

  const prompt = `Genera ${limit} prospectos representativos del sector "${sector}" en ${zonaTexto} para una empresa de logística y flete (ABSTORAGES).
Responde SOLO con un JSON array. Cada elemento debe tener exactamente estos campos:
- empresa: nombre de empresa real o realista
- giro: descripción del giro (ej: "Distribuidora de snacks y botanas")
- ciudad: ciudad mexicana
- nombre: nombre completo de una persona de contacto
- cargo: puesto (ej: "Director de Compras", "Gerente de Logística")
- email: email corporativo realista (no inventar dominios reales de empresas reales)
- telefono: teléfono mexicano con formato +52...
- website: dominio web realista
- mensaje: mensaje de WhatsApp breve y profesional de SARA de ABSTORAGES presentándose
No incluyas markdown, solo el JSON array.`;

  const raw = (await chat('', [{ role: 'user', content: prompt }]))
    .trim().replace(/^```json\s*/, '').replace(/```$/, '');
  const generados = JSON.parse(raw);
  return generados.map(p => ({ ...p, fuente: 'IA Generativa' }));
}

module.exports = router;
