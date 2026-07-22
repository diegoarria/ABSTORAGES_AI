// Servidor ligero — sin PostgreSQL ni Redis
// Requiere solo ANTHROPIC_API_KEY en .env
// Features: streaming SSE, memoria persistente, WhatsApp, TTS, tarifas dinámicas
require('dotenv').config();
const express = require('express');
const path    = require('path');
const https   = require('https');
const fs      = require('fs');
const crypto  = require('crypto');

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
const leads          = require('./backend/services/leads');
const visitorMemory  = require('./backend/services/visitorMemory');
const notifier       = require('./backend/services/notifier');
const vapi        = require('./backend/services/vapi');
const tms         = require('./backend/services/tms');
const ordersStore = require('./backend/services/ordersStore');
const PROVEEDORES = require('./data/proveedores.json');
const eta         = require('./backend/services/eta');
const webpush     = require('web-push');

// ─── WEB PUSH (PWA Notifications) ────────────────────────────────────────────
const VAPID_PUB  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIV = process.env.VAPID_PRIVATE_KEY;
const VAPID_MAIL = process.env.VAPID_EMAIL || 'mailto:ops@abstorages.com';
let pushSubs = []; // subscripciones en memoria (persistir en archivo en prod)

const PUSH_SUBS_FILE = path.join(__dirname, 'data', 'push-subs.json');
try { pushSubs = JSON.parse(fs.readFileSync(PUSH_SUBS_FILE, 'utf8')); } catch (_) {}

if (VAPID_PUB && VAPID_PRIV) {
  webpush.setVapidDetails(VAPID_MAIL, VAPID_PUB, VAPID_PRIV);
}

function savePushSubs() {
  fs.writeFileSync(PUSH_SUBS_FILE, JSON.stringify(pushSubs));
}

async function sendPush(payload) {
  if (!VAPID_PUB || !VAPID_PRIV || pushSubs.length === 0) return;
  const dead = [];
  await Promise.allSettled(pushSubs.map(async (sub, i) => {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(i);
    }
  }));
  if (dead.length) {
    pushSubs = pushSubs.filter((_, i) => !dead.includes(i));
    savePushSubs();
  }
}

const app  = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', true); // Railway corre detrás de un proxy; necesario para obtener la IP real del visitante

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

// PINs por usuario — definidos en users.json, campo "pin", nunca expuestos al cliente
// pendingId → { user, expires }  (TTL 5 min; limpieza periódica)
const pendingLogins = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingLogins) {
    if (entry.expires < now) pendingLogins.delete(id);
  }
}, 60_000);

app.get('/login', (req, res) => {
  // Siempre limpia la sesión activa al entrar al login
  const match = (req.headers.cookie || '').match(/abs_session=([^;]+)/);
  if (match) sessions.destroy(match[1]);
  res.setHeader('Set-Cookie', 'abs_session=; Path=/; Max-Age=0');
  res.sendFile(path.join(__dirname, 'frontend', 'login.html'));
});

// Destino por rol tras login
function homeForRole(role) {
  if (role === 'operaciones') return '/ops-center.html';
  if (role === 'cliente')     return '/tracker.html';
  return '/'; // admin y otros
}

// Paso 1: verifica credenciales → emite pendingId para paso PIN
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = USERS.find(u => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });
  const { password: _, pin: userPin, ...safe } = user;
  const pendingId = crypto.randomUUID();
  pendingLogins.set(pendingId, { user: safe, pin: userPin, expires: Date.now() + 5 * 60 * 1000 });
  res.json({ step: 'pin', pendingId });
});

