// Servidor ligero — sin PostgreSQL ni Redis
// Solo requiere ANTHROPIC_API_KEY en .env
require('dotenv').config();
const express = require('express');
const path = require('path');
const basicAuth = require('./backend/middleware/auth');
const { chatStream } = require('./backend/services/claude');
const SARA_PROMPT = require('./backend/agents/sara-prompt');
const SOFIA_PROMPT = require('./backend/agents/sofia-prompt');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(basicAuth);
app.use(express.static(path.join(__dirname, 'frontend')));

app.get('/simulator', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'simulator.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mode: 'lite', timestamp: new Date().toISOString() });
});

app.get('/api/metricas', (req, res) => {
  res.json({ folios_activos: 0, folios_hoy: 0, proveedores_activos: 0, alertas_activas: 0 });
});

app.get('/api/sofia/folios', (req, res) => res.json([]));

async function handleChat(agente, req, res) {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message requerido' });

  const prompt = agente === 'sara' ? SARA_PROMPT : SOFIA_PROMPT;
  const history = [{ role: 'user', content: message }];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    await chatStream(prompt, history,
      (chunk) => res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`),
      () => {}
    );
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  }

  res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  res.end();
}

app.post('/api/sara/chat', (req, res) => handleChat('sara', req, res));
app.post('/api/sofia/chat', (req, res) => handleChat('sofia', req, res));

app.listen(PORT, () => {
  console.log(`\n  ABSTORAGES AI Portal (modo lite)`);
  console.log(`  Portal:    http://localhost:${PORT}`);
  console.log(`  Simulator: http://localhost:${PORT}/simulator\n`);
});
