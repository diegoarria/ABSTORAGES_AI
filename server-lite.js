// Servidor ligero — sin PostgreSQL ni Redis
// Requiere solo ANTHROPIC_API_KEY en .env
// Features: streaming SSE, memoria persistente, WhatsApp, TTS, tarifas dinámicas
require('dotenv').config();
const express = require('express');
const path    = require('path');
const https   = require('https');

const { saveMessage, getMessages } = require('./backend/services/db');
const auth        = require('./backend/middleware/auth');
const sessions    = require('./backend/services/sessions');
const USERS       = require('./backend/data/users.json');
const { chatStream } = require('./backend/services/claude');
const memory      = require('./backend/services/memory');
const tariff      = require('./backend/services/tariff');
const SARA_PROMPT   = require('./backend/agents/sara-prompt');
const SOFIA_PROMPT  = require('./backend/agents/sofia-prompt');
const HECTOR_PROMPT = require('./backend/agents/hector-prompt');
const NOA_PROMPT    = require('./backend/agents/noa-prompt');
const cors        = require('cors');
const broadcast   = require('./backend/services/broadcast');
const gpsLive     = require('./backend/services/gps-live');
const leads       = require('./backend/services/leads');
const notifier    = require('./backend/services/notifier');
const vapi        = require('./backend/services/vapi');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── ACTIVIDAD EN TIEMPO REAL (SSE) ───────────────────────────────────────
const actividadClients = new Set();
const actividadHistorial = [];
const ACTIVIDAD_MAX = 100;

function pushActividad(evento) {
  const ev = { ...evento, timestamp: evento.timestamp || new Date().toISOString() };
  actividadHistorial.push(ev);
  if (actividadHistorial.length > ACTIVIDAD_MAX) actividadHistorial.shift();
  const msg = `data: ${JSON.stringify({ type: 'actividad', ...ev })}\n\n`;
  actividadClients.forEach(c => { try { c.write(msg); } catch {} });
}

// ─── ELEVENLABS ────────────────────────────────────────────────────────────
const EL_KEY         = process.env.ELEVENLABS_API_KEY;
const EL_VOICE_SARA  = process.env.ELEVENLABS_VOICE_SARA  || 'pFZP5JQG7iQjIQuC4Bku'; // Lily
const EL_VOICE_SOFIA = process.env.ELEVENLABS_VOICE_SOFIA || 'EXAVITQu4vr4xnSDxMaL'; // Bella
const EL_LIVE = EL_KEY && !EL_KEY.startsWith('xxxx');

// ─── WHATSAPP ──────────────────────────────────────────────────────────────
const WA_KEY      = process.env.WHATSAPP_API_KEY;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID; // 360dialog Cloud API
const WA_LIVE     = WA_KEY && !WA_KEY.startsWith('xxxx');

async function sendWhatsApp(to, text) {
  if (!WA_LIVE) {
    console.log(`[WA-STUB] → ${to}: ${text.slice(0, 80)}`);
    return;
  }
  // 360dialog WABA v2 — formato sin messaging_product
  const payload = JSON.stringify({ to, type: 'text', text: { body: text } });
  console.log(`[WA] Enviando a ${to}: ${text.slice(0, 60)}...`);
  try {
    const r = await fetch('https://waba-v2.360dialog.io/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'D360-API-KEY': WA_KEY },
      body: payload,
    });
    const resp = await r.text();
    if (!r.ok) {
      console.error(`[WA] Error ${r.status}: ${resp}`);
      // Fallback: intentar con messaging_product (Cloud API format)
      const r2 = await fetch('https://waba-v2.360dialog.io/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'D360-API-KEY': WA_KEY },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
      });
      const resp2 = await r2.text();
      console.log(`[WA] Fallback status ${r2.status}: ${resp2.slice(0, 300)}`);
    } else {
      console.log(`[WA] OK → ${to}: ${resp.slice(0, 100)}`);
    }
  } catch (e) {
    console.error('[WA] Error enviando:', e.message);
  }
}

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));

// CORS abierto solo para el widget (rutas /api/widget/* y /widget)
app.use('/api/widget', cors());
app.use('/widget', cors());

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

