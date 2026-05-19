// Servidor ligero — sin PostgreSQL ni Redis
// Requiere solo ANTHROPIC_API_KEY en .env
// Features: streaming SSE, memoria persistente, WhatsApp, TTS, tarifas dinámicas
require('dotenv').config();
const express = require('express');
const path    = require('path');
const https   = require('https');

const auth        = require('./backend/middleware/auth');
const sessions    = require('./backend/services/sessions');
const USERS       = require('./backend/data/users.json');
const { chatStream } = require('./backend/services/claude');
const memory      = require('./backend/services/memory');
const tariff      = require('./backend/services/tariff');
const SARA_PROMPT = require('./backend/agents/sara-prompt');
const SOFIA_PROMPT= require('./backend/agents/sofia-prompt');
const broadcast   = require('./backend/services/broadcast');
const gpsLive     = require('./backend/services/gps-live');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── ELEVENLABS ────────────────────────────────────────────────────────────
const EL_KEY         = process.env.ELEVENLABS_API_KEY;
const EL_VOICE_SARA  = process.env.ELEVENLABS_VOICE_SARA  || 'pFZP5JQG7iQjIQuC4Bku'; // Lily
const EL_VOICE_SOFIA = process.env.ELEVENLABS_VOICE_SOFIA || 'EXAVITQu4vr4xnSDxMaL'; // Bella
const EL_LIVE = EL_KEY && !EL_KEY.startsWith('xxxx');

// ─── WHATSAPP ──────────────────────────────────────────────────────────────
const WA_KEY  = process.env.WHATSAPP_API_KEY;
const WA_URL  = process.env.WHATSAPP_BASE_URL || 'https://waba.360dialog.io/v1';
const WA_LIVE = WA_KEY && !WA_KEY.startsWith('xxxx');