// Paso 2: verifica PIN → crea sesión
app.post('/api/login/pin', (req, res) => {
  const { pendingId, pin } = req.body || {};
  const entry = pendingLogins.get(pendingId);
  if (!entry || entry.expires < Date.now()) {
    pendingLogins.delete(pendingId);
    return res.status(401).json({ error: 'Sesión expirada. Ingresa tus credenciales de nuevo.' });
  }
  if (String(pin) !== String(entry.pin)) {
    pendingLogins.delete(pendingId); // un solo intento
    return res.status(401).json({ error: 'Código incorrecto. Acceso denegado.' });
  }
  pendingLogins.delete(pendingId);
  const { user: safe } = entry;
  const sid = sessions.create(safe);
  res.setHeader('Set-Cookie', `abs_session=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
  res.json({ ok: true, user: safe, redirect: homeForRole(safe.role) });
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

// STT público para el widget — ElevenLabs Scribe, sin auth
app.post('/api/widget/stt', async (req, res) => {
  if (!EL_LIVE) return res.json({ text: '' });

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const audioBuf = Buffer.concat(chunks);
    if (audioBuf.length < 1000) return res.json({ text: '' });

    const contentType = req.headers['content-type'] || 'audio/webm';
    const boundary = 'ELSTT' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: ${contentType}\r\n\r\n`),
      audioBuf,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model_id"\r\n\r\nscribe_v1\r\n--${boundary}--\r\n`),
    ]);

    try {
      const apiRes = await new Promise((resolve, reject) => {
        const r = https.request({
          hostname: 'api.elevenlabs.io',
          path: '/v1/speech-to-text',
          method: 'POST',
          headers: {
            'xi-api-key': EL_KEY,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        }, resolve);
        r.on('error', reject);
        r.write(body);
        r.end();
      });

      let raw = '';
      apiRes.on('data', d => { raw += d; });
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          res.json({ text: parsed.text || '' });
        } catch { res.json({ text: '' }); }
      });
    } catch { res.json({ text: '' }); }
  });
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


// ─── PWA: clave pública VAPID (pública, sin auth) ────────────────────────────
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUB || null });
});

// ─── Vapi webhook (sin auth — Vapi llama externamente) ───────────────────────
app.post('/api/vapi/webhook', express.json(), (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const evento = req.body;
      const tipo = evento.message?.type || evento.type;
      if (tipo !== 'end-of-call-report' && tipo !== 'call-ended') return;

      const resultado = vapi.procesarResultadoLlamada({ call: evento.message?.call || evento.call || evento });
      if (!resultado) return;

      console.log(`[Vapi Webhook] ${resultado.folio} | ${resultado.proveedorId} | disponible:${resultado.disponible} | precio:${resultado.precio}`);
      pushActividad({
        agente: 'SOFIA', tipo: 'VAPI_RESULTADO',
        mensaje: `${resultado.proveedorId} → ${resultado.disponible ? `✅ DISPONIBLE ${resultado.precio || ''}` : '❌ No disponible'}`,
        metadata: { folio: resultado.folio, ...resultado },
      });

      const estado = vapi.obtenerEstadoLlamadas(resultado.folio);
      if (estado?.ganador?.proveedorId === resultado.proveedorId) {
        pushActividad({
          agente: 'SOFIA', tipo: 'PROVEEDOR_GANADOR',
          mensaje: `🏆 Folio ${resultado.folio} → ${resultado.proveedorId} a ${resultado.precio || '—'}`,
          metadata: { folio: resultado.folio, ganador: estado.ganador },
        });
        sendPush({
          title: '✅ Carrier asignado — SOFÍA',
          body: `Folio ${resultado.folio} · ${resultado.proveedorId} · ${resultado.precio || 'precio por confirmar'}`,
          tag: 'carrier-ganador',
          url: '/ops-center.html#sof',
          tipo: 'PROVEEDOR_GANADOR',
          urgente: true,
        }).catch(() => {});
        notifier.notificarAsignacion && notifier.notificarAsignacion(resultado.folio, resultado.proveedorId, resultado.precio)
          .catch(e => console.error('[notifier asignacion]', e.message));
      }
    } catch (e) {
      console.error('[Vapi Webhook]', e.message);
    }
  });
});
// ─────────────────────────────────────────────────────────────────────────────

app.use(auth);
app.use(express.static(path.join(__dirname, 'frontend')));

app.get('/api/me', (req, res) => {
  const { password: _, pin: __, _ts, ...safe } = req.user;
  res.json(safe);
});

// ─── PWA: suscripción push ────────────────────────────────────────────────────
app.post('/api/push/subscribe', express.json(), (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'Suscripción inválida' });
  const exists = pushSubs.some(s => s.endpoint === sub.endpoint);
  if (!exists) { pushSubs.push(sub); savePushSubs(); }
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', express.json(), (req, res) => {
  const { endpoint } = req.body || {};
  pushSubs = pushSubs.filter(s => s.endpoint !== endpoint);
  savePushSubs();
  res.json({ ok: true });
});