// WhatsApp webhook — sin auth (viene de 360dialog / Meta Cloud API)
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);
  console.log('[WA-IN] body:', JSON.stringify(req.body).slice(0, 600));
  try {
    // Formato Meta Cloud API (360dialog DCHUB)
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    // Formato legacy 360dialog (fallback)
    const msgs = value?.messages ?? req.body?.messages;
    if (!msgs?.length) { console.log('[WA-IN] sin mensajes, ignorando'); return; }
    const msg = msgs[0];
    if (msg.type !== 'text') { console.log('[WA-IN] tipo no texto:', msg.type); return; }
    const phone   = msg.from;
    const texto   = msg.text.body.trim();
    const session = `wa_${phone}`;
    const { contextBlock, history } = memory.buildContext(session);
    const esPrimerMensaje = history.length === 0; // capturado antes de agregar el mensaje actual
    const tariffCtx = tariff.getContext();
    const systemPrompt = buildPrompt('sara', contextBlock, tariffCtx);
    memory.addMessage(session, 'user', texto);
    saveMessage(session, 'sara', 'user', texto);
    let respuesta = '';
    await chatStream(systemPrompt, [...history, { role: 'user', content: texto }], (c) => { respuesta += c; }, () => {});
    memory.addMessage(session, 'assistant', respuesta);
    saveMessage(session, 'sara', 'assistant', respuesta);
    const bloques = splitForWhatsApp(respuesta);
    for (const bloque of bloques) await sendWhatsApp(phone, bloque);
    const metaMatch = respuesta.match(/empresa[:\s]+([^\n,.]+)/i);
    if (metaMatch) memory.updateMeta(session, { empresa: metaMatch[1].trim() });

    // Notificar al equipo: primer contacto vía WhatsApp + señales de cierre
    const leadDataWA = respuesta.match(/LEAD_DATA:\s*(\{[^\n]+\})/);
    let datosWA = {};
    try { if (leadDataWA) datosWA = JSON.parse(leadDataWA[1]); } catch {}
    const waHasCierre  = /NUEVA_ORDEN/i.test(respuesta);
    const waHasEscalar = /ESCALAR_HUMANO/i.test(respuesta);
    const waHasCerrar  = /CERRAR_CHAT/i.test(respuesta);
    const waNota = waHasCierre ? 'cierre_de_venta' : waHasEscalar ? 'escalado_a_operaciones' : waHasCerrar ? 'chat_cerrado' : 'cotizacion_en_proceso';
    const leadWA = leads.add({ ...datosWA, sara_nota: waNota, primer_mensaje: texto.slice(0, 300), sessionId: session, canal: 'whatsapp' });
    if (esPrimerMensaje) {
      notifier.notificarLead(leadWA).catch(e => console.error('[notifier WA primer-contacto]', e.message));
    }
    if (waHasCierre || waHasEscalar || waHasCerrar) {
      const histWA = memory.buildContext(session).history || [];
      notifier.notificarResumen(leadWA, waNota, histWA).catch(e => console.error('[notifier WA resumen]', e.message));
    }
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

// ─── WIDGET (público — sin auth, para embedding en landing pages) ───────────
app.get('/widget', (req, res) =>
  res.sendFile(path.join(__dirname, 'frontend', 'sara-widget.html')));
app.get('/sara-widget.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'frontend', 'sara-widget.js'));
});

// Chat público del widget — misma lógica que /api/sara/chat pero sin auth
app.post('/api/widget/chat', (req, res) => handleChat('sara', req, res));