async function sendWhatsApp(to, text) {
  if (!WA_LIVE) {
    console.log(`[WA-STUB] → ${to}: ${text.slice(0, 80)}...`);
    return;
  }
  const body = JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
  return new Promise((resolve, reject) => {
    const url = new URL(`${WA_URL}/messages`);
    const req = https.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'D360-API-KEY': WA_KEY },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// ─── LOGIN / LOGOUT / ME (rutas públicas, antes del middleware de auth) ───────
app.get('/login', (req, res) => {
  // Siempre limpia la sesión activa al entrar al login
  const match = (req.headers.cookie || '').match(/abs_session=([^;]+)/);
  if (match) sessions.destroy(match[1]);
  res.setHeader('Set-Cookie', 'abs_session=; Path=/; Max-Age=0');
  res.sendFile(path.join(__dirname, 'frontend', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  // DEV MODE: acepta cualquier credencial, usa admin por defecto
  let user = USERS.find(u => u.email === email && u.password === password);
  if (!user) user = USERS.find(u => u.role === 'admin') || USERS[0];
  const { password: _, ...safe } = user;
  const sid = sessions.create(safe);
  res.setHeader('Set-Cookie', `abs_session=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
  res.json({ ok: true, user: safe });
});

app.post('/api/logout', (req, res) => {
  const match = (req.headers.cookie || '').match(/abs_session=([^;]+)/);
  if (match) sessions.destroy(match[1]);
  res.setHeader('Set-Cookie', 'abs_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// WhatsApp webhook — sin auth (viene de 360dialog)
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);
  try {
    const msgs = req.body?.messages;
    if (!msgs?.length) return;
    const msg = msgs[0];
    if (msg.type !== 'text') return;
    const phone   = msg.from;
    const texto   = msg.text.body.trim();
    const session = `wa_${phone}`;
    const { contextBlock, history } = memory.buildContext(session);
    const tariffCtx = tariff.getContext();
    const systemPrompt = buildPrompt('sara', contextBlock, tariffCtx);
    memory.addMessage(session, 'user', texto);
    let respuesta = '';
    await chatStream(systemPrompt, [...history, { role: 'user', content: texto }], (c) => { respuesta += c; }, () => {});
    memory.addMessage(session, 'assistant', respuesta);
    const bloques = splitForWhatsApp(respuesta);
    for (const bloque of bloques) await sendWhatsApp(phone, bloque);
    const metaMatch = respuesta.match(/empresa[:\s]+([^\n,.]+)/i);
    if (metaMatch) memory.updateMeta(session, { empresa: metaMatch[1].trim() });
  } catch (err) {
    console.error('[WhatsApp webhook error]', err.message);
  }
});

app.get('/webhook/whatsapp', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === (process.env.WHATSAPP_VERIFY_TOKEN || 'abstorages')) {
    res.send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recursos públicos (logo, CSS del login) accesibles sin sesión
app.use('/img', express.static(path.join(__dirname, 'frontend', 'img')));
app.use('/css', express.static(path.join(__dirname, 'frontend', 'css')));

// Página del chofer — URL pública autenticada con token GPS
app.get('/tracker', (req, res) => {
  if (req.query.token !== gpsLive.GPS_TOKEN)
    return res.status(401).send('<h2 style="font-family:sans-serif;padding:40px">Enlace inválido. Solicita uno nuevo a ABSTORAGES.</h2>');
  res.sendFile(path.join(__dirname, 'frontend', 'tracker.html'));
});

// GPS update — usa token propio, no sesión de usuario (trackers y página del chofer)
app.post('/api/gps/update', (req, res) => {
  const token = req.headers['x-gps-token'] || req.body.token;
  if (token !== gpsLive.GPS_TOKEN)
    return res.status(401).json({ error: 'Token inválido' });
  const { folio, lat, lng, velocidad = 0, rumbo = 0, chofer = '', estatus = 'EN_PROCESO', fuente = 'device' } = req.body;
  if (!folio || lat == null || lng == null)
    return res.status(400).json({ error: 'folio, lat y lng son requeridos' });
  const registro = gpsLive.actualizar(folio, { lat: +lat, lng: +lng, velocidad: +velocidad, rumbo: +rumbo, chofer, estatus, fuente });
  res.json({ ok: true, ts: registro.ts });
});

app.use(auth);
app.use(express.static(path.join(__dirname, 'frontend')));

app.get('/api/me', (req, res) => {
  const { password: _, _ts, ...safe } = req.user;
  res.json(safe);
});

// ─── BROADCAST / CAMPAÑAS WHATSAPP ───────────────────────────────────────────
app.get('/api/broadcast/templates', (req, res) => {
  res.json(broadcast.getTemplates());
});

app.get('/api/broadcast/campaigns', (req, res) => {
  res.json(broadcast.listCampaigns());
});

app.post('/api/broadcast/start', (req, res) => {
  const { template, destinatarios } = req.body;
  if (!template || !Array.isArray(destinatarios) || destinatarios.length === 0)
    return res.status(400).json({ error: 'Faltan template o destinatarios' });
  if (destinatarios.length > 1000)
    return res.status(400).json({ error: 'Máximo 1000 destinatarios por campaña' });
  const id = broadcast.startCampaign({ template, destinatarios });
  res.json({ ok: true, id });
});

app.get('/api/broadcast/status/:id', (req, res) => {
  const c = broadcast.getCampaign(req.params.id);
  if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
  res.json(c);
});

app.post('/api/broadcast/cancel/:id', (req, res) => {
  broadcast.cancelCampaign(req.params.id);
  res.json({ ok: true });
});

// ─── RUTAS ESTÁTICAS ──────────────────────────────────────────────────────
app.get('/simulator', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'simulator.html')));

app.get('/api/health', (req, res) => res.json({
  ok: true, mode: 'lite',
  whatsapp: WA_LIVE ? 'live' : 'stub',
  tts: EL_LIVE ? 'live' : 'stub',
  timestamp: new Date().toISOString(),
}));

app.get('/api/metricas', (req, res) => {
  res.json({ folios_activos: 0, folios_hoy: 0, proveedores_activos: 0, alertas_activas: 0 });
});

app.get('/api/sofia/folios', (req, res) => res.json([]));

app.get('/api/sessions', (req, res) => res.json(memory.listSessions()));

// ─── TARIFA DINÁMICA ──────────────────────────────────────────────────────
app.get('/api/tarifa/contexto', (req, res) => {
  res.json(tariff.getContext());
});

// ─── ALERTAS PREDICTIVAS (mock con lógica real) ───────────────────────────
const RIESGO_ZONAS = ['Tepeji del Río', 'Palmillas', 'Huehuetoca', 'Santa Ana Pacueco', 'El Ejido'];

app.get('/api/alertas/predictivas', (req, res) => {
  const ahora = Date.now();
  // Simulación determinista: alertas cambian cada 5 minutos
  const seed = Math.floor(ahora / 300000);

  const alertas = [
    {
      id: 'PA-001',
      nivel: 'CRITICO',
      unidad: 'ABST-000077',
      chofer: 'Roberto Silva',
      ruta: 'CDMX → Querétaro',
      zona: 'Tepeji del Río',
      trigger: '3 paradas no programadas · Velocidad anómala · Zona de riesgo histórico',
      tiempo_detenida: 42,
      accion: 'Contacto inmediato — posible intercepción',
    },
    ...(seed % 3 === 0 ? [{
      id: 'PA-002',
      nivel: 'ADVERTENCIA',
      unidad: 'ABST-000089',
      chofer: 'Miguel Torres',
      ruta: 'CDMX → Veracruz',
      zona: 'Palmillas, Qro',
      trigger: 'Velocidad reducida 40% del promedio · 2 desvíos de ruta',
      tiempo_detenida: 0,
      accion: 'Monitorear — check en 15 min',
    }] : []),
  ];

  res.json({ alertas, total: alertas.length, generado: new Date().toISOString() });
});

// ─── TTS — ElevenLabs ─────────────────────────────────────────────────────
app.post('/api/tts', async (req, res) => {
  const { text, agente } = req.body;
  if (!text) return res.status(400).json({ error: 'text requerido' });

  if (!EL_LIVE) {
    return res.status(503).json({ error: 'ElevenLabs no configurado', hint: 'Agrega ELEVENLABS_API_KEY al .env' });
  }

  const voiceId = agente === 'sofia' ? EL_VOICE_SOFIA : EL_VOICE_SARA;
  const body = JSON.stringify({
    text: text.slice(0, 2500),
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.55, similarity_boost: 0.78, style: 0.3, use_speaker_boost: true },
  });

  try {
    await new Promise((resolve, reject) => {
      const req2 = https.request({
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${voiceId}/stream`,
        method: 'POST',
        headers: {
          'xi-api-key': EL_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
      }, (apiRes) => {
        if (apiRes.statusCode !== 200) {
          let err = '';
          apiRes.on('data', d => { err += d; });
          apiRes.on('end', () => reject(new Error(`EL ${apiRes.statusCode}: ${err}`)));
          return;
        }
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');
        apiRes.pipe(res);
        apiRes.on('end', resolve);
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });
  } catch (err) {
    console.error('[TTS error]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── REPORTE DE ENTREGA (generado por SOFIA al cerrar un folio) ────────────
app.post('/api/sofia/reporte-entrega', async (req, res) => {
  const { folio, cliente, destinatario, ruta, chofer, observaciones } = req.body;
  if (!folio) return res.status(400).json({ error: 'folio requerido' });

  const fecha = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
  const hora  = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

  const reporte = {
    folio,
    fecha,
    hora,
    cliente,
    destinatario,
    ruta,
    chofer,
    observaciones: observaciones || 'Entrega completada sin incidencias.',
    calificacion_abcontrol: 'CERTIFICADO',
    estado_final: 'ENTREGADO',
    mensaje_destinatario: `Tu carga (folio ${folio}) fue entregada el ${fecha} a las ${hora}. Ruta: ${ruta}. Transportista calificado ABCONTROL. Estado: sin incidencias. — ABSTORAGES Logistics Solutions`,
  };

  // Loguear como actividad
  console.log(`[Reporte Entrega] ${folio} → ${destinatario}`);

  res.json({ ok: true, reporte });
});

// ─── HELPERS ──────────────────────────────────────────────────────────────
function buildPrompt(agente, contextBlock, tariffCtx) {
  const base = agente === 'sara' ? SARA_PROMPT : SOFIA_PROMPT;
  const tariffBlock = `\n\n## MERCADO ACTUAL (actualizado en tiempo real)\n${tariffCtx.prompt}`;
  return contextBlock
    ? `${base}${tariffBlock}\n\n${contextBlock}`
    : `${base}${tariffBlock}`;
}

// ─── CHAT (SSE streaming con memoria + tarifa dinámica) ───────────────────
async function handleChat(agente, req, res) {
  const { message, sessionId } = req.body;
  if (!message) return res.status(400).json({ error: 'message requerido' });

  const sid = sessionId || `web_${agente}_${Date.now()}`;
  const { contextBlock, history } = memory.buildContext(sid);
  const tariffCtx = tariff.getContext();
  const systemPrompt = buildPrompt(agente, contextBlock, tariffCtx);
  const messages = [...history, { role: 'user', content: message }];

  memory.addMessage(sid, 'user', message);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let fullText = '';
  try {
    await chatStream(
      systemPrompt,
      messages,
      (chunk) => {
        fullText += chunk;
        res.write(`data: ${JSON.stringify({ type: 'chunk', text: chunk })}\n\n`);
      },
      () => {},
    );
    memory.addMessage(sid, 'assistant', fullText);

    // Detectar si SOFIA cerró un folio para loguear reporte
    if (agente === 'sofia' && /CONCLUIDO|entregado.*acuse|carga entregada/i.test(fullText)) {
      res.write(`data: ${JSON.stringify({ type: 'folio_update', estatus: 'ENTREGADO' })}\n\n`);
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  }

  res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  res.end();
}

app.post('/api/sara/chat',  (req, res) => handleChat('sara',  req, res));
app.post('/api/sofia/chat', (req, res) => handleChat('sofia', req, res));

// ─── GPS EN TIEMPO REAL ───────────────────────────────────────────────────────

// GET — lista todas las posiciones en vivo (para el mapa del portal)
app.get('/api/gps/live', (req, res) => {
  res.json(gpsLive.listar());
});

// SSE — stream de actualizaciones en tiempo real para el mapa
app.get('/api/gps/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  gpsLive.agregarListener(res);
  req.on('close', () => gpsLive.removerListener(res));
});


// ─── HELPERS ──────────────────────────────────────────────────────────────
function splitForWhatsApp(text, maxLen = 1500) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > i) end = nl;
    }
    chunks.push(text.slice(i, end).trim());
    i = end;
  }
  return chunks;
}

// ─── START ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ABSTORAGES AI Portal (modo lite)`);
  console.log(`  Portal:    http://localhost:${PORT}`);
  console.log(`  Simulator: http://localhost:${PORT}/simulator`);
  console.log(`  WhatsApp:  ${WA_LIVE ? '🟢 LIVE' : '🟡 stub'}`);
  console.log(`  TTS Voz:   ${EL_LIVE ? '🟢 LIVE' : '🟡 stub (agrega ELEVENLABS_API_KEY)'}`);
  console.log(`  Tarifas:   🟢 dinámicas\n`);
});