// Tokens nativos APNs/FCM desde Capacitor (guardados aparte, para FCM/APNs en el futuro)
const NATIVE_TOKENS_FILE = path.join(__dirname, 'data', 'native-tokens.json');
let nativeTokens = [];
try { nativeTokens = JSON.parse(fs.readFileSync(NATIVE_TOKENS_FILE, 'utf8')); } catch (_) {}

app.post('/api/push/subscribe-native', express.json(), (req, res) => {
  const { token, platform } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token requerido' });
  const exists = nativeTokens.some(t => t.token === token);
  if (!exists) {
    nativeTokens.push({ token, platform, ts: new Date().toISOString() });
    fs.writeFileSync(NATIVE_TOKENS_FILE, JSON.stringify(nativeTokens));
  }
  console.log(`[NativePush] Token ${platform} registrado`);
  res.json({ ok: true });
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

app.get('/api/sofia/folios', (req, res) => {
  res.json(ordersStore.listarOrdenes().map(o => o.folio));
});

// Estado de llamadas Vapi por folio
app.get('/api/vapi/estado/:folio', (req, res) => {
  const estado = vapi.obtenerEstadoLlamadas(req.params.folio.toUpperCase());
  if (!estado) return res.status(404).json({ error: 'Sin llamadas registradas para este folio' });
  res.json(estado);
});

// ─── SOFIA: proveedores desde TMS ────────────────────────────────────────────
app.get('/api/sofia/proveedores', adminUOps, async (req, res) => {
  const local = () => require('./data/proveedores.json').map(p => ({
    'Razon Social': p.nombre,
    'Telefono': p.telefono,
    'Estatus': p.clasificacion,
    'RFC': '—',
    'Correo': '—',
    'Contacto': '—',
    'Movil': '—',
    'Emergencia': '—',
    '_local': true,
  }));

  try {
    if (!tms.ENABLED) return res.json(local());

    const q = (req.query.q || '').trim();
    const datos = q ? await tms.buscarProveedor(q) : await tms.listarProveedores(60);
    res.json((datos && datos.length) ? datos : local());
  } catch (e) {
    console.error('[sofia/proveedores]', e.message);
    res.json(local());
  }
});

app.get('/api/sofia/proveedores/:nombre/rutas', adminUOps, async (req, res) => {
  try {
    if (!tms.ENABLED) return res.json([]);
    const rutas = await tms.rutasProveedor(decodeURIComponent(req.params.nombre));
    res.json(rutas || []);
  } catch (e) {
    console.error('[sofia/proveedores/rutas]', e.message);
    res.json([]);
  }
});

// ─── NOA: folios activos desde TMS ───────────────────────────────────────────
let _foliosCache = null; // { data: [], ts: Date }

function mapFolio(s) {
  const det = (s['EstatusMonitoreoDetalle'] || '').toLowerCase();
  let st = 'EN_TRANSITO';
  if (det.includes('origen') || det.includes('carga'))              st = 'EN_CARGA';
  else if (det.includes('destino') || det.includes('descarga'))     st = 'EN_DESTINO';
  else if (det.includes('detenida') || det.includes('resguardo'))   st = 'DETENIDA';

  const comentario = (s['Comentarios Estatus Monitoreo'] || '').trim();
  const citaDes = s['Cita de Descarga']
    ? new Date(s['Cita de Descarga']).toLocaleString('es-MX', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false })
    : null;

  const folio = s['Folio de servicio'] || '—';
  const esc_saved = escalaciones[folio];
  return {
    id:    folio,
    placa: s['Tractor']           || '—',
    cl:    s['Cliente']           || '—',
    or:    [s['Cuidad Origen'],  s['Estado Origen'] ].filter(Boolean).join(', '),
    de:    [s['Cuidad destino'], s['Estado destino']].filter(Boolean).join(', '),
    st,
    gps:   { la: null, ln: null, url: s['GPS'] || null, usr: s['Usuario GPS'] || null },
    min:   0,
    op:    s['Operador']  || '—',
    pv:    s['Proveedor'] || '—',
    al:    esc_saved ? esc_saved.al : 'NORMAL',
    inc:   esc_saved ? esc_saved.inc : (comentario || null),
    zona:  false,
    esc:   esc_saved ? esc_saved.esc : [],
    citaDes,
    citaDesRaw: s['Cita de Descarga'] || null,
    planner: s['Planner'] || null,
  };
}

app.get('/api/noa/folios', async (req, res) => {
  if (!tms.ENABLED) return res.json([]);
  try {
    const activos = await tms.foliosActivosNOA();
    // Only replace cache if TMS returned real data
    if (activos && activos.length > 0) {
      const folios = activos.map(mapFolio);
      _foliosCache = { data: folios, ts: new Date().toISOString() };
      return res.json(folios);
    }
    // TMS returned empty — serve cache if available
    if (_foliosCache) {
      console.warn('[NOA/folios] TMS returned 0 results — serving cache from', _foliosCache.ts);
      return res.json(_foliosCache.data);
    }
    res.json([]);
  } catch (e) {
    console.error('[NOA/folios]', e.message);
    // TMS error — serve cache if available
    if (_foliosCache) {
      console.warn('[NOA/folios] TMS error — serving cache from', _foliosCache.ts);
      return res.json(_foliosCache.data);
    }
    res.status(503).json([]);
  }
});

// ─── ESCALACIONES PERSISTENTES ───────────────────────────────────────────────
const ESCALACIONES_PATH = path.join(__dirname, 'data', 'escalaciones.json');
let escalaciones = {};
try { escalaciones = JSON.parse(fs.readFileSync(ESCALACIONES_PATH, 'utf8')); } catch(e) { escalaciones = {}; }
function saveEscalaciones() {
  try { fs.writeFileSync(ESCALACIONES_PATH, JSON.stringify(escalaciones, null, 2)); } catch(e) {}
}

app.get('/api/noa/escalaciones', (req, res) => res.json(escalaciones));

app.post('/api/noa/escalaciones', express.json(), (req, res) => {
  const { folio, al, inc, esc } = req.body || {};
  if (!folio) return res.status(400).json({ error: 'folio required' });
  if (al === 'NORMAL') {
    delete escalaciones[folio];
  } else {
    escalaciones[folio] = { al, inc: inc || null, esc: esc || [], ts: new Date().toISOString() };
  }
  saveEscalaciones();
  res.json({ ok: true });
});

app.get('/api/noa/folio/:folio', async (req, res) => {
  if (!tms.ENABLED) return res.json(null);
  try {
    const datos = await tms.buscarFolioNOA(req.params.folio.toUpperCase());
    const d = datos[0] || null;
    if (!d) return res.json(null);

    // Calcular ETA (Google Maps si hay API key, si no cae a cita_descarga)
    try {
      const etaResult = await eta.calcularETA({
        ciudad_origen:   d['Cuidad Origen'],
        estado_origen:   d['Estado Origen'],
        ciudad_destino:  d['Cuidad destino'],
        estado_destino:  d['Estado destino'],
        hora_salida_carga: d['Hora de salida carga'] || null,
        cita_descarga:   d['Cita de Descarga'] || null,
        estatus:         d['EstatusMonitoreoDetalle'] || '',
      });
      d._eta = etaResult;
    } catch (e) {
      console.warn('[NOA/folio/eta]', e.message);
    }

    res.json(d);
  } catch (e) {
    console.error('[NOA/folio]', e.message);
    res.json(null);
  }
});

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
      ? { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: false, speed: 1.1 }
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
  const { message, sessionId, callMode, visitorId } = req.body;
  if (!message) return res.status(400).json({ error: 'message requerido' });

  const sid = sessionId || `web_${agente}_${Date.now()}`;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;
  const { contextBlock, history } = memory.buildContext(sid);
  const tariffCtx = tariff.getContext();
  let systemPrompt = buildPrompt(agente, contextBlock, tariffCtx);

  // Inyectar memoria del visitante en SARA para reconocer clientes que regresan
  if (agente === 'sara' && visitorId) {
    const visitorCtx = visitorMemory.buildContext(visitorId);
    if (visitorCtx) systemPrompt += `\n\n${visitorCtx}`;
  }

  if (callMode) systemPrompt += '\n\n🎙️ MODO LLAMADA DE VOZ: El cliente está en una llamada. Responde en máximo 2 oraciones cortas y directas. Sin listas, sin markdown, sin asteriscos. Habla natural como en una conversación telefónica. IMPORTANTE: Aunque estés en modo voz, SIEMPRE debes emitir el bloque LEAD_DATA al final de tu respuesta cuando tengas datos del cliente — es obligatorio en todos los modos.';

  // Inyectar contexto TMS para SOFIA (proveedores, rutas, costos)
  if (agente === 'sofia' && tms.ENABLED) {
    const tmsCtx = await tms.getContextoSOFIA(message);
    if (tmsCtx) systemPrompt += tmsCtx;
  }

  // Inyectar contexto TMS para NOA (folios activos, detalle operativo, instrucciones cliente)
  if (agente === 'noa' && tms.ENABLED) {
    const tmsCtx = await tms.getContextoNOA(message);
    if (tmsCtx) systemPrompt += tmsCtx;
  }

  const messages = [...history, { role: 'user', content: message }];

  memory.addMessage(sid, 'user', message);
  saveMessage(sid, agente, 'user', message);
  pushActividad({ agente, tipo: `MENSAJE_USUARIO`, mensaje: message.slice(0, 120), sessionId: sid, ip });

  // Garantizar que toda conversación con SARA quede registrada desde el primer mensaje
  if (agente === 'sara') {
    const historial = memory.buildContext(sid).history || [];
    const primer_mensaje = historial.find(m => m.role === 'user')?.content?.slice(0, 160) || message.slice(0, 160);
    const extracted = leads.extractFromText(message, sid, { sara_nota: 'cotizacion_en_proceso', primer_mensaje });
    // Actualizar perfil del visitante con cualquier dato que el usuario mencione
    if (visitorId && extracted) {
      visitorMemory.update(visitorId, { ...extracted, sessionId: sid });
    }
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

        // Push notification al equipo
        sendPush({
          title: '🚛 Nueva orden — SARA',
          body: `${lead.empresa || lead.nombre || 'Cliente'} · ${lead.origen || ''}→${lead.destino || ''} · Folio ${lead.folio || ''}`,
          tag: 'nueva-orden',
          url: '/',
          tipo: 'NUEVA_ORDEN',
          urgente: true,
        }).catch(() => {});

        // Persistir orden para que SOFIA la consulte sin re-preguntar
        ordersStore.guardarOrden(lead);

        // Lanzar llamadas a carriers en paralelo (stub si VAPI_API_KEY no está)
        vapi.lanzarLlamadasProveedores(lead, PROVEEDORES)
          .then(r => {
            const msg = r.llamadas > 0
              ? `Folio ${lead.folio} — ${r.llamadas} llamadas a carriers iniciadas`
              : `Folio ${lead.folio} — sin carriers compatibles para esta ruta`;
            pushActividad({ agente: 'SOFIA', tipo: 'VAPI_INICIADO', mensaje: msg, metadata: { folio: lead.folio, ...r } });
            console.log(`[Vapi] ${msg}`);
          })
          .catch(e => console.error('[Vapi] Error lanzando llamadas:', e.message));
      }

      // Actualizar perfil del visitante con datos capturados en esta sesión
      if (visitorId) {
        visitorMemory.update(visitorId, { ...datosSara, sessionId: sid, resumen: lead.resumen || '' });
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

// ─── LEADS (solo admin) ───────────────────────────────────────────────────────
function soloAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Acceso restringido' });
}
function adminUOps(req, res, next) {
  if (req.user?.role === 'admin' || req.user?.role === 'operaciones') return next();
  res.status(403).json({ error: 'Acceso restringido' });
}
app.get('/api/metricas', soloAdmin, async (req, res) => {
  const all = await leads.list({ limit: 5000 });
  const now = Date.now();
  const DAY = 86_400_000;

  // ── Embudo comercial ──────────────────────────────────────────────────────
  const calificados = all.filter(l => l.intent === 'fletes_nacionales');
  const cerrados    = calificados.filter(l =>
    l.sara_nota === 'cierre_de_venta' || (l.folio && l.folio !== '—'));
  const tasa_conversion = calificados.length
    ? Math.round(cerrados.length / calificados.length * 100) : 0;

  // ── Tendencia 7 días ──────────────────────────────────────────────────────
  const tendencia = Array.from({ length: 7 }, (_, i) => {
    const dia = new Date(now - (6 - i) * DAY);
    const label = dia.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric' });
    const count = all.filter(l => {
      const d = new Date(l.created_at);
      return d.getDate()     === dia.getDate()  &&
             d.getMonth()    === dia.getMonth() &&
             d.getFullYear() === dia.getFullYear();
    }).length;
    return { label, count };
  });

  // ── Retención (empresas/emails con >1 servicio cerrado) ───────────────────
  const porCliente = {};
  cerrados.forEach(l => {
    const key = (l.email && l.email !== '—') ? l.email
              : (l.empresa && l.empresa !== '—') ? l.empresa
              : (l.nombre && l.nombre !== '—') ? l.nombre : null;
    if (key) porCliente[key] = (porCliente[key] || 0) + 1;
  });
  const clientes_unicos     = Object.keys(porCliente).length;
  const clientes_recurrentes = Object.values(porCliente).filter(v => v > 1).length;
  const tasa_retencion = clientes_unicos
    ? Math.round(clientes_recurrentes / clientes_unicos * 100) : 0;

  // ── Breakdown por intent ──────────────────────────────────────────────────
  const intents = {};
  all.forEach(l => {
    const k = l.intent || 'otro';
    intents[k] = (intents[k] || 0) + 1;
  });

  // ── Folios activos (caché NOA) ────────────────────────────────────────────
  const folios = _foliosCache?.data || [];
  const folios_status = {
    total:    folios.length,
    criticos: folios.filter(f => f.nivel === 'CRITICO').length,
    atencion: folios.filter(f => f.nivel === 'ATENCION').length,
    normales: folios.filter(f => f.nivel === 'NORMAL' || f.nivel === 'DETENIDA').length,
  };

  res.json({
    embudo: { total: all.length, calificados: calificados.length, cerrados: cerrados.length, tasa_conversion },
    tendencia,
    retencion: { clientes_unicos, clientes_recurrentes, tasa_retencion },
    intents,
    folios_status,
    generated_at: new Date().toISOString(),
  });
});

app.get('/api/leads',            soloAdmin, async (req, res) => res.json(await leads.list({ desde: req.query.desde, hasta: req.query.hasta })));
app.get('/api/leads/stats',      soloAdmin, async (req, res) => res.json(await leads.stats()));
app.post('/api/leads',           soloAdmin, (req, res) => res.json(leads.add(req.body)));

// ─── PROSPECTOR — SARA outbound ───────────────────────────────────────────────
const prospector   = require('./backend/services/prospector');
const outreach     = require('./backend/services/outreach');
const outreachRunner = require('./backend/services/outreachRunner');

// Buscar prospectos en Apollo + Lusha
app.post('/api/prospector/buscar', soloAdmin, async (req, res) => {
  try {
    const filtros = req.body || {};
    const resultados = await prospector.buscar(filtros);
    res.json({ ok: true, total: resultados.length, prospectos: resultados });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Agregar prospectos a la secuencia de outreach
app.post('/api/prospector/iniciar', soloAdmin, (req, res) => {
  const { prospectos } = req.body || {};
  if (!Array.isArray(prospectos)) return res.status(400).json({ error: 'Array de prospectos requerido' });
  const nuevos = outreach.agregarProspectos(prospectos);
  pushActividad({ agente: 'SARA', tipo: 'PROSPECTOR', mensaje: `${nuevos.length} prospectos añadidos a secuencia`, metadata: { total: nuevos.length } });
  res.json({ ok: true, nuevos: nuevos.length });
});

// Listar prospectos
app.get('/api/prospector', soloAdmin, (req, res) => {
  res.json(outreach.listar({ estado: req.query.estado }));
});

// Stats del pipeline
app.get('/api/prospector/stats', soloAdmin, (req, res) => {
  res.json(outreach.stats());
});

// Marcar cita agendada manualmente
app.post('/api/prospector/:id/cita', soloAdmin, (req, res) => {
  const p = outreach.marcarCita(req.params.id);
  if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });
  pushActividad({ agente: 'SARA', tipo: 'CITA_AGENDADA', mensaje: `Cita agendada con ${p.nombre} (${p.empresa})`, metadata: { id: p.id } });
  res.json({ ok: true, prospecto: p });
});

// Ejecutar runner manualmente (normalmente corre en intervalo)
app.post('/api/prospector/run', soloAdmin, async (req, res) => {
  try {
    const r = await outreachRunner.run(pushActividad);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Créditos Apollo
app.get('/api/prospector/creditos', soloAdmin, async (req, res) => {
  const c = await prospector.creditosApollo();
  res.json(c || { error: 'No disponible' });
});

// Runner automático cada 15 minutos
setInterval(() => {
  outreachRunner.run(pushActividad).catch(e => console.error('[OutreachRunner]', e.message));
}, 15 * 60 * 1000);
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