// TTS público para el widget — sin auth, solo voz de SARA
app.post('/api/widget/tts', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text requerido' });
  if (!EL_LIVE) return res.status(503).json({ error: 'TTS no disponible' });

  const body = JSON.stringify({
    text: text.slice(0, 2500),
    model_id: 'eleven_multilingual_v2',
    voice_settings: { stability: 0.72, similarity_boost: 0.80, style: 0.2, use_speaker_boost: true, speed: 1.05 },
  });

  try {
    await new Promise((resolve, reject) => {
      const r2 = https.request({
        hostname: 'api.elevenlabs.io',
        path: `/v1/text-to-speech/${EL_VOICE_SARA}/stream`,
        method: 'POST',
        headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      }, (apiRes) => {
        if (apiRes.statusCode !== 200) {
          let err = ''; apiRes.on('data', d => { err += d; });
          apiRes.on('end', () => reject(new Error(`EL ${apiRes.statusCode}: ${err}`))); return;
        }
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');
        apiRes.pipe(res); apiRes.on('end', resolve);
      });
      r2.on('error', reject); r2.write(body); r2.end();
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

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

app.get('/api/health', async (req, res) => {
  const { pool, saveMessage, getMessages } = require('./backend/services/db');
  let db = 'no conectada';
  if (pool) {
    try { await pool.query('SELECT 1'); db = 'conectada'; }
    catch (e) { db = 'error: ' + e.message; }
  }
  res.json({ ok: true, mode: 'lite', db,
    whatsapp: WA_LIVE ? 'live' : 'stub',
    tts: EL_LIVE ? 'live' : 'stub',
    timestamp: new Date().toISOString(),
  });
});

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
    voice_settings: agente === 'sofia'
      ? { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: false }
      : { stability: 0.72, similarity_boost: 0.80, style: 0.2, use_speaker_boost: true, speed: 1.05 },
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
  const base = agente === 'sara'   ? SARA_PROMPT
             : agente === 'sofia'  ? SOFIA_PROMPT
             : agente === 'hector' ? HECTOR_PROMPT
             : NOA_PROMPT;
  // Tarifas solo para SOFIA — SARA y HÉCTOR no reciben precios
  const tariffBlock = agente === 'sofia'
    ? `\n\n## MERCADO ACTUAL (actualizado en tiempo real)\n${tariffCtx.prompt}`
    : '';
  return contextBlock
    ? `${base}${tariffBlock}\n\n${contextBlock}`
    : `${base}${tariffBlock}`;
}

// ─── CHAT (SSE streaming con memoria + tarifa dinámica) ───────────────────
async function handleChat(agente, req, res) {
  const { message, sessionId, callMode } = req.body;
  if (!message) return res.status(400).json({ error: 'message requerido' });

  const sid = sessionId || `web_${agente}_${Date.now()}`;
  const { contextBlock, history } = memory.buildContext(sid);
  const tariffCtx = tariff.getContext();
  let systemPrompt = buildPrompt(agente, contextBlock, tariffCtx);
  if (callMode) systemPrompt += '\n\n🎙️ MODO LLAMADA DE VOZ: El cliente está en una llamada. Responde en máximo 2 oraciones cortas y directas. Sin listas, sin markdown, sin asteriscos. Habla natural como en una conversación telefónica. IMPORTANTE: Aunque estés en modo voz, SIEMPRE debes emitir el bloque LEAD_DATA al final de tu respuesta cuando tengas datos del cliente — es obligatorio en todos los modos.';
  const messages = [...history, { role: 'user', content: message }];

  memory.addMessage(sid, 'user', message);
  saveMessage(sid, agente, 'user', message);
  pushActividad({ agente, tipo: `MENSAJE_USUARIO`, mensaje: message.slice(0, 120), sessionId: sid });

  // Garantizar que toda conversación con SARA quede registrada desde el primer mensaje
  if (agente === 'sara') {
    const historial = memory.buildContext(sid).history || [];
    const primer_mensaje = historial.find(m => m.role === 'user')?.content?.slice(0, 160) || message.slice(0, 160);
    leads.extractFromText(message, sid, { sara_nota: 'cotizacion_en_proceso', primer_mensaje });
  }

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
    saveMessage(sid, agente, 'assistant', fullText);
    const agenteNombre = agente === 'sara' ? 'SARA' : agente === 'sofia' ? 'SOFIA' : agente === 'noa' ? 'NOA' : 'HÉCTOR';
    pushActividad({ agente: agenteNombre, tipo: `MENSAJE_${agenteNombre}`, mensaje: fullText.replace(/[*_`#>]/g,'').slice(0,120), sessionId: sid });

    // Detectar señales de control
    if (/CERRAR_CHAT/i.test(fullText))
      res.write(`data: ${JSON.stringify({ type: 'cerrar_chat' })}\n\n`);
    if (/ESCALAR_HUMANO/i.test(fullText))
      res.write(`data: ${JSON.stringify({ type: 'escalar_humano' })}\n\n`);

    // Detectar lead capturado por SARA
    if (agente === 'sara') {
      const hasCierre  = /NUEVA_ORDEN/i.test(fullText);
      const hasEscalar = /ESCALAR_HUMANO/i.test(fullText);
      const hasCerrar  = /CERRAR_CHAT/i.test(fullText);
      const sara_nota  = hasCierre  ? 'cierre_de_venta'
                       : hasEscalar ? 'escalado_a_operaciones'
                       : hasCerrar  ? 'chat_cerrado'
                       : 'cotizacion_en_proceso';

      const historial = memory.buildContext(sid).history || [];
      const primer_mensaje = historial.find(m => m.role === 'user')?.content?.slice(0, 300) || message.slice(0, 300);

      // Parsear token LEAD_DATA emitido por SARA con datos confirmados
      const leadDataMatch = fullText.match(/LEAD_DATA:\s*(\{[^\n]+\})/);
      let datosSara = {};
      if (leadDataMatch) {
        try { datosSara = JSON.parse(leadDataMatch[1]); } catch {}
      }

      // Upsert del lead con datos de SARA (más confiables que regex sobre texto libre)
      const filled = f => f && f !== '—' && f !== '' && f !== null;
      const lead = leads.add({ ...datosSara, sara_nota, primer_mensaje, sessionId: sid });

      if (hasCierre) {
        res.write(`data: ${JSON.stringify({ type: 'nueva_orden', datos: lead })}\n\n`);
        pushActividad({ agente: 'SARA', tipo: 'NUEVA_ORDEN', mensaje: `Nueva orden ${lead.folio || ''} — ${lead.empresa || lead.nombre || ''}`, sessionId: sid, metadata: { sessionId: sid } });
      }

      // Primer contacto: email inmediato al primer mensaje de la sesión.
      // history.length === 0 porque se captura ANTES de agregar el mensaje actual,
      // así que 0 = primera vez que esta persona escribe en esta sesión.
      if (history.length === 0) {
        notifier.notificarLead(lead)
          .catch(e => console.error('[notifier primer-contacto]', e.message));
      }

      // Email de resumen al cierre de conversación (adicional al de primer contacto)
      if (hasCierre || hasEscalar || hasCerrar) {
        const histMsg = memory.buildContext(sid).history || [];
        notifier.notificarResumen(lead, sara_nota, histMsg)
          .catch(e => console.error('[notifier]', e.message));
        if (process.env.VAPI_FOLLOWUP === 'true' && hasCierre) {
          vapi.llamarLead(lead).catch(e => console.error('[vapi-followup]', e.message));
        }
      } else {
        const faltantes = ['nombre','email','telefono','empresa','tipo_carga','tipo_unidad']
          .filter(k => !filled(lead[k])).join(', ');
        console.log(`[lead] ${sid} — en proceso, faltan: ${faltantes}`);
      }
    }

    // Detectar si SOFIA cerró un folio
    if (agente === 'sofia' && /CONCLUIDO|entregado.*acuse|carga entregada/i.test(fullText)) {
      res.write(`data: ${JSON.stringify({ type: 'folio_update', estatus: 'ENTREGADO' })}\n\n`);
    }

    // HÉCTOR — señal de plantilla generada
    if (agente === 'hector' && /PLANTILLA_LISTA/i.test(fullText)) {
      try {
        const m = fullText.match(/PLANTILLA_LISTA:\s*(\{[^\n]+\})/);
        if (m) res.write(`data: ${JSON.stringify({ type: 'plantilla_lista', datos: JSON.parse(m[1]) })}\n\n`);
      } catch {}
    }

    // NOA — señal de alerta crítica
    if (agente === 'noa' && /ALERTA_CRITICA/i.test(fullText)) {
      try {
        const m = fullText.match(/ALERTA_CRITICA:\s*(\{[^\n]+\})/);
        if (m) res.write(`data: ${JSON.stringify({ type: 'alerta_critica', datos: JSON.parse(m[1]) })}\n\n`);
      } catch {}
    }

  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  }

  res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  res.end();
}

app.post('/api/sara/chat',   (req, res) => handleChat('sara',   req, res));
app.post('/api/sofia/chat', (req, res) => handleChat('sofia',  req, res));
app.post('/api/hector/chat',(req, res) => handleChat('hector', req, res));
app.post('/api/noa/chat',   (req, res) => handleChat('noa',    req, res));

// ─── CUENTAS POR COBRAR ────────────────────────────────────────────────────────
// Producción: conectar a ERP / AppSheets GET /api/cxc
app.get('/api/cuentas-cobrar', (req, res) => {
  res.json([
    { cl:'Liverpool S.A.B. de C.V.',   fols:['AB-2024-045','AB-2024-046'], monto:125000, dias:65, sem:'ne', ult:'Llamada sin respuesta',       fecha:'2024-01-08', resp:'Despacho Legal' },
    { cl:'Grupo Herdez SA',            fols:['AB-2024-058'],               monto:87500,  dias:38, sem:'ro', ult:'Visita pendiente — Dirección', fecha:'2024-01-12', resp:'Dirección' },
    { cl:'Soriana Operadora',          fols:['AB-2024-061','AB-2024-062'], monto:63000,  dias:22, sem:'na', ult:'Mensaje formal enviado',       fecha:'2024-01-14', resp:'Comercial' },
    { cl:'Walmart de México',          fols:['AB-2024-071'],               monto:44800,  dias:18, sem:'na', ult:'Correo de recordatorio',       fecha:'2024-01-15', resp:'Comercial' },
    { cl:'Cemex México SA',            fols:['AB-2024-075'],               monto:38200,  dias:12, sem:'am', ult:'Mensaje cortesía enviado',     fecha:'2024-01-16', resp:'Administración' },
    { cl:'Alpura SA de CV',            fols:['AB-2024-079'],               monto:29750,  dias:8,  sem:'am', ult:'Mensaje cortesía enviado',     fecha:'2024-01-17', resp:'Administración' },
    { cl:'Bimbo SA de CV',             fols:['AB-2024-082'],               monto:56000,  dias:3,  sem:'vd', ult:'Pago parcial recibido',        fecha:'2024-01-18', resp:'Administración' },
    { cl:'FEMSA Comercio',             fols:['AB-2024-085'],               monto:72400,  dias:0,  sem:'vd', ult:'Al corriente',                 fecha:'2024-01-19', resp:'Administración' },
    { cl:'HEB México SA',              fols:['AB-2024-086'],               monto:19800,  dias:1,  sem:'vd', ult:'Factura enviada',              fecha:'2024-01-19', resp:'Administración' },
  ]);
});

// ─── LEADS ────────────────────────────────────────────────────────────────────
app.get('/api/leads',            async (req, res) => res.json(await leads.list({ desde: req.query.desde, hasta: req.query.hasta })));
app.get('/api/leads/stats',      async (req, res) => res.json(await leads.stats()));
app.post('/api/leads',           (req, res) => res.json(leads.add(req.body)));
app.get('/api/leads/export.csv', async (req, res) => {
  const csv = await leads.exportCsv();
  const fecha = new Date().toISOString().slice(0,10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-sara-${fecha}.csv"`);
  res.send('﻿' + csv); // BOM para que Excel abra con tildes correctas
});
app.get('/api/leads/:id/chat',   async (req, res) => {
  const lead = await leads.getById(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead no encontrado' });
  const sid = lead.session_id || lead.sessionId || '';
  // Intentar DB primero; fallback a memoria en-proceso
  const dbMsgs = await getMessages(sid);
  const historial = dbMsgs.length
    ? { history: dbMsgs.map(r => ({ role: r.role, content: r.content })) }
    : memory.getSession(sid);
  res.json({ lead, historial });
});

// ─── GPS EN TIEMPO REAL ───────────────────────────────────────────────────────

// GET — lista todas las posiciones en vivo (para el mapa del portal)
app.get('/api/gps/live', (req, res) => {
  res.json(gpsLive.listar());
});

// ─── ACTIVIDAD STREAM ─────────────────────────────────────────────────────
app.get('/api/actividad/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  // Enviar historial reciente al conectarse
  res.write(`data: ${JSON.stringify({ type: 'historial', actividades: actividadHistorial })}\n\n`);
  actividadClients.add(res);
  req.on('close', () => actividadClients.delete(res));
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
