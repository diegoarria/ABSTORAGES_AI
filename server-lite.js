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
const { chatStream, chat } = require('./backend/services/claude');
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
const sessionIp      = require('./backend/services/sessionIp');
const promptLeakGuard = require('./backend/services/promptLeakGuard');
const visitorMemory  = require('./backend/services/visitorMemory');
const notifier       = require('./backend/services/notifier');
const callLog        = require('./backend/services/callLog');
const moderacion     = require('./backend/services/moderacion');
const vapi        = require('./backend/services/vapi');
const noaScheduler = require('./backend/services/noaScheduler');
const db          = require('./backend/db/db');
const tms         = require('./backend/services/tms');
const { limpiarFormatoWhatsApp } = require('./backend/services/formatoWA');
const gpsProviders = require('./backend/services/gpsProviders');
const ordersStore = require('./backend/services/ordersStore');
const contactos   = require('./backend/services/contactos');
const alertasStaff = require('./backend/services/alertasStaff');
const saraProactivo = require('./backend/services/saraProactivo');
const twochat = require('./backend/services/twochat');
const vision  = require('./backend/services/vision');
const whatsappProactivo = require('./backend/services/whatsappProactivo');
const grupoWA = require('./backend/services/groupMessages');
const staffDirectory = require('./backend/services/staffDirectory');
const incidentesNOA = require('./backend/services/incidentesNOA');
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
const callsEnVivoNotificadas = new Set(); // callId ya avisado como "en llamada"

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

// ─── WHATSAPP (Twilio) ───────────────────────────────────────────────────────
const TWILIO_SID      = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
// TWILIO_WHATSAPP_NUMBER es el número real de SARA (+1 806 375 4780, confirmado
// en vivo) — es el número original de antes de separar por agente, NUNCA de
// NOA. NOA no tiene número de WhatsApp de Twilio propio (solo llamadas) — el
// código antes lo mapeaba a "noa" por default histórico y eso hacía que
// cualquier mensaje real al número de SARA lo contestara la persona de NOA.
const TWILIO_WA_FROM  = (process.env.TWILIO_WHATSAPP_NUMBER || '').replace(/^whatsapp:/, ''); // número real de SARA
const WA_LIVE = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_WA_FROM);

// Un número de WhatsApp por agente — cada uno contesta con su propia identidad,
// igual que sus números de llamada en Vapi (nunca mezclar personas). NOA no
// aparece aquí — no tiene número de WhatsApp de Twilio.
const WA_NUMBERS = {
  sara:  (process.env.TWILIO_WHATSAPP_NUMBER_SARA  || '').replace(/^whatsapp:/, '') || TWILIO_WA_FROM,
  sofia: (process.env.TWILIO_WHATSAPP_NUMBER_SOFIA || '').replace(/^whatsapp:/, ''),
};

// A qué agente le corresponde contestar según el número al que le escribieron (req.body.To).
function agenteParaNumeroWA(numero) {
  const limpio = (numero || '').replace(/^whatsapp:/, '');
  for (const [agente, num] of Object.entries(WA_NUMBERS)) {
    if (num && num === limpio) return agente;
  }
  return 'sara'; // fallback histórico — TWILIO_WHATSAPP_NUMBER es el número original de SARA antes de separar por agente
}

async function sendWhatsApp(to, text, agente = 'noa') {
  // ── BLOQUEO ABSOLUTO — ningún token de control sale nunca por WhatsApp ──
  // Se aplica AQUÍ, dentro de la función que de verdad manda el mensaje, sin
  // importar qué código haya llamado a sendWhatsApp ni si ya se "limpió" antes.
  const antes = text;
  text = text
    .replace(/LEAD_DATA\s*:[\s\S]*$/gi, '')
    .replace(/NUEVA_ORDEN\s*:[\s\S]*$/gi, '')
    .replace(/UPSERT_CONTACTO\s*:[\s\S]*$/gi, '')
    .replace(/ALERTA_CRITICA\s*:[\s\S]*$/gi, '')
    .replace(/ESTATUS_SEGUIMIENTO\s*:[\s\S]*$/gi, '')
    .replace(/CERRAR_CHAT/gi, '')
    .replace(/ESCALAR_HUMANO/gi, '')
    .trim();
  if (text !== antes.trim()) {
    console.warn(`[WA] ⚠️ Se bloqueó un token de control que iba a salir hacia ${to}`);
  }
  text = limpiarFormatoWhatsApp(text);
  if (!text) { console.log(`[WA] Mensaje vacío tras filtrar control, no se envía a ${to}`); return; }

  if (!WA_LIVE) {
    console.log(`[WA-STUB] → ${to}: ${text.slice(0, 80)}`);
    return;
  }
  // NOA no tiene número de WhatsApp de Twilio propio — sin esta guarda, un
  // mensaje mandado con agente="noa" caía en el fallback `|| TWILIO_WA_FROM`
  // y salía en realidad desde el número de SARA, impersonándola sin que se
  // notara en el log ni en el WhatsApp del destinatario.
  if (agente === 'noa') {
    console.error(`[WA] ⚠️ Se intentó mandar un WhatsApp real como NOA hacia ${to} — NOA no tiene número de Twilio, no se envía.`);
    return;
  }
  console.log(`[WA] Enviando a ${to}: ${text.slice(0, 60)}...`);
  try {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const from = WA_NUMBERS[agente] || TWILIO_WA_FROM;
    const body = new URLSearchParams({
      From: `whatsapp:${from}`,
      To:   `whatsapp:${to.replace(/^whatsapp:/, '')}`,
      Body: text,
    });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${auth}`,
      },
      body,
    });
    const resp = await r.text();
    if (!r.ok) console.error(`[WA] Error ${r.status}: ${resp.slice(0, 300)}`);
    else        console.log(`[WA] OK → ${to}`);
  } catch (e) {
    console.error('[WA] Error enviando:', e.message);
  }
}

// Busca unidad real para un folio recién cerrado — llamadas Vapi +
// disponibilidad por WhatsApp a proveedores REALES del TMS (antes usaba
// data/proveedores.json, un archivo de prueba con nombres y teléfonos
// inventados que nunca se sincronizó con el TMS — encontrado en auditoría
// del 01-sep-2026). Si de verdad no hay ningún proveedor compatible, avisa
// al equipo en vez de quedarse callado — antes esto solo quedaba en un log.
async function buscarUnidadParaOrden(lead) {
  try {
    const proveedoresReales = await tms.proveedoresParaVapi();
    const compatibles = vapi.filtrarProveedores(proveedoresReales, lead);
    if (!compatibles.length) {
      console.warn(`[SOFIA] Sin proveedores reales compatibles para folio ${lead.folio}`);
      pushActividad({
        agente: 'SOFIA', tipo: 'SIN_UNIDAD',
        mensaje: `Folio ${lead.folio || ''} — no se encontró ningún proveedor real compatible, nadie fue contactado`,
        metadata: { folio: lead.folio },
      });
      sendPush({
        title: '⚠️ Sin unidad disponible — SOFIA',
        body: `Folio ${lead.folio || ''} (${lead.empresa || lead.nombre || 'cliente'}) — ningún proveedor real compatible, revisar manualmente`,
        tag: 'sin-unidad', url: '/', tipo: 'SIN_UNIDAD', urgente: true,
      }).catch(() => {});
      return;
    }
    vapi.lanzarLlamadasProveedores(lead, proveedoresReales)
      .then(r => pushActividad({ agente: 'SOFIA', tipo: 'VAPI_INICIADO', mensaje: `Folio ${lead.folio || ''} — ${r.llamadas} llamadas a carriers iniciadas`, metadata: { folio: lead.folio, ...r } }))
      .catch(e => console.error('[Vapi] Error lanzando llamadas:', e.message));
    whatsappProactivo.preguntarDisponibilidadATodos(compatibles, lead)
      .catch(e => console.error('[whatsappProactivo] Error preguntando disponibilidad:', e.message));
  } catch (e) {
    console.error('[SOFIA] Error buscando unidad real para folio', lead.folio, ':', e.message);
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

// WhatsApp webhook — sin auth (viene de Twilio)
app.post('/webhook/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  // TwiML vacío — un body como "OK" (res.sendStatus por default) se reenvía
  // como mensaje real al usuario si no es XML válido.
  res.set('Content-Type', 'text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  console.log('[WA-IN] body:', JSON.stringify(req.body).slice(0, 600));
  try {
    // Twilio manda form-urlencoded: From="whatsapp:+52...", To="whatsapp:+52...", Body="texto", NumMedia="0"
    const numMedia = Number(req.body?.NumMedia || 0);
    // Antes se ignoraba cualquier mensaje sin texto (línea que exigía Body) —
    // eso descartaba por completo evidencias reales (foto de caja seca, carta
    // porte) mandadas sin caption, que es como la mayoría de choferes las
    // mandan. Ahora solo se requiere From, y al menos texto o algún adjunto.
    if (!req.body?.From || (!req.body?.Body?.trim() && numMedia === 0)) { console.log('[WA-IN] sin From ni contenido, ignorando'); return; }
    const phone  = req.body.From.replace(/^whatsapp:/, '');
    const texto  = (req.body.Body || '').trim();
    const mediaUrls = [];
    for (let i = 0; i < numMedia; i++) {
      const url = req.body[`MediaUrl${i}`];
      if (url) mediaUrls.push(url);
    }
    // El agente que contesta depende del número al que le escribieron — cada
    // agente tiene su propio número de WhatsApp, igual que su número de Vapi.
    const agente  = agenteParaNumeroWA(req.body.To);
    const agenteU = agente.toUpperCase();

    // Mantenimiento forzado por orden de Diego — mismo corte que en el chat web,
    // aplicado también a WhatsApp. Se ignora el mensaje en silencio, sin
    // responder nada (ni siquiera un aviso de mantenimiento) mientras dure.
    if (['sara', 'sofia', 'noa'].includes(agente) && Date.now() < new Date('2026-09-03T15:30:00Z').getTime()) {
      console.log(`[WA-IN] ${agenteU} en mantenimiento forzado, ignorando mensaje de ${phone}`);
      return;
    }
    // NOA conserva su clave de sesión histórica (wa_${phone}) para no romper
    // continuidad de conversaciones ya guardadas; SARA/SOFIA son números nuevos.
    const session = agente === 'noa' ? `wa_${phone}` : `wa_${agente}_${phone}`;
    const { contextBlock, history } = memory.buildContext(session);
    const esPrimerMensaje = history.length === 0; // capturado antes de agregar el mensaje actual
    const tariffCtx = tariff.getContext();
    let systemPrompt = buildPrompt(agente, contextBlock, tariffCtx) + '\n\n' + FORMATO_WHATSAPP;
    // Reconocimiento del equipo interno por número — nunca tratarlos como
    // cliente/proveedor/prospecto, sin importar el canal.
    const personaEquipo = staffDirectory.buscarPorTelefono(phone);
    if (personaEquipo) {
      systemPrompt += staffDirectory.bloqueEquipoInterno(personaEquipo);
    } else {
      // No es equipo interno — ¿ya es un contacto conocido (proveedor/cliente
      // con quien ya se cerró algo antes)? Si sí, se le da continuidad real.
      const contactoConocido = await contactos.buscarPorTelefono(phone, agente);
      if (contactoConocido) systemPrompt += contactos.bloqueContactoConocido(contactoConocido);
    }

    // Fuga de proceso/metodología/reglas internas — corte determinístico,
    // igual que en el chat web. Por orden de Diego: nadie más que él (verificado
    // por su número real en el directorio) puede pedir esto, en ningún canal.
    if (['sara', 'sofia', 'noa'].includes(agente) && promptLeakGuard.detectar(texto) && personaEquipo?.nombre !== 'Diego') {
      memory.addMessage(session, 'user', texto);
      memory.addMessage(session, 'assistant', promptLeakGuard.MENSAJE_BLOQUEO);
      saveMessage(session, agente, 'user', texto);
      saveMessage(session, agente, 'assistant', promptLeakGuard.MENSAJE_BLOQUEO);
      pushActividad({ agente: agenteU, tipo: 'ALERTA_FUGA_PROMPT', mensaje: texto.slice(0, 200), sessionId: session });
      await sendWhatsApp(phone, promptLeakGuard.MENSAJE_BLOQUEO, agente);
      return;
    }

    if (agente === 'sofia' && tms.ENABLED) {
      const tmsCtx = await tms.getContextoSOFIA(texto);
      if (tmsCtx) systemPrompt += tmsCtx;
    }
    if (agente === 'noa' && tms.ENABLED) {
      const tmsCtx = await tms.getContextoNOA(texto);
      if (tmsCtx) systemPrompt += tmsCtx;
    }
    if (agente === 'sara' && tms.ENABLED) {
      const tmsCtx = await tms.getContextoSARA(texto);
      if (tmsCtx) systemPrompt += tmsCtx;
    }
    // Si trae imagen(es)/PDF, se descargan (Twilio exige auth básica para
    // sus media URLs) y se arma un mensaje multimodal para Claude — el
    // historial guardado solo lleva un texto liviano describiendo que hubo
    // un adjunto, nunca la imagen completa (evita inflar la memoria/contexto
    // en cada turno futuro con datos que ya no hacen falta).
    let contenidoParaClaude = texto;
    let textoParaHistorial = texto;
    if (mediaUrls.length) {
      const { content, adjuntos } = await vision.construirContenidoConArchivos(mediaUrls, texto, {
        basicAuth: `${TWILIO_SID}:${TWILIO_TOKEN}`,
      });
      if (adjuntos > 0) {
        contenidoParaClaude = content;
        textoParaHistorial = `${texto ? texto + ' ' : ''}[${adjuntos} archivo(s) adjunto(s) enviado(s)]`.trim();
      }
    }
    memory.addMessage(session, 'user', textoParaHistorial);
    saveMessage(session, agente, 'user', textoParaHistorial);
    let respuesta = '';
    await chatStream(systemPrompt, [...history, { role: 'user', content: contenidoParaClaude }], (c) => { respuesta += c; }, () => {});
    memory.addMessage(session, 'assistant', respuesta);
    saveMessage(session, agente, 'assistant', respuesta);
    const bloques = splitForWhatsApp(limpiarControlParaCliente(respuesta));
    for (const bloque of bloques) await sendWhatsApp(phone, bloque, agente);
    const metaMatch = respuesta.match(/empresa[:\s]+([^\n,.]+)/i);
    if (metaMatch) memory.updateMeta(session, { empresa: metaMatch[1].trim() });

    if (agente === 'sara') {
      // Mismo flujo de captura/cierre que el chat del portal — WhatsApp es
      // otro canal de entrada para SARA, no un agente distinto.
      const hasCierre  = /NUEVA_ORDEN/i.test(respuesta);
      const hasEscalar = /ESCALAR_HUMANO/i.test(respuesta);
      const hasCerrar  = /CERRAR_CHAT/i.test(respuesta);
      const sara_nota  = hasCierre ? 'cierre_de_venta' : hasEscalar ? 'escalado_a_operaciones' : hasCerrar ? 'chat_cerrado' : 'cotizacion_en_proceso';

      const leadDataMatch = respuesta.match(/LEAD_DATA:\s*(\{[^\n]+\})/);
      let datosSara = {};
      if (leadDataMatch) { try { datosSara = JSON.parse(leadDataMatch[1]); } catch {} }

      const primer_mensaje = (history.find(m => m.role === 'user')?.content || texto).slice(0, 300);
      const lead = leads.add({ ...datosSara, sara_nota, primer_mensaje, sessionId: session, canal: 'whatsapp' });

      if (hasCierre) {
        pushActividad({ agente: 'SARA', tipo: 'NUEVA_ORDEN', mensaje: `Nueva orden ${lead.folio || ''} — ${lead.empresa || lead.nombre || ''}`, sessionId: session });
        sendPush({
          title: '🚛 Nueva orden — SARA (WhatsApp)',
          body: `${lead.empresa || lead.nombre || 'Cliente'} · ${lead.origen || ''}→${lead.destino || ''} · Folio ${lead.folio || ''}`,
          tag: 'nueva-orden', url: '/', tipo: 'NUEVA_ORDEN', urgente: true,
        }).catch(() => {});
        await ordersStore.guardarOrden(lead).catch(e => console.error('[ordersStore WA]', e.message));
        contactos.upsertContacto({
          agente: 'sara', tipo: 'cliente',
          nombre_completo: lead.nombre, telefono: lead.telefono, email: lead.email,
          empresa: lead.empresa, tipo_carga: lead.tipo_carga,
          resumen_interaccion: lead.resumen || `Folio ${lead.folio} — ${lead.origen} → ${lead.destino}`,
          canal: 'whatsapp',
        }).catch(e => console.error('[contactos]', e.message));
        buscarUnidadParaOrden(lead);
      }

      if (esPrimerMensaje) {
        notifier.notificarLead(lead).catch(e => console.error('[notifier WA primer-contacto]', e.message));
      }
      if (hasCierre || hasEscalar || hasCerrar) {
        const histWA = memory.buildContext(session).history || [];
        notifier.notificarResumen(lead, sara_nota, histWA).catch(e => console.error('[notifier WA resumen]', e.message));
      }
    } else if (agente === 'sofia') {
      // Marcador UPSERT_CONTACTO — respaldo para cuando SOFIA cierra un acuerdo
      // con un proveedor por WhatsApp en vez de por llamada de Vapi.
      const contactoMatchWA = respuesta.match(/UPSERT_CONTACTO:\s*(\{[^\n]+\})/);
      if (contactoMatchWA) {
        try {
          const datos = JSON.parse(contactoMatchWA[1]);
          contactos.upsertContacto({
            agente: 'sofia',
            tipo: datos.tipo || 'proveedor',
            nombre_completo: datos.nombre_completo || datos.nombre,
            telefono: datos.telefono, email: datos.email, empresa: datos.empresa,
            tipo_carga: datos.tipo_carga,
            resumen_interaccion: datos.resumen_interaccion || datos.resumen,
            canal: 'whatsapp',
          }).catch(e => console.error('[contactos]', e.message));
        } catch (e) { console.error('[UPSERT_CONTACTO WA] JSON inválido:', e.message); }
      }
    } else if (agente === 'noa') {
      // NOA — alerta crítica detectada en la conversación de WhatsApp
      if (/ALERTA_CRITICA/i.test(respuesta)) {
        try {
          const m = respuesta.match(/ALERTA_CRITICA:\s*(\{[^\n]+\})/);
          const datos = m ? JSON.parse(m[1]) : {};
          pushActividad({ agente: 'NOA', tipo: 'ALERTA_CRITICA', mensaje: `🚨 ${datos.motivo || 'Alerta crítica'} — folio ${datos.folio || '—'}`, metadata: datos });
          sendPush({
            title: '🚨 ALERTA CRÍTICA — NOA',
            body: `${datos.motivo || 'Revisar de inmediato'} · Folio ${datos.folio || '—'}`,
            tag: 'alerta-critica', url: '/ops-center.html#noa', tipo: 'ALERTA_CRITICA', urgente: true,
          }).catch(() => {});
          // Mensaje directo por WhatsApp al equipo — automático, nadie tiene que ordenarlo.
          alertasStaff.alertarCriticoStaff({ ...datos, canal: 'whatsapp' }).catch(e => console.error('[alertasStaff]', e.message));
        } catch (e) { console.error('[WA] ALERTA_CRITICA inválida:', e.message); }
      }

      // NOA — estatus de seguimiento armado con info extraída de la conversación
      if (/ESTATUS_SEGUIMIENTO/i.test(respuesta)) {
        try {
          const m = respuesta.match(/ESTATUS_SEGUIMIENTO:\s*(\{[^\n]+\})/);
          const datos = m ? JSON.parse(m[1]) : {};
          pushActividad({ agente: 'NOA', tipo: 'ESTATUS_SEGUIMIENTO', mensaje: `📦 Estatus folio ${datos.folio || '—'} enviado al equipo`, metadata: datos });
          alertasStaff.enviarEstatusSeguimiento(datos).catch(e => console.error('[alertasStaff]', e.message));
        } catch (e) { console.error('[WA] ESTATUS_SEGUIMIENTO inválido:', e.message); }
      }

      // Memoria compartida cross-agente — solo si NOA confirma algo real (alta de
      // operador o coordinación cerrada), nunca en chequeos rutinarios.
      const contactoMatchWA = respuesta.match(/UPSERT_CONTACTO:\s*(\{[^\n]+\})/);
      if (contactoMatchWA) {
        try {
          const datos = JSON.parse(contactoMatchWA[1]);
          contactos.upsertContacto({
            agente: 'noa',
            tipo: datos.tipo || 'operador',
            nombre_completo: datos.nombre_completo || datos.nombre,
            telefono: datos.telefono, email: datos.email, empresa: datos.empresa,
            tipo_carga: datos.tipo_carga,
            resumen_interaccion: datos.resumen_interaccion || datos.resumen,
            canal: 'whatsapp',
          }).catch(e => console.error('[contactos]', e.message));
        } catch (e) { console.error('[UPSERT_CONTACTO WA] JSON inválido:', e.message); }
      }
    }

    if (esPrimerMensaje) {
      pushActividad({ agente: agenteU, tipo: 'MENSAJE_NUEVO', mensaje: `Primer contacto WhatsApp (${agenteU}): ${phone}`, sessionId: session });
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

// ─── 2Chat — grupo de WhatsApp "ABSTORAGES IA - TEST" (MVP SOFIA/NOA) ───────
// Sin auth — 2Chat llama esto externamente. Responde rápido y procesa aparte
// para no bloquear el webhook (mismo patrón que /api/vapi/webhook).
// Cola compartida entre grupo y 1:1 — formato para WhatsApp + trigger de
// llamada real, idéntico en ambos canales de 2Chat.
// Reglas de formato para WhatsApp — compartidas entre TODOS los canales de
// WhatsApp (2Chat grupo/1:1 Y Twilio de producción). Antes solo vivían aquí,
// dentro de MODO_2CHAT_COLA — el webhook de Twilio (el WhatsApp real de
// producción, con clientes/proveedores) no las tenía, así que las IA podían
// mandar **negritas**, ##, ---, tablas con | e incluso bloques de JSON
// crudos ahí, que WhatsApp no renderiza y quedan ilegibles.
const FORMATO_WHATSAPP =
  `WhatsApp no interpreta markdown — NUNCA uses [texto](link), **negritas** (doble asterisco), encabezados con #, líneas separadoras con ---, tablas con |, bloques de código con \`\`\`, ni llaves {}. Si necesitas resaltar algo usa mayúsculas o *un solo asterisco* (así sí se ve en negritas en WhatsApp). Escribe correos y teléfonos como texto plano, nunca como link. ` +
  `Nunca mandes bloques de código, JSON, esquemas técnicos ni propuestas de arquitectura tal cual — eso no se lee en un teléfono y se ve como basura de símbolos. Si te piden algo así de técnico, explícalo en 2-3 oraciones simples con lo esencial, y ofrece seguir el detalle técnico por otro medio (el chat de la plataforma, o que alguien del equipo lo revise ahí) en vez de volcarlo completo en el mensaje.\n\n` +
  `Listas de varios registros (folios, proveedores, etc.): cuando des 3 o más en una sola respuesta, NUNCA uses tablas ni pipes | ni bloques de código — un registro por línea, en una sola oración corta de texto plano, algo como "Folio OP-ABS-26-XXXX, cliente X, ruta Y, estatus Z." Un salto de línea entre cada registro, sin encabezados de columna ni separadores. Si son muchos (más de 6-8), no los vuelques todos — da los más urgentes o relevantes primero y ofrece mandar el resto si hace falta.\n\n` +
  `Emojis: úsalos con moderación, casi nunca — como mucho uno por mensaje completo, y solo si de verdad aporta (🚨 para una alerta crítica real). Nunca decores encabezados, listas ni cada línea con emojis — eso es justo lo que hace un mensaje difícil de leer.`;

const MODO_2CHAT_COLA =
  `No inventes información — si no la tienes, dilo directo y pide lo que falta. ` +
  `Habla natural, como una persona real escribiendo WhatsApp — nunca uses jerga de radio/militar tipo "Roger", "Copy", "10-4", "Enterado", "Afirmativo" (los operadores no entienden esas palabras). Para confirmar algo usa palabras comunes: "Ok", "Correcto", "Perfecto", "Va", "Listo". ` +
  `No emitas NUEVA_ORDEN ni LEAD_DATA en este canal — esto es conversación interna del equipo, no un cierre de venta real con un cliente, así que ese flujo no aplica aquí. ` +
  FORMATO_WHATSAPP + `\n\n` +
  `**Llamadas reales:** si de la conversación se desprende que genuinamente hace falta una llamada de voz real (alguien lo pide explícitamente, o hay que coordinar/confirmar algo que no se resuelve bien por texto) — emite al final de tu respuesta, en línea aparte:\n` +
  `INICIAR_LLAMADA: {"telefono":"+52XXXXXXXXXX","nombre":"[nombre de a quién se llama]","motivo":"[motivo breve]"}\n` +
  `Esto dispara una llamada real de Vapi de inmediato — no lo emitas por rutina ni "por si acaso", solo cuando de verdad se necesite. Si es alguien del equipo interno de ABSTORAGES puedes dejar "telefono" vacío ("") — el sistema resuelve su número real por su nombre. ` +
  `**Mensajes de WhatsApp a un tercero:** si te piden explícitamente avisarle/escribirle algo a alguien que no está en esta conversación (ej. "avísale a Fulano que...", "mándale un WhatsApp a Fulano diciendo...") — emite en línea aparte:\n` +
  `INICIAR_MENSAJE: {"telefono":"+52XXXXXXXXXX","nombre":"[nombre del destinatario]","mensaje":"[el mensaje exacto a enviar, ya redactado, listo para mandar tal cual]"}\n` +
  `Esto manda un WhatsApp real de inmediato a esa persona. Nunca inventes un número. Si el destinatario es alguien del equipo interno de ABSTORAGES (los que reconoces en la sección de equipo), puedes dejar "telefono" vacío ("") — el sistema resuelve su número real automáticamente por su nombre, tú no lo necesitas saber. Si es alguien externo cuyo teléfono no tienes en esta conversación, pregúntalo antes de emitir el token — nunca digas "listo, enviado" sin haber emitido primero el token real; si no tienes el dato, dilo y pide el teléfono, no finjas que ya se mandó. ` +
  `**Si te piden avisar/llamar a VARIAS personas en un solo pedido** (ej. "avísale a Gabriel, Diego y Rafael que...") — emite un token INICIAR_MENSAJE (o INICIAR_LLAMADA) POR CADA PERSONA, cada uno en su propia línea, con los datos de esa persona. Un solo pedido con 3 destinatarios son 3 tokens, no uno. Nunca digas que le avisaste a alguien sin haber emitido su token individual. ` +
  `**Solo si eres SARA o SOFIA** (NOA no tiene WhatsApp propio de Twilio — si eres NOA y necesitas avisar/dar estatus, usa INICIAR_LLAMADA en vez de esto): para avisos a VARIAS personas del equipo o estatus proactivo a un cliente/proveedor, usa las plantillas seguras de Twilio en vez de INICIAR_MENSAJE — son el canal correcto para esto (no arriesgan que se restrinja el número):\n` +
  `AVISO_EQUIPO_WA: {"remitente":"[SARA o SOFIA]","mensaje":"[el aviso, corto y claro]","destinatarios":["gabriel","diego","rafael"]}\n` +
  `(claves válidas de destinatarios: dante, rafael, manuel, gabriel, diego — pon las que apliquen, 1 o varias)\n` +
  `ESTATUS_FOLIO_WA: {"telefono":"+52XXXXXXXXXX","nombre":"[nombre]","folio":"OP-ABS-YY-XXXX","resumen":"[estatus breve]"}\n` +
  `(para avisarle a un cliente o proveedor el estatus de su folio sin que te lo hayan preguntado en este momento)\n` +
  `Para cualquier token de control (INICIAR_LLAMADA, INICIAR_MENSAJE, AVISO_EQUIPO_WA, ESTATUS_FOLIO_WA, ALERTA_CRITICA, ESTATUS_SEGUIMIENTO si tu rol los usa): el sistema los detecta y los quita automáticamente antes de que el grupo/contacto vea el mensaje — tú solo emítelos en su propia línea al final con el formato exacto, nunca los expliques, nunca agregues notas tipo "(esto no lo muestres)" ni nada parecido, y nunca cambies el nombre del token — eso rompe la detección y se filtra tal cual al chat.`;

const MODO_GRUPO =
  `\n\n---\n\n## 🟢 MODO GRUPO DE WHATSAPP\n` +
  `Estás respondiendo dentro de un grupo de WhatsApp junto a humanos y otros agentes AI, no en un chat 1:1. ` +
  `Responde corto y natural — nada de párrafos largos, nada de listas eternas. ` +
  `No te presentes ni expliques quién eres en cada mensaje, ya te conocen. ` +
  `**Si alguien te habla a ti (por nombre o mencionándote), SIEMPRE respondes — sin excepción.** Nunca te quedes callada ni ignores la pregunta. Si te piden un favor dentro de tu dominio (mandar un mensaje, hacer una llamada, disponibilidad de unidades, información de folios/clientes/proveedores, lo que sea que ya sabes hacer) — hazlo, no des largas ni digas que no puedes si sí puedes. Solo si genuinamente no tienes el dato o la acción está fuera de tu alcance, dilo claro y directo — pero nunca por default, siempre intenta ayudar primero. ` +
  MODO_2CHAT_COLA;

const MODO_2CHAT_1A1 =
  `\n\n---\n\n## 🟢 MODO WHATSAPP 1:1 (número de prueba, vía 2Chat)\n` +
  `Estás respondiendo un chat directo, no en el grupo. Responde corto y natural — nada de párrafos largos, nada de listas eternas. ` +
  MODO_2CHAT_COLA;

const TWOCHAT_NUMEROS = {
  sofia: process.env.TWOCHAT_NUMBER_SOFIA,
  noa:   process.env.TWOCHAT_NUMBER_NOA,
  sara:  process.env.TWOCHAT_NUMBER_SARA,
};
const TWOCHAT_PREFIJO = { sofia: '🟩 SOFIA:', noa: '🟨 NOA:', sara: '🟦 SARA:' };
const TWOCHAT_PROMPT_BASE = { sofia: SOFIA_PROMPT, noa: NOA_PROMPT, sara: SARA_PROMPT };

// Nombre real de cada grupo de WhatsApp (wa_group_name) — no viaja en los
// mensajes guardados, se resuelve vía API de 2Chat con caché de 10 min para
// no pegarle a la API en cada carga del historial.
let _nombresGruposCache = { ts: 0, porUuid: {} };
async function obtenerNombresGruposWA() {
  if (Date.now() - _nombresGruposCache.ts < 10 * 60 * 1000) return _nombresGruposCache.porUuid;
  const porUuid = {};
  for (const num of Object.values(TWOCHAT_NUMEROS).filter(Boolean)) {
    try {
      const r = await twochat.listarGrupos(num);
      (r.data || []).forEach(g => { porUuid[g.uuid] = g.wa_group_name; });
    } catch (e) { console.error('[2Chat] Error listando grupos de', num, ':', e.message); }
  }
  _nombresGruposCache = { ts: Date.now(), porUuid };
  return porUuid;
}

// 2Chat asigna un group.uuid DISTINTO por cada número/canal que es miembro
// del mismo grupo real de WhatsApp — no es un id único global, es un id
// scoped a cada canal. Sin resolver esto, un agente que no fue el que
// "recibió" el webhook (ej. SOFIA cuando el mensaje llegó por el canal de
// NOA) intenta mandar su respuesta a un uuid que no le pertenece a ella y
// el envío falla en silencio — eso es lo que hacía que SOFIA se quedara
// callada en un grupo con las 3 IAs mientras NOA/SARA sí contestaban.
let _crossRefGruposCache = { ts: 0, porWaGroupId: {}, porUuidCanal: {} };
async function resolverGruposWA() {
  if (Date.now() - _crossRefGruposCache.ts < 5 * 60 * 1000) return _crossRefGruposCache;
  const porWaGroupId = {}; // wa_group_id (real, universal) → { nombre, [agente]: uuid propio de ese agente }
  const porUuidCanal = {}; // uuid scoped-a-un-canal (el que llega en cualquier webhook) → wa_group_id
  for (const [agente, num] of Object.entries(TWOCHAT_NUMEROS).filter(([, n]) => n)) {
    try {
      const r = await twochat.listarGrupos(num);
      for (const g of (r.data || [])) {
        if (!g.wa_group_id) continue;
        if (!porWaGroupId[g.wa_group_id]) porWaGroupId[g.wa_group_id] = { nombre: g.wa_group_name };
        porWaGroupId[g.wa_group_id][agente] = g.uuid;
        porUuidCanal[g.uuid] = g.wa_group_id;
      }
    } catch (e) { console.error('[2Chat] Error listando grupos de', agente, ':', e.message); }
  }
  _crossRefGruposCache = { ts: Date.now(), porWaGroupId, porUuidCanal };
  return _crossRefGruposCache;
}

// Compara números por los últimos 10 dígitos — WhatsApp antepone un "1" extra
// a los celulares mexicanos en el JID (52 1 XXXXXXXXXX) que no aparece en el
// E.164 normal (+52XXXXXXXXXX), así que comparar el string completo no sirve.
function mismoNumero(a, b) {
  const da = (a || '').replace(/\D/g, '').slice(-10);
  const db = (b || '').replace(/\D/g, '').slice(-10);
  return !!da && da === db;
}

// Las menciones @agente en WhatsApp se mandan como @<número>, no como texto
// "@SOFIA" — solo se ve el nombre en la UI del cliente. Se detecta buscando
// cualquier "@<dígitos>" en el texto y comparando contra el número del agente.
// Además de "@sofia"/"@noa"/"@sara" literal, también se dispara con el
// nombre suelto en el texto ("Sofia, tienes...", "oye Sara me ayudas") —
// quien le habla a una de las 3 en el grupo SIEMPRE debe recibir respuesta,
// no solo cuando usa la @ literal.
function nombraAgente(texto, ...nombres) {
  return nombres.some(n => new RegExp(`(^|[^a-záéíóúñ])${n}([^a-záéíóúñ]|$)`, 'i').test(texto));
}
function detectarTriggerGrupo(texto, quotedMsgId) {
  const t = texto || '';
  const menciones = (t.match(/@(\d+)/g) || []).map(m => m.slice(1));
  if (nombraAgente(t, 'sofia', 'sofía') || menciones.some(m => mismoNumero(m, TWOCHAT_NUMEROS.sofia))) return 'sofia';
  if (nombraAgente(t, 'noa')            || menciones.some(m => mismoNumero(m, TWOCHAT_NUMEROS.noa)))   return 'noa';
  if (nombraAgente(t, 'sara')           || menciones.some(m => mismoNumero(m, TWOCHAT_NUMEROS.sara)))  return 'sara';
  if (quotedMsgId) {
    const agenteReply = grupoWA.agentePorMessageId(quotedMsgId);
    if (agenteReply === 'sofia' || agenteReply === 'noa' || agenteReply === 'sara') return agenteReply;
  }
  return null;
}

// Dedup por contenido — respaldo del dedup por messageId. Cuando un grupo
// tiene más de un canal nuestro como miembro (ej. NOA/SOFIA/SARA en el mismo
// grupo), 2Chat entrega el mismo mensaje real una vez por cada canal, y cada
// entrega puede traer un id/uuid DISTINTO (es un registro propio de 2Chat
// por canal, no el id universal del mensaje de WhatsApp) — dedup por
// messageId solo no alcanza. Como el remitente+texto sí es el mismo mensaje
// real sin importar qué canal lo entregó, se usa eso como llave.
const _dedupContenidoGrupo = new Map(); // "telefono|texto" → timestamp del último visto
const DEDUP_CONTENIDO_MS = 15000;
function esDuplicadoPorContenido(telefono, texto) {
  const key = `${telefono}|${texto}`;
  const ahora = Date.now();
  const anterior = _dedupContenidoGrupo.get(key);
  _dedupContenidoGrupo.set(key, ahora);
  if (_dedupContenidoGrupo.size > 500) {
    for (const [k, ts] of _dedupContenidoGrupo) if (ahora - ts > DEDUP_CONTENIDO_MS) _dedupContenidoGrupo.delete(k);
  }
  return !!anterior && (ahora - anterior) < DEDUP_CONTENIDO_MS;
}

// Campos de media en el payload de 2Chat aún no confirmados con un evento
// real (la doc no cargó al pedirla) — se revisan varios nombres plausibles
// a la vez; si algún día llega un mensaje con adjunto y esto no lo agarra,
// el payload crudo ya se loguea completo arriba, así se ajusta rápido.
function extraerMediaUrls2Chat(evento) {
  const m = evento.message || {};
  return [...new Set([m.media?.url, m.media_url, m.attachment?.url, m.url].filter(Boolean))];
}

app.post('/webhook/2chat', express.json(), (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const evento = req.body;
      console.log('[2Chat Webhook] payload crudo:', JSON.stringify(evento).slice(0, 2000));

      const messageId = evento.id || evento.uuid;
      const esGrupo = !!evento.group?.uuid;
      const texto = evento.message?.text || '';
      const mediaUrls2Chat = extraerMediaUrls2Chat(evento);
      if (evento.message?.type && evento.message.type !== 'text' && !mediaUrls2Chat.length) {
        console.warn('[2Chat Webhook] Mensaje de tipo', evento.message.type, 'sin URL de media detectada — revisar payload crudo de arriba y ajustar extraerMediaUrls2Chat().');
      }
      const quotedMsgId = evento.quoted_msg?.id || null;
      const participante = evento.participant || {};

      // Identidad del remitente — en grupo viene en `participant`, en 1:1 en
      // remote_phone_number/contact (remote_phone_number sale null en grupo).
      const remitentePhone = esGrupo ? participante.phone_number : evento.remote_phone_number;
      const personaEquipo = staffDirectory.buscarPorTelefono(remitentePhone);
      const nombreCrudo = esGrupo
        ? (participante.pushname || participante.phone_number || 'alguien')
        : (evento.contact?.first_name || evento.remote_phone_number || 'alguien');
      const remitente = personaEquipo ? `${personaEquipo.nombre} (${personaEquipo.puesto})` : nombreCrudo;
      // Nunca autorespondernos: si quien mandó el mensaje es uno de nuestros
      // propios números de agente, es un eco de algo que nosotros mandamos.
      const esPropio = Object.values(TWOCHAT_NUMEROS).some(n => mismoNumero(n, remitentePhone));

      if (grupoWA.existeMensaje(messageId)) return; // dedup — 2Chat puede reintentar el mismo evento
      const claveDedupContenido = texto || mediaUrls2Chat[0] || '';
      if (esGrupo && claveDedupContenido && esDuplicadoPorContenido(remitentePhone, claveDedupContenido)) return; // mismo mensaje real, entregado por otro canal

      // canalUuid identifica la conversación para memoria de contexto — en
      // grupo se normaliza al wa_group_id real (universal, no scoped a un
      // canal) para que la historia no se fragmente según qué número
      // "recibió" el webhook; en 1:1 es un id sintético por contacto.
      const canalUuidRecibido = esGrupo ? evento.group.uuid : null;
      let canalUuid = esGrupo ? canalUuidRecibido : `1a1:${(remitentePhone || '').replace(/\D/g, '').slice(-10)}`;

      // Se registra YA, sin ningún await de por medio desde el chequeo de
      // dedup — 2Chat entrega el mismo mensaje de grupo una vez por cada
      // canal que es miembro (NOA/SOFIA/SARA pueden estar las 3 en el mismo
      // grupo), casi en simultáneo. Si hubiera un await aquí, dos entregas
      // del mismo mensaje podrían pasar ambas el chequeo de dedup antes de
      // que ninguna alcance a registrarse, y el mensaje se procesaría (y se
      // contestaría) dos veces.
      const registro = grupoWA.registrar({
        message_id: messageId, group_uuid: canalUuid, sender_phone: remitentePhone || null,
        sender_name: remitente, agent: null,
        message_text: texto || (mediaUrls2Chat.length ? '[archivo adjunto]' : ''),
        direction: 'incoming', reply_to_message_id: quotedMsgId,
      });

      if (esPropio) return; // eco de un mensaje que mandamos nosotros mismos — nunca autorespondernos

      // Recién aquí, ya cerrada la ventana de carrera, se resuelve el id
      // real y universal del grupo (puede requerir una llamada async a la
      // API de 2Chat si el caché está frío) y se actualiza el registro ya
      // guardado para que quede unificado.
      let waGroupId = null;
      if (esGrupo) {
        const cross = await resolverGruposWA();
        waGroupId = cross.porUuidCanal[canalUuidRecibido] || null;
        if (waGroupId) { canalUuid = waGroupId; registro.group_uuid = waGroupId; }
      }

      let agente;
      if (esGrupo) {
        agente = detectarTriggerGrupo(texto, quotedMsgId);
        if (!agente) return; // Regla 3 — sin trigger, solo se guarda
      } else {
        // 1:1 se contesta siempre (no hace falta @mención) — el agente lo
        // decide el número al que le escribieron, no el contenido del texto.
        agente = Object.entries(TWOCHAT_NUMEROS).find(([, n]) => mismoNumero(n, evento.channel_phone_number))?.[0];
        if (!agente) { console.log('[2Chat Webhook] 1:1 a un número no reconocido:', evento.channel_phone_number); return; }
      }

      const fromNumber = TWOCHAT_NUMEROS[agente];
      if (!fromNumber) { console.log(`[2Chat Webhook] TWOCHAT_NUMBER_${agente.toUpperCase()} no configurado`); return; }

      const promptBase = TWOCHAT_PROMPT_BASE[agente];
      const aprendizajeBlock = agente === 'noa' ? incidentesNOA.bloqueAprendizaje() : '';
      let systemPrompt = promptBase + aprendizajeBlock + (esGrupo ? MODO_GRUPO : MODO_2CHAT_1A1);
      // 1:1 fuera del grupo interno — si no es equipo, ¿ya es un contacto
      // conocido (proveedor/cliente con historial real)? El grupo se salta
      // esto porque ahí todos son equipo interno por definición.
      if (!esGrupo && !personaEquipo) {
        const contactoConocido = await contactos.buscarPorTelefono(remitentePhone, agente);
        if (contactoConocido) systemPrompt += contactos.bloqueContactoConocido(contactoConocido);
      }
      // Datos reales del TMS (folios, estatus, ubicación GPS en vivo) — sin
      // esto NOA/SOFIA no tienen forma de contestar sobre folios reales por
      // este canal, igual que ya se hace en el chat de la plataforma y en
      // WhatsApp (Twilio).
      if (agente === 'sofia') {
        const tmsCtx = await tms.getContextoSOFIA(texto);
        if (tmsCtx) systemPrompt += tmsCtx;
      } else if (agente === 'noa') {
        const tmsCtx = await tms.getContextoNOA(texto);
        if (tmsCtx) systemPrompt += tmsCtx;
      } else if (agente === 'sara') {
        const tmsCtx = await tms.getContextoSARA(texto);
        if (tmsCtx) systemPrompt += tmsCtx;
      }
      const historial = grupoWA.contextoGrupo(canalUuid, 20).map(m => ({
        role: m.direction === 'outgoing' ? 'assistant' : 'user',
        content: m.direction === 'outgoing' ? m.message_text : `${m.sender_name}: ${m.message_text}`,
      }));

      // Imagen/PDF adjunto (evidencia de caja, carta porte, etc.) — se
      // descarga y se manda como bloque multimodal; 2Chat sirve sus media
      // URLs públicas, sin necesidad de auth.
      let contenidoParaClaude = `${remitente}: ${texto}`;
      if (mediaUrls2Chat.length) {
        const { content, adjuntos } = await vision.construirContenidoConArchivos(mediaUrls2Chat, `${remitente}: ${texto}`);
        if (adjuntos > 0) contenidoParaClaude = content;
      }

      // Sin límite bajo de tokens — una respuesta cortada a medias (ej. una
      // lista de folios truncada) es peor que tardar unos segundos más.
      const respuesta = await chat(systemPrompt, [...historial, { role: 'user', content: contenidoParaClaude }]);

      // Tokens de control — igual que en los demás canales (chat/WhatsApp/
      // llamada), se detectan y se limpian del texto antes de mandarlo al
      // grupo/contacto. El regex tolera que el modelo omita el guion bajo
      // (ALERTACRITICA en vez de ALERTA_CRITICA) para no perder una alerta
      // real por un desliz de formato.
      // /g — un mismo pedido puede incluir varios destinatarios ("avísale a
      // Gabriel, Diego y Rafael"), y cada uno se emite como su propio token
      // en su propia línea. Con match simple (sin /g) solo se procesaba el
      // primero y se le decía "enviado" a todos los demás sin haber hecho
      // nada — esto lo corrige.
      let llamadaMatches = [...respuesta.matchAll(/INICIAR_LLAMADA:\s*(\{[^\n]+\})/g)];
      let mensajeMatches = [...respuesta.matchAll(/INICIAR_MENSAJE:\s*(\{[^\n]+\})/g)];
      // Pedido explícito (20-ago-2026): NI NOA, NI SARA, NI SOFIA mandan
      // mensajes/llamadas masivas por ahora — se cae al primer destinatario
      // nada más, el resto se descarta con log, para que un "avísale a
      // Gabriel, Diego y Rafael" no dispare varios envíos aunque sea vía
      // 2Chat (no solo el fan-out de alertasStaff.js, que es solo NOA).
      // Reactivar con MENSAJES_MASIVOS=true.
      if (process.env.MENSAJES_MASIVOS !== 'true') {
        if (llamadaMatches.length > 1) { console.warn(`[2Chat Webhook] MENSAJES_MASIVOS apagado — se descartan ${llamadaMatches.length - 1} llamada(s) extra de ${agente}, solo se procesa la primera`); llamadaMatches = llamadaMatches.slice(0, 1); }
        if (mensajeMatches.length > 1) { console.warn(`[2Chat Webhook] MENSAJES_MASIVOS apagado — se descartan ${mensajeMatches.length - 1} mensaje(s) extra de ${agente}, solo se procesa el primero`); mensajeMatches = mensajeMatches.slice(0, 1); }
      }
      const alertaMatch  = agente === 'noa' && respuesta.match(/ALERTA_?CRITICA:\s*(\{[^\n]+\})/i);
      const estatusMatch = agente === 'noa' && !alertaMatch && respuesta.match(/ESTATUS_?SEGUIMIENTO:\s*(\{[^\n]+\})/i);
      // AVISO_EQUIPO_WA / ESTATUS_FOLIO_WA — solo SARA/SOFIA (tienen número
      // de Twilio propio) y NUNCA limitados por MENSAJES_MASIVOS: van por
      // plantilla aprobada de Meta, que es justo el canal seguro que
      // reemplaza el envío masivo por 2Chat, no el que se quiso pausar.
      const avisoEquipoMatches  = (agente === 'sara' || agente === 'sofia') ? [...respuesta.matchAll(/AVISO_EQUIPO_WA:\s*(\{[^\n]+\})/g)] : [];
      const estatusFolioMatches = (agente === 'sara' || agente === 'sofia') ? [...respuesta.matchAll(/ESTATUS_FOLIO_WA:\s*(\{[^\n]+\})/g)] : [];

      // Los tokens de alerta/estatus siempre van al final de la respuesta —
      // se corta el texto ahí para también descartar cualquier cosa que el
      // modelo haya escrito antes tratando de "explicarlo" (nunca debería,
      // pero así no se filtra si pasa).
      const corteIdx = alertaMatch ? alertaMatch.index : (estatusMatch ? estatusMatch.index : undefined);
      const respuestaLimpia = (corteIdx !== undefined ? respuesta.slice(0, corteIdx) : respuesta)
        .replace(/INICIAR_LLAMADA:\s*\{[^\n]+\}/g, '')
        .replace(/INICIAR_MENSAJE:\s*\{[^\n]+\}/g, '')
        .replace(/AVISO_EQUIPO_WA:\s*\{[^\n]+\}/g, '')
        .replace(/ESTATUS_FOLIO_WA:\s*\{[^\n]+\}/g, '')
        .trim();

      for (const m of avisoEquipoMatches) {
        try {
          const datos = JSON.parse(m[1]);
          if (Array.isArray(datos.destinatarios) && datos.destinatarios.length && datos.mensaje) {
            whatsappProactivo.avisarEquipo(agente, datos.remitente, datos.mensaje, datos.destinatarios)
              .catch(e => console.error('[2Chat Webhook] Error en AVISO_EQUIPO_WA:', e.message));
          } else {
            console.error('[2Chat Webhook] AVISO_EQUIPO_WA inválido (faltan destinatarios o mensaje):', datos);
          }
        } catch (e) { console.error('[2Chat Webhook] AVISO_EQUIPO_WA malformado:', e.message); }
      }

      for (const m of estatusFolioMatches) {
        try {
          const datos = JSON.parse(m[1]);
          whatsappProactivo.enviarEstatusFolio(agente, datos.telefono, datos.nombre, datos.folio, datos.resumen)
            .catch(e => console.error('[2Chat Webhook] Error en ESTATUS_FOLIO_WA:', e.message));
        } catch (e) { console.error('[2Chat Webhook] ESTATUS_FOLIO_WA malformado:', e.message); }
      }

      for (const m of llamadaMatches) {
        try {
          const datosLlamada = JSON.parse(m[1]);
          // El prompt nunca expone teléfonos del equipo — si el modelo no
          // trae uno (o dejó el campo vacío) pero el nombre sí matchea a
          // alguien del directorio interno, se resuelve el número real
          // aquí, del lado del servidor.
          if (!datosLlamada.telefono && datosLlamada.nombre) {
            const staffMatch = staffDirectory.buscarPorNombre(datosLlamada.nombre);
            if (staffMatch) datosLlamada.telefono = staffMatch.telefono;
          }
          if (datosLlamada.telefono) {
            const resumenContexto = historial.slice(-10).map(h => h.content).join('\n');
            vapi.llamarDesdeGrupo({
              agente, telefono: datosLlamada.telefono, nombre: datosLlamada.nombre,
              motivo: datosLlamada.motivo, resumenContexto,
            }).catch(e => console.error('[2Chat Webhook] Error disparando llamada:', e.message));
          } else {
            console.error('[2Chat Webhook] INICIAR_LLAMADA sin teléfono resoluble:', datosLlamada);
          }
        } catch (e) { console.error('[2Chat Webhook] INICIAR_LLAMADA inválido:', e.message); }
      }

      // El espaciado entre envíos ya lo maneja twochat.js de forma centralizada
      // (encolarEnvio) — un pedido a varias personas no se ve como ráfaga sin
      // tener que espaciar manualmente aquí también.
      for (const m of mensajeMatches) {
        try {
          const datosMensaje = JSON.parse(m[1]);
          if (!datosMensaje.telefono && datosMensaje.nombre) {
            const staffMatch = staffDirectory.buscarPorNombre(datosMensaje.nombre);
            if (staffMatch) datosMensaje.telefono = staffMatch.telefono;
          }
          if (datosMensaje.telefono && datosMensaje.mensaje) {
            await twochat.enviarMensaje(fromNumber, datosMensaje.telefono, datosMensaje.mensaje)
              .then(() => console.log(`[2Chat Webhook] Mensaje proactivo de ${agente} → ${datosMensaje.nombre || datosMensaje.telefono}`))
              .catch(e => console.error('[2Chat Webhook] Error mandando mensaje proactivo:', e.message));
          } else {
            console.error('[2Chat Webhook] INICIAR_MENSAJE sin teléfono resoluble o sin mensaje:', datosMensaje);
          }
        } catch (e) { console.error('[2Chat Webhook] INICIAR_MENSAJE inválido:', e.message); }
      }

      if (alertaMatch) {
        try {
          const datosAlerta = JSON.parse(alertaMatch[1]);
          pushActividad({ agente: 'NOA', tipo: 'ALERTA_CRITICA', mensaje: `🚨 ${datosAlerta.motivo || 'Alerta crítica'} — folio ${datosAlerta.folio || '—'}`, metadata: datosAlerta });
          sendPush({
            title: '🚨 ALERTA CRÍTICA — NOA',
            body: `${datosAlerta.motivo || 'Revisar de inmediato'} · Folio ${datosAlerta.folio || '—'}`,
            tag: 'alerta-critica', url: '/ops-center.html#noa', tipo: 'ALERTA_CRITICA', urgente: true,
          }).catch(() => {});
          alertasStaff.alertarCriticoStaff({ ...datosAlerta, canal: 'whatsapp-grupo' }).catch(e => console.error('[alertasStaff]', e.message));
        } catch (e) { console.error('[2Chat Webhook] ALERTA_CRITICA inválida:', e.message); }
      } else if (estatusMatch) {
        try {
          const datosEstatus = JSON.parse(estatusMatch[1]);
          pushActividad({ agente: 'NOA', tipo: 'ESTATUS_SEGUIMIENTO', mensaje: `📦 Estatus folio ${datosEstatus.folio || '—'} enviado al equipo`, metadata: datosEstatus });
          alertasStaff.enviarEstatusSeguimiento(datosEstatus).catch(e => console.error('[alertasStaff]', e.message));
        } catch (e) { console.error('[2Chat Webhook] ESTATUS_SEGUIMIENTO inválido:', e.message); }
      }

      // El prefijo 🟩/🟨 solo va en lo que se manda a WhatsApp — si se guarda
      // también en message_text, el agente lo ve en su propio historial de
      // contexto y empieza a imitarlo, duplicándolo en cada respuesta nueva.
      const textoFinal = `${TWOCHAT_PREFIJO[agente]}\n${respuestaLimpia}`;

      // Uuid con el que ESTE agente ve el grupo — puede no ser el mismo que
      // llegó en el webhook (ese pertenece al canal que lo entregó, no
      // necesariamente al agente que va a responder).
      let uuidParaEnviar = canalUuidRecibido;
      if (esGrupo && waGroupId) {
        const cross = await resolverGruposWA();
        const propio = cross.porWaGroupId[waGroupId]?.[agente];
        if (propio) uuidParaEnviar = propio;
        else console.error(`[2Chat Webhook] No se encontró el uuid propio de ${agente} para el grupo ${waGroupId} — el envío puede fallar`);
      }
      const envio = esGrupo
        ? await twochat.enviarMensajeGrupo(fromNumber, uuidParaEnviar, textoFinal)
        : await twochat.enviarMensaje(fromNumber, remitentePhone, textoFinal);
      grupoWA.registrar({
        message_id: envio.message_uuid || `local-${Date.now()}`, group_uuid: canalUuid, sender_phone: fromNumber,
        sender_name: agente.toUpperCase(), agent: agente, message_text: respuestaLimpia, direction: 'outgoing',
        reply_to_message_id: messageId,
      });
    } catch (e) {
      console.error('[2Chat Webhook] Error:', e.message);
    }
  });
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

// En llamadas entrantes Vapi no manda metadata.agente (eso solo lo mandamos
// nosotros en llamadas que origina el sistema) — se deduce por assistantId.
const AGENTE_POR_ASSISTANT_ID = {
  [process.env.VAPI_ASSISTANT_ID]:      'sofia',
  [process.env.VAPI_ASSISTANT_ID_SARA]: 'sara',
  [process.env.VAPI_ASSISTANT_ID_NOA]:  'noa',
};
function deducirAgente(call) {
  return call?.metadata?.agente || AGENTE_POR_ASSISTANT_ID[call?.assistantId] || 'sistema';
}

// ─── Vapi webhook (sin auth — Vapi llama externamente) ───────────────────────
app.post('/api/vapi/webhook', express.json(), (req, res) => {
  res.sendStatus(200);
  setImmediate(async () => {
    try {
      const evento = req.body;
      const tipo = evento.message?.type || evento.type;

      // ─── Eventos EN VIVO (llamada en curso) — se transmiten por SSE para
      // poder ver la llamada mientras ocurre, sin esperar al reporte final.
      if (tipo === 'transcript' || tipo === 'status-update' || tipo === 'speech-update') {
        const callVivo = evento.message?.call || evento.call || {};
        const metaVivo = callVivo.metadata || {};
        const agenteVivo = deducirAgente(callVivo);
        const agenteVivoLabel = agenteVivo === 'sofia' ? 'SOFIA' : agenteVivo === 'sara' ? 'SARA' : agenteVivo === 'noa' ? 'NOA' : String(agenteVivo).toUpperCase();

        if (tipo === 'transcript' && evento.message?.transcriptType === 'final') {
          pushActividad({
            agente: agenteVivoLabel, tipo: 'LLAMADA_VIVO',
            mensaje: `${evento.message.role === 'assistant' ? agenteVivoLabel : (callVivo.customer?.name || metaVivo.proveedor_nombre || metaVivo.nombre || 'Contacto')}: ${evento.message.transcript}`,
            metadata: { callId: callVivo.id, folio: metaVivo.folio || null, role: evento.message.role, texto: evento.message.transcript },
          });
        } else if (tipo === 'status-update') {
          const nombreContacto = callVivo.customer?.name || metaVivo.proveedor_nombre || metaVivo.nombre || callVivo.customer?.number || 'contacto';
          pushActividad({
            agente: agenteVivoLabel, tipo: 'LLAMADA_ESTADO',
            mensaje: `Llamada con ${nombreContacto} — ${evento.message.status}`,
            metadata: { callId: callVivo.id, folio: metaVivo.folio || null, status: evento.message.status },
          });

          // Llamada recién conectada — avisar en la plataforma y por correo,
          // una sola vez por callId (no repetir si Vapi manda el status de nuevo).
          if (evento.message.status === 'in-progress' && callVivo.id && !callsEnVivoNotificadas.has(callVivo.id)) {
            callsEnVivoNotificadas.add(callVivo.id);
            pushActividad({
              agente: agenteVivoLabel, tipo: 'LLAMADA_INICIADA',
              mensaje: `📞 ${agenteVivoLabel} está en llamada con ${nombreContacto}`,
              metadata: { callId: callVivo.id, folio: metaVivo.folio || null, telefono: callVivo.customer?.number || null },
            });
            notifier.notificarLlamadaIniciada({
              agente: agenteVivoLabel, nombre: nombreContacto, telefono: callVivo.customer?.number || null, folio: metaVivo.folio || null,
            }).catch(e => console.error('[notifier inicio-llamada]', e.message));
          }
        }
        return;
      }

      if (tipo !== 'end-of-call-report' && tipo !== 'call-ended') return;

      const call = evento.message?.call || evento.call || evento;
      const metadata = call.metadata || {};
      const agente = deducirAgente(call);
      const agenteLabel = agente === 'sofia' ? 'SOFIA' : agente === 'sara' ? 'SARA' : agente === 'noa' ? 'NOA' : String(agente).toUpperCase();
      const transcript = call.transcript || '';
      const nombre = call.customer?.name || metadata.proveedor_nombre || metadata.nombre || null;
      const telefono = call.customer?.number || null;
      const duracionSeg = (call.startedAt && call.endedAt)
        ? (new Date(call.endedAt) - new Date(call.startedAt)) / 1000
        : (evento.message?.durationSeconds || null);
      // Resumen auto-generado por Vapi (analysisPlan.summaryPlan) — llega en
      // el reporte de fin de llamada, no hay que pedirlo aparte.
      const resumen = evento.message?.analysis?.summary || call.analysis?.summary || null;
      // Datos estructurados auto-extraídos por Vapi (analysisPlan.structuredDataPlan) —
      // NOA no puede decir tokens de control en voz, así que en llamadas la alerta
      // crítica y el estatus de seguimiento se detectan así, no por regex de texto.
      const structuredData = evento.message?.analysis?.structuredData || call.analysis?.structuredData || null;

      // Registro persistente en disco — las 3 IAs, sobrevive redeploys
      callLog.registrar({
        agente, folio: metadata.folio || null, nombre, telefono,
        tipo: metadata.tipo || metadata.rol || null,
        transcript: transcript.slice(0, 3000), duracionSeg,
        endedReason: call.endedReason || null,
        resumen,
      });

      let yaNotificado = false;

      // Lógica específica de SOFIA: negociación con proveedor (folio, ganador)
      if (agente === 'sofia' && metadata.folio) {
        const resultado = vapi.procesarResultadoLlamada({ call });
        if (resultado) {
          console.log(`[Vapi Webhook] ${resultado.folio} | ${resultado.proveedorId} | disponible:${resultado.disponible} | precio:${resultado.precio}`);
          pushActividad({
            agente: 'SOFIA', tipo: 'VAPI_RESULTADO',
            mensaje: `${resultado.proveedorId} → ${resultado.disponible ? `✅ DISPONIBLE ${resultado.precio || ''}` : '❌ No disponible'}` + (resumen ? ` — ${resumen}` : ''),
            metadata: { folio: resultado.folio, ...resultado, resumen },
          });

          const estado = vapi.obtenerEstadoLlamadas(resultado.folio);
          if (estado?.ganador?.proveedorId === resultado.proveedorId) {
            yaNotificado = true;
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
            notifier.notificarAsignacion(resultado.folio, resultado.proveedorId, resultado.precio)
              .catch(e => console.error('[notifier asignacion]', e.message));

            // Memoria compartida cross-agente — solo por acuerdo real confirmado (ganador).
            const proveedoresReales = await tms.proveedoresParaVapi().catch(() => []);
            const proveedorInfo = proveedoresReales.find(p => p.id === resultado.proveedorId);
            contactos.upsertContacto({
              agente: 'sofia', tipo: 'proveedor',
              nombre_completo: proveedorInfo?.nombre || resultado.proveedorId,
              telefono: proveedorInfo?.telefono || null,
              resumen_interaccion: `Folio ${resultado.folio} confirmado a ${resultado.precio || 'precio por confirmar'}`,
              canal: 'llamada',
            }).catch(e => console.error('[contactos]', e.message));
          }
        }
      } else {
        // Reporte genérico de fin de llamada — SARA y NOA
        pushActividad({
          agente: agenteLabel, tipo: 'LLAMADA_TERMINADA',
          mensaje: `Llamada con ${nombre || telefono || 'contacto'} terminada${duracionSeg ? ` (${Math.round(duracionSeg)}s)` : ''}` + (resumen ? ` — ${resumen}` : ''),
          metadata: { folio: metadata.folio || null, telefono, duracionSeg, resumen },
        });

        // NOA — alerta crítica o estatus de seguimiento detectados en la llamada
        // (no puede decirlos en voz, así que salen del análisis estructurado de Vapi).
        if (agente === 'noa' && structuredData) {
          if (structuredData.alerta_critica) {
            const datosAlerta = { folio: structuredData.folio || metadata.folio || null, motivo: structuredData.motivo || 'Alerta detectada en llamada' };
            pushActividad({ agente: 'NOA', tipo: 'ALERTA_CRITICA', mensaje: `🚨 ${datosAlerta.motivo} — folio ${datosAlerta.folio || '—'}`, metadata: datosAlerta });
            sendPush({
              title: '🚨 ALERTA CRÍTICA — NOA', body: `${datosAlerta.motivo} · Folio ${datosAlerta.folio || '—'}`,
              tag: 'alerta-critica', url: '/ops-center.html#noa', tipo: 'ALERTA_CRITICA', urgente: true,
            }).catch(() => {});
            alertasStaff.alertarCriticoStaff({ ...datosAlerta, canal: 'llamada' }).catch(e => console.error('[alertasStaff]', e.message));
          } else if (structuredData.estatus_relevante && structuredData.estatus_resumen) {
            const datosEstatus = { folio: structuredData.folio || metadata.folio || null, resumen: structuredData.estatus_resumen };
            pushActividad({ agente: 'NOA', tipo: 'ESTATUS_SEGUIMIENTO', mensaje: `📦 Estatus folio ${datosEstatus.folio || '—'} enviado al equipo`, metadata: datosEstatus });
            alertasStaff.enviarEstatusSeguimiento(datosEstatus).catch(e => console.error('[alertasStaff]', e.message));
          }
        }
      }

      // Reporte (push + email) de cada llamada terminada, salvo la de
      // "carrier ganador" de SOFIA que ya mandó su propio push arriba.
      if (!yaNotificado) {
        sendPush({
          title: `📞 Llamada terminada — ${agenteLabel}`,
          body: `${nombre || telefono || 'Contacto'}${duracionSeg ? ` · ${Math.round(duracionSeg / 60 * 10) / 10} min` : ''}`,
          tag: 'llamada-terminada',
          url: '/',
          tipo: 'LLAMADA_TERMINADA',
        }).catch(() => {});
      }

      notifier.notificarLlamada({
        agente, nombre, telefono, duracionSeg, folio: metadata.folio || null,
        transcript: transcript.slice(0, 1500), resumen,
      }).catch(e => console.error('[notifier llamada]', e.message));
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

app.get('/api/sofia/folios', async (req, res) => {
  try {
    res.json((await ordersStore.listarOrdenes()).map(o => o.folio));
  } catch (e) {
    console.error('[sofia/folios]', e.message);
    res.json([]);
  }
});

// Estado de llamadas Vapi por folio
app.get('/api/vapi/estado/:folio', (req, res) => {
  const estado = vapi.obtenerEstadoLlamadas(req.params.folio.toUpperCase());
  if (!estado) return res.status(404).json({ error: 'Sin llamadas registradas para este folio' });
  res.json(estado);
});

// Llamada de prueba manual — usa la misma lógica que SOFIA para negociar con
// proveedores, pero apuntando a un número/nombre arbitrario (para validar la
// config de Vapi sin marcarle a un transportista real).
app.post('/api/vapi/test-call', soloAdmin, async (req, res) => {
  const { telefono, nombre, agente } = req.body || {};
  if (!telefono) return res.status(400).json({ error: 'telefono requerido (formato +52...)' });

  try {
    let resultado;
    if (agente === 'sara') {
      resultado = await vapi.llamarLead({
        id: 'TEST', nombre: nombre || 'Prueba', telefono,
        empresa: 'Empresa de prueba',
        origen: 'Monterrey', destino: 'Ciudad de México',
        tipo_unidad: 'caja seca 53', precio_cotizado: '$18,500 MXN',
      });
    } else if (agente === 'sofia-normal') {
      resultado = await vapi.llamarNormal(nombre || 'Prueba', telefono);
    } else if (agente === 'sara-prospeccion') {
      resultado = await vapi.llamarProspecto({
        nombre: nombre || 'Prueba', telefono, empresa: 'Empresa de prueba', cargo: 'Gerente de Logística',
      });
    } else if (agente === 'noa-chofer') {
      resultado = await vapi.llamarStatusChofer({
        telefono, nombre: nombre || 'Prueba', folio: 'TEST-NOA', ruta: 'Monterrey → Ciudad de México',
      });
    } else if (agente === 'noa-cliente') {
      resultado = await vapi.llamarStatusCliente({
        telefono, nombre: nombre || 'Prueba', folio: 'TEST-NOA', ruta: 'Monterrey → Ciudad de México',
      });
    } else {
      const proveedorPrueba = { id: 'TEST', nombre: nombre || 'Prueba', telefono };
      const ordenPrueba = {
        folio: 'TEST-' + Date.now().toString(36).toUpperCase(),
        ruta: 'Monterrey → Ciudad de México',
        tipo_unidad: 'caja seca 53',
        fecha_carga: new Date().toLocaleDateString('es-MX'),
        tipo_carga: 'prueba de configuración',
        peso_toneladas: '1',
      };
      resultado = await vapi.llamarProveedor(proveedorPrueba, ordenPrueba);
    }
    res.json({ ok: true, resultado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diagnóstico: ver la config real (voz, modelo, prompt) de un assistant en Vapi
app.get('/api/vapi/assistant/:id', soloAdmin, async (req, res) => {
  try {
    const data = await vapi.obtenerAssistant(req.params.id);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/vapi/assistant/:id', soloAdmin, async (req, res) => {
  try {
    const data = await vapi.actualizarAssistant(req.params.id, req.body || {});
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/vapi/numeros', soloAdmin, async (req, res) => {
  try {
    const data = await vapi.listarNumeros();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/vapi/numero/:id', soloAdmin, async (req, res) => {
  try {
    const data = await vapi.obtenerNumero(req.params.id);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/vapi/numero/:id/assistant', soloAdmin, async (req, res) => {
  const { assistantId } = req.body || {};
  if (!assistantId) return res.status(400).json({ error: 'assistantId requerido' });
  try {
    const data = await vapi.asignarAssistantANumero(req.params.id, assistantId);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Historial de llamadas (SOFIA/SARA/NOA) guardado en disco
app.get('/api/vapi/llamadas', adminUOps, (req, res) => {
  res.json(callLog.listar({ agente: req.query.agente, limit: Number(req.query.limit) || 200 }));
});

// Setup one-shot: aplica backend/db/schema.sql contra DATABASE_URL — idempotente
// Limpia la memoria del grupo de WhatsApp (2Chat MVP) — útil mientras se
// depura el detector de menciones/reply y queda contexto mal formado guardado.
app.post('/api/admin/limpiar-grupo-wa', soloAdmin, (req, res) => {
  const borrados = grupoWA.limpiar(req.body?.groupUuid);
  res.json({ ok: true, borrados });
});

// Incidentes críticos de NOA — historial + marcar resultado, para que su
// criterio se calibre con lo que de verdad pasó y no solo siga el protocolo.
app.get('/api/admin/incidentes', soloAdmin, (req, res) => {
  res.json(incidentesNOA.listar({ limit: req.query.limit ? Number(req.query.limit) : undefined }));
});

app.post('/api/admin/incidentes/:id/resolver', soloAdmin, (req, res) => {
  const { resultado, notas } = req.body || {};
  if (!['bien', 'mal', 'falsa_alarma'].includes(resultado)) {
    return res.status(400).json({ error: "resultado debe ser 'bien', 'mal' o 'falsa_alarma'" });
  }
  const incidente = incidentesNOA.marcarResultado(req.params.id, resultado, notas);
  if (!incidente) return res.status(404).json({ error: 'Incidente no encontrado' });
  res.json({ ok: true, incidente });
});

app.post('/api/admin/db-migrate', soloAdmin, async (req, res) => {
  try {
    await db.aplicarSchema();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diagnóstico: guarda una orden sintética vía ordersStore para confirmar
// que la persistencia en Postgres funciona de punta a punta.
app.post('/api/admin/test-orden', soloAdmin, async (req, res) => {
  try {
    const folio = `OP-ABS-${String(new Date().getFullYear()).slice(-2)}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const resultado = await ordersStore.guardarOrden({
      folio, nombre: 'Test Diagnóstico', empresa: 'TEST DIAGNOSTICO SA',
      telefono: '8100000000', email: 'test@diagnostico.com', rfc: 'TES010101AAA',
      origen: 'Monterrey', destino: 'Ciudad de México',
      tipo_unidad: 'caja seca 53', tipo_carga: 'prueba', peso_toneladas: '1',
      precio_cotizado: '10000',
    });
    const relectura = await ordersStore.obtenerOrdenPorFolio(folio);
    res.json({ ok: true, folio, guardado: resultado, relectura });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CONTACTOS (memoria compartida SARA/SOFIA/NOA) ──────────────────────────
app.get('/api/contactos', adminUOps, async (req, res) => {
  const agente = (req.query.agente || '').toUpperCase();
  if (!['SARA', 'SOFIA', 'NOA'].includes(agente)) {
    return res.status(400).json({ error: 'agente requerido: SARA, SOFIA o NOA' });
  }
  const lista = await contactos.listarPorAgente(agente, { tipo: req.query.tipo, q: req.query.q });
  res.json(lista);
});

app.get('/api/contactos/:id', adminUOps, async (req, res) => {
  const detalle = await contactos.obtenerDetalle(req.params.id);
  if (!detalle) return res.status(404).json({ error: 'Contacto no encontrado' });
  res.json(detalle);
});

// Diagnóstico: crea un contacto sintético para probar la persistencia sin
// depender de que un agente cierre una venta/acuerdo real en una prueba.
app.post('/api/admin/test-contacto', soloAdmin, async (req, res) => {
  try {
    const agente = (req.body?.agente || 'sara').toLowerCase();
    const contacto = await contactos.upsertContacto({
      agente, tipo: req.body?.tipo || 'cliente',
      nombre_completo: 'Contacto de Prueba', telefono: '8199999999',
      email: 'test@contacto.com', empresa: 'EMPRESA PRUEBA SA',
      tipo_carga: 'prueba', resumen_interaccion: 'Interacción de prueba generada por diagnóstico',
      canal: 'chat',
    });
    res.json({ ok: true, contacto });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diagnóstico: manda un WhatsApp de texto libre real vía Twilio (no
// plantilla) — solo funciona si el destinatario ya escribió primero al
// número de ese agente en las últimas 24h (regla de Meta/WhatsApp), si no
// Twilio lo rechaza. Útil para probar que un número de Twilio sí manda
// texto libre dentro de la ventana de servicio al cliente.
app.post('/api/admin/test-whatsapp-libre', soloAdmin, async (req, res) => {
  try {
    const { to, texto, agente } = req.body || {};
    if (!to || !texto) return res.status(400).json({ error: 'to y texto son requeridos' });
    await sendWhatsApp(to, texto, (agente || 'sofia').toLowerCase());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diagnóstico: dispara una plantilla real de Twilio Content API a UN
// destinatario específico — para confirmar en vivo que una plantilla ya
// aprobada por Meta de verdad manda el mensaje, sin tener que esperar a
// que el flujo real (leads/incidentes/folios) la dispare sola.
app.post('/api/admin/test-plantilla', soloAdmin, async (req, res) => {
  try {
    const { to, contentSid, variables, agente } = req.body || {};
    if (!to || !contentSid) return res.status(400).json({ error: 'to y contentSid son requeridos' });
    const from = WA_NUMBERS[(agente || 'sara').toLowerCase()] || TWILIO_WA_FROM;
    if (!TWILIO_SID || !TWILIO_TOKEN || !from) return res.status(400).json({ error: 'Faltan credenciales de Twilio o número del agente' });
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const body = new URLSearchParams({
      From: `whatsapp:${from}`,
      To:   `whatsapp:${to.replace(/^whatsapp:/, '')}`,
      ContentSid: contentSid,
      ContentVariables: JSON.stringify(variables || {}),
    });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}` },
      body,
    });
    const resp = await r.text();
    if (!r.ok) return res.status(502).json({ error: `Twilio ${r.status}: ${resp.slice(0, 400)}` });
    res.json({ ok: true, twilio: JSON.parse(resp) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diagnóstico: consulta el estatus real de un mensaje ya mandado por SID —
// "queued" en la respuesta inmediata no garantiza que se haya entregado,
// esto sí dice si falló y por qué (delivered/failed/undelivered + código
// de error real de Twilio/Meta).
app.get('/api/admin/estatus-mensaje/:sid', soloAdmin, async (req, res) => {
  try {
    if (!TWILIO_SID || !TWILIO_TOKEN) return res.status(400).json({ error: 'Faltan credenciales de Twilio' });
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages/${req.params.sid}.json`, {
      headers: { 'Authorization': `Basic ${auth}` },
    });
    const resp = await r.text();
    if (!r.ok) return res.status(502).json({ error: `Twilio ${r.status}: ${resp.slice(0, 400)}` });
    const m = JSON.parse(resp);
    res.json({ status: m.status, error_code: m.error_code, error_message: m.error_message, from: m.from, to: m.to, date_updated: m.date_updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diagnóstico: lista los últimos mensajes de Twilio hacia un número — para
// encontrar el SID de un mensaje mandado por una vía que no lo devuelve
// (ej. sendWhatsApp/texto libre) y así poder consultar su estatus real.
app.get('/api/admin/mensajes-recientes/:to', soloAdmin, async (req, res) => {
  try {
    if (!TWILIO_SID || !TWILIO_TOKEN) return res.status(400).json({ error: 'Faltan credenciales de Twilio' });
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const to = `whatsapp:${req.params.to.replace(/^whatsapp:/, '')}`;
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json?To=${encodeURIComponent(to)}&PageSize=5`, {
      headers: { 'Authorization': `Basic ${auth}` },
    });
    const resp = await r.text();
    if (!r.ok) return res.status(502).json({ error: `Twilio ${r.status}: ${resp.slice(0, 400)}` });
    const data = JSON.parse(resp);
    res.json((data.messages || []).map(m => ({
      sid: m.sid, status: m.status, error_code: m.error_code, from: m.from,
      body: (m.body || '').slice(0, 60), date_created: m.date_created,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Plantillas WhatsApp (Twilio Content API) — recuperar/recrear las que
// quedaron huérfanas del WABA (error 63027, "Template does not exist for a
// language and locale"). El recurso Content en sí sigue vivo en la cuenta de
// Twilio aunque la aprobación de WhatsApp haya quedado huérfana — se puede
// leer su texto exacto para no tener que re-teclearlo de memoria.
const TWILIO_CONTENT_BASE = 'https://content.twilio.com/v1/Content';

app.get('/api/admin/plantilla/:contentSid', soloAdmin, async (req, res) => {
  try {
    if (!TWILIO_SID || !TWILIO_TOKEN) return res.status(400).json({ error: 'Faltan credenciales de Twilio' });
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const r = await fetch(`${TWILIO_CONTENT_BASE}/${req.params.contentSid}`, {
      headers: { 'Authorization': `Basic ${auth}` },
    });
    const resp = await r.text();
    if (!r.ok) return res.status(502).json({ error: `Twilio ${r.status}: ${resp.slice(0, 500)}` });
    res.json(JSON.parse(resp));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Categoría (Marketing/Utility/Authentication) con la que Meta aprobó una
// plantilla — vive en el sub-recurso de ApprovalRequests, no en el Content
// principal. Hace falta saberla antes de recrear una plantilla: si se
// resomete con una categoría distinta a la que ya había pasado revisión, se
// arriesga un rechazo o una re-clasificación no deseada.
app.get('/api/admin/plantilla-aprobacion/:contentSid', soloAdmin, async (req, res) => {
  try {
    if (!TWILIO_SID || !TWILIO_TOKEN) return res.status(400).json({ error: 'Faltan credenciales de Twilio' });
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const r = await fetch(`${TWILIO_CONTENT_BASE}/${req.params.contentSid}/ApprovalRequests`, {
      headers: { 'Authorization': `Basic ${auth}` },
    });
    const resp = await r.text();
    if (!r.ok) return res.status(502).json({ error: `Twilio ${r.status}: ${resp.slice(0, 500)}` });
    res.json(JSON.parse(resp));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Crea un nuevo Content resource (plantilla) desde cero — no reutiliza el
// Content viejo/huérfano porque su historial de aprobación quedó ligado al
// WABA anterior; hay que someter uno nuevo. friendlyName debe ser único por
// cuenta de Twilio.
app.post('/api/admin/plantilla-crear', soloAdmin, async (req, res) => {
  try {
    const { friendlyName, language, body, variables } = req.body || {};
    if (!friendlyName || !body) return res.status(400).json({ error: 'friendlyName y body son requeridos' });
    if (!TWILIO_SID || !TWILIO_TOKEN) return res.status(400).json({ error: 'Faltan credenciales de Twilio' });
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const payload = {
      friendly_name: friendlyName,
      language: language || 'es_MX',
      variables: variables || {},
      types: { 'twilio/text': { body } },
    };
    const r = await fetch(TWILIO_CONTENT_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
      body: JSON.stringify(payload),
    });
    const resp = await r.text();
    if (!r.ok) return res.status(502).json({ error: `Twilio ${r.status}: ${resp.slice(0, 500)}` });
    res.json(JSON.parse(resp));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Somete un Content resource a aprobación de WhatsApp/Meta — a partir de
// aquí ya no es reversible sin gastar otro ciclo de revisión, por eso es un
// paso aparte y explícito, nunca automático dentro de plantilla-crear.
app.post('/api/admin/plantilla-someter', soloAdmin, async (req, res) => {
  try {
    const { contentSid, name, category } = req.body || {};
    if (!contentSid || !name) return res.status(400).json({ error: 'contentSid y name son requeridos' });
    if (!TWILIO_SID || !TWILIO_TOKEN) return res.status(400).json({ error: 'Faltan credenciales de Twilio' });
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    const r = await fetch(`${TWILIO_CONTENT_BASE}/${contentSid}/ApprovalRequests/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${auth}` },
      body: JSON.stringify({ name, category: category || 'UTILITY' }),
    });
    const resp = await r.text();
    if (!r.ok) return res.status(502).json({ error: `Twilio ${r.status}: ${resp.slice(0, 500)}` });
    res.json(JSON.parse(resp));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SOFIA: proveedores desde TMS ────────────────────────────────────────────
app.get('/api/sofia/proveedores', adminUOps, async (req, res) => {
  const local = () => require('./backend/data/proveedores.json').map(p => ({
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
      // Ubicación real (Wialon) para las unidades que la tengan — sin geocodificar
      // (evita saturar Nominatim en una consulta masiva), solo lat/lng para el mapa.
      await Promise.all(folios.map(async (f) => {
        if (!gpsProviders.esUrlSoportada(f.gps.url)) return;
        const ubic = await gpsProviders.obtenerUbicacion(f.gps.url, { conDireccion: false }).catch(() => null);
        if (ubic) { f.gps.la = ubic.lat; f.gps.ln = ubic.lng; }
      }));
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

    if (gpsProviders.esUrlSoportada(d['GPS'])) {
      const ubic = await gpsProviders.obtenerUbicacion(d['GPS']).catch(() => null);
      if (ubic) d._gpsVivo = ubic;
    }

    res.json(d);
  } catch (e) {
    console.error('[NOA/folio]', e.message);
    res.json(null);
  }
});

app.get('/api/sessions', (req, res) => res.json(memory.listSessions()));

// ─── HISTORIAL DE CONVERSACIONES (todas las sesiones, sin límite de tiempo) ──
function detectarAgente(id) {
  if (/^widget_|^web_sara_|^wa_sara_/.test(id))   return 'sara';
  if (/^sof_|^web_sofia_|^wa_sofia_/.test(id))    return 'sofia';
  if (/^noa_|^web_noa_|^wa_/.test(id))            return 'noa'; // wa_<phone> sin sufijo de agente = NOA
  if (/^hec_|^web_hector_/.test(id))              return 'hector';
  return 'desconocido';
}

app.get('/api/historial/sesiones', adminUOps, async (req, res) => {
  try {
    const sesiones = await Promise.resolve(memory.listSessions());
    const todosLeads = await leads.list({ limit: 5000 });
    const porSesion = {};
    todosLeads.forEach(l => { porSesion[l.session_id] = l; });

    const q = (req.query.q || '').trim().toLowerCase();

    let enriquecidas = sesiones.map(s => {
      const lead = porSesion[s.id] || {};
      return {
        sessionId: s.id,
        agente:    detectarAgente(s.id),
        msgs:      s.msgs,
        updatedAt: s.updatedAt,
        nombre:    lead.nombre    || s.meta?.nombre    || null,
        empresa:   lead.empresa   || s.meta?.empresa   || null,
        telefono:  lead.telefono  || null,
        resumen:   lead.resumen   || null,
      };
    });

    // Conversaciones de WhatsApp vía 2Chat (grupo + 1:1) — viven en su propio
    // store (no en `memory`), se fusionan aquí para que aparezcan en el mismo
    // historial en vez de necesitar una pantalla aparte.
    const nombresGrupos = await obtenerNombresGruposWA().catch(() => ({}));
    const conversacionesWA = grupoWA.listarConversaciones().map(c => {
      if (c.agente !== 'grupo') return c;
      const canalUuid = c.sessionId.replace(/^2chat:/, '');
      return { ...c, nombre: nombresGrupos[canalUuid] || c.nombre };
    });
    enriquecidas = enriquecidas.concat(conversacionesWA);

    if (q) {
      enriquecidas = enriquecidas.filter(s =>
        s.sessionId.toLowerCase().includes(q) ||
        (s.nombre   && s.nombre.toLowerCase().includes(q)) ||
        (s.empresa  && s.empresa.toLowerCase().includes(q)) ||
        (s.telefono && String(s.telefono).toLowerCase().includes(q)) ||
        (s.resumen  && s.resumen.toLowerCase().includes(q))
      );
    }

    res.json(enriquecidas.sort((a, b) => b.updatedAt - a.updatedAt));
  } catch (e) {
    console.error('[historial/sesiones]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/historial/sesiones/:id', adminUOps, async (req, res) => {
  if (req.params.id.startsWith('2chat:')) {
    const { agente, historial } = grupoWA.historialDeConversacion(req.params.id);
    if (!historial.length) return res.status(404).json({ error: 'Conversación no encontrada o sin mensajes' });
    return res.json({ sessionId: req.params.id, agente, historial });
  }
  const historial = memory.getFullHistory(req.params.id);
  if (!historial.length) return res.status(404).json({ error: 'Sesión no encontrada o sin mensajes' });
  const ipInfo = await sessionIp.obtener(req.params.id).catch(() => null);
  res.json({
    sessionId: req.params.id,
    agente: detectarAgente(req.params.id),
    historial,
    ip: ipInfo?.ip || null,
    ipPrimerMensaje: ipInfo?.first_seen || ipInfo?.firstSeen || null,
  });
});

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
  // Aprendizaje de incidentes pasados solo para NOA — le da continuidad de
  // criterio entre alertas críticas, sin importar por qué canal entre.
  const aprendizajeBlock = agente === 'noa' ? incidentesNOA.bloqueAprendizaje() : '';
  return contextBlock
    ? `${base}${tariffBlock}${aprendizajeBlock}\n\n${contextBlock}`
    : `${base}${tariffBlock}${aprendizajeBlock}`;
}

// ─── CHAT (SSE streaming con memoria + tarifa dinámica) ───────────────────
async function handleChat(agente, req, res) {
  const { message, sessionId, callMode, visitorId } = req.body;
  if (!message) return res.status(400).json({ error: 'message requerido' });

  const sid = sessionId || `web_${agente}_${Date.now()}`;
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;

  // Se guarda SIEMPRE, desde el primer mensaje — independiente de si la sesión
  // llega a ser lead, orden o alerta de abuso (a diferencia de leads.add, que
  // solo captura ip cuando ya se extrajeron datos de contacto).
  sessionIp.registrar(sid, agente, ip).catch(() => {});

  // Mantenimiento forzado por orden de Diego — SARA, SOFIA y NOA no responden
  // a nadie hasta la fecha/hora indicada. HÉCTOR no está incluido en el corte.
  const MANTENIMIENTO_HASTA = new Date('2026-09-03T15:30:00Z'); // 3 sep 2026, 9:30 am hora MTY (UTC-6)
  if (['sara', 'sofia', 'noa'].includes(agente) && Date.now() < MANTENIMIENTO_HASTA.getTime()) {
    const MENSAJE_MANTENIMIENTO = 'En este momento no estoy disponible. Vuelvo a estar activa pronto — gracias por tu paciencia.';
    memory.addMessage(sid, 'user', message);
    memory.addMessage(sid, 'assistant', MENSAJE_MANTENIMIENTO);
    saveMessage(sid, agente, 'user', message);
    saveMessage(sid, agente, 'assistant', MENSAJE_MANTENIMIENTO);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'chunk', text: MENSAJE_MANTENIMIENTO })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    return res.end();
  }

  // Fuga de proceso/metodología/reglas internas — corte determinístico, no
  // depende de que el modelo "recuerde" bloquearlo. Por orden de Diego: nadie
  // más que él puede pedir esto. En el widget público (sin sesión de staff)
  // esto bloquea a absolutamente todos, sin excepción.
  if (['sara', 'sofia', 'noa'].includes(agente) && promptLeakGuard.detectar(message) && !req.user) {
    memory.addMessage(sid, 'user', message);
    memory.addMessage(sid, 'assistant', promptLeakGuard.MENSAJE_BLOQUEO);
    saveMessage(sid, agente, 'user', message);
    saveMessage(sid, agente, 'assistant', promptLeakGuard.MENSAJE_BLOQUEO);
    pushActividad({ agente, tipo: 'ALERTA_FUGA_PROMPT', mensaje: message.slice(0, 200), sessionId: sid, metadata: { sessionId: sid, ip } });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'chunk', text: promptLeakGuard.MENSAJE_BLOQUEO })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    return res.end();
  }

  // Moderación — corte determinístico ante insultos/amenazas, sin llamar a Claude
  if (moderacion.detectarAbuso(message)) {
    memory.addMessage(sid, 'user', message);
    memory.addMessage(sid, 'assistant', moderacion.MENSAJE_ABUSO);
    saveMessage(sid, agente, 'user', message);
    saveMessage(sid, agente, 'assistant', moderacion.MENSAJE_ABUSO);
    pushActividad({ agente, tipo: 'ALERTA_ABUSO', mensaje: message.slice(0, 200), sessionId: sid, ip });
    sendPush({
      title: '⚠️ Mensaje abusivo detectado',
      body: `${agente.toUpperCase()} · IP ${ip || 'desconocida'} · "${message.slice(0, 80)}"`,
      tag: 'alerta-abuso',
      url: '/',
      tipo: 'ALERTA_ABUSO',
      urgente: true,
    }).catch(() => {});

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'chunk', text: moderacion.MENSAJE_ABUSO })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    return res.end();
  }

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

  // Inyectar contexto TMS para SARA (clientes, rutas principales, tarifas históricas, directorio)
  if (agente === 'sara' && tms.ENABLED) {
    const tmsCtx = await tms.getContextoSARA(message);
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
  const filtroControl = crearFiltroControlStream(visible => {
    res.write(`data: ${JSON.stringify({ type: 'chunk', text: visible })}\n\n`);
  });
  try {
    await chatStream(
      systemPrompt,
      messages,
      (chunk) => {
        fullText += chunk; // texto crudo completo — se sigue usando para parsear LEAD_DATA/NUEVA_ORDEN internamente
        filtroControl(chunk); // solo lo "seguro" llega al cliente
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
      const lead = leads.add({ ...datosSara, sara_nota, primer_mensaje, sessionId: sid, ip });

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
        await ordersStore.guardarOrden(lead).catch(e => console.error('[ordersStore]', e.message));

        // Memoria compartida cross-agente — solo se guarda porque aquí SÍ hubo
        // cierre de venta real (NUEVA_ORDEN), nunca por un prospecto sin cerrar.
        contactos.upsertContacto({
          agente: 'sara', tipo: 'cliente',
          nombre_completo: lead.nombre, telefono: lead.telefono, email: lead.email,
          empresa: lead.empresa, tipo_carga: lead.tipo_carga,
          resumen_interaccion: lead.resumen || `Folio ${lead.folio} — ${lead.origen} → ${lead.destino}`,
          canal: 'chat',
        }).catch(e => console.error('[contactos]', e.message));

        // Lanzar llamadas + disponibilidad por WhatsApp a proveedores reales
        // del TMS (stub si VAPI_API_KEY no está) — ver buscarUnidadParaOrden.
        buscarUnidadParaOrden(lead);

        // Confirmación proactiva por WhatsApp — folio ya cerrado, aunque el
        // lead venga del chat web y no de WhatsApp. Fuera de la ventana de
        // 24h se manda vía plantilla aprobada (saraProactivo), no texto libre.
        saraProactivo.enviarConfirmacionVenta(lead.telefono, lead.nombre, lead.folio)
          .catch(e => console.error('[saraProactivo venta]', e.message));
        // Y SARA le marca por teléfono para confirmar en viva voz — sin que
        // nadie tenga que activarlo, dispara sola en cuanto cierra la venta.
        vapi.llamarConfirmacionVenta(lead).catch(e => console.error('[vapi confirmacion-venta]', e.message));
      } else if (datosSara.precio_cotizado && lead.telefono && lead.telefono !== '—') {
        // SARA acaba de cotizar un precio en esta respuesta — se lo manda también
        // por WhatsApp como respaldo, por si el lead sale del chat web.
        const ruta = (lead.origen && lead.origen !== '—' && lead.destino && lead.destino !== '—')
          ? `${lead.origen} → ${lead.destino}` : null;
        saraProactivo.enviarCotizacion(lead.telefono, lead.nombre, ruta, datosSara.precio_cotizado)
          .catch(e => console.error('[saraProactivo cotizacion]', e.message));
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
      } else {
        const faltantes = ['nombre','email','telefono','empresa','tipo_carga','tipo_unidad']
          .filter(k => !filled(lead[k])).join(', ');
        console.log(`[lead] ${sid} — en proceso, faltan: ${faltantes}`);
      }
    } else if (agente === 'sofia' || agente === 'noa') {
      // Marcador UPSERT_CONTACTO — respaldo para cuando SOFIA/NOA cierran un
      // acuerdo (proveedor) o confirman un operador/coordinación por chat,
      // fuera de los hooks determinísticos de folios/llamadas de Vapi.
      const contactoMatch = fullText.match(/UPSERT_CONTACTO:\s*(\{[^\n]+\})/);
      if (contactoMatch) {
        try {
          const datos = JSON.parse(contactoMatch[1]);
          contactos.upsertContacto({
            agente,
            tipo: datos.tipo || (agente === 'sofia' ? 'proveedor' : 'operador'),
            nombre_completo: datos.nombre_completo || datos.nombre,
            telefono: datos.telefono, email: datos.email, empresa: datos.empresa,
            tipo_carga: datos.tipo_carga,
            resumen_interaccion: datos.resumen_interaccion || datos.resumen,
            canal: 'chat',
          }).catch(e => console.error('[contactos]', e.message));
        } catch (e) {
          console.error('[UPSERT_CONTACTO] JSON inválido:', e.message);
        }
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
        if (m) {
          const datos = JSON.parse(m[1]);
          res.write(`data: ${JSON.stringify({ type: 'alerta_critica', datos })}\n\n`);
          // Mensaje directo por WhatsApp al equipo — automático, nadie tiene que ordenarlo.
          alertasStaff.alertarCriticoStaff({ ...datos, canal: 'chat' }).catch(e => console.error('[alertasStaff]', e.message));
        }
      } catch {}
    }

    // NOA — estatus de seguimiento armado con info extraída de la conversación
    if (agente === 'noa' && /ESTATUS_SEGUIMIENTO/i.test(fullText)) {
      try {
        const m = fullText.match(/ESTATUS_SEGUIMIENTO:\s*(\{[^\n]+\})/);
        if (m) {
          const datos = JSON.parse(m[1]);
          res.write(`data: ${JSON.stringify({ type: 'estatus_seguimiento', datos })}\n\n`);
          alertasStaff.enviarEstatusSeguimiento(datos).catch(e => console.error('[alertasStaff]', e.message));
        }
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

// ─── ASISTENTE INTERNO (equipo consulta a un agente, sin efectos secundarios) ──
// Para grupos de WhatsApp con clientes/transportistas donde la IA no puede
// participar directamente (limitación de la plataforma, no del código): el
// equipo consulta aquí y copia la respuesta al grupo. A diferencia de
// handleChat, esto NUNCA dispara leads.add, ordersStore.guardarOrden,
// llamadas de Vapi, emails ni contactos.upsertContacto — es solo consulta.
const AGENTES_INTERNOS = ['sara', 'sofia', 'noa'];
app.post('/api/interno/consultar', adminUOps, async (req, res) => {
  const { agente, pregunta, historial } = req.body || {};
  if (!AGENTES_INTERNOS.includes(agente)) return res.status(400).json({ error: 'agente inválido' });
  if (!pregunta || !pregunta.trim()) return res.status(400).json({ error: 'pregunta requerida' });
  try {
    const tariffCtx = tariff.getContext();
    let systemPrompt = buildPrompt(agente, '', tariffCtx);
    if (agente === 'sofia' && tms.ENABLED) {
      const tmsCtx = await tms.getContextoSOFIA(pregunta);
      if (tmsCtx) systemPrompt += tmsCtx;
    }
    if (agente === 'noa' && tms.ENABLED) {
      const tmsCtx = await tms.getContextoNOA(pregunta);
      if (tmsCtx) systemPrompt += tmsCtx;
    }
    if (agente === 'sara' && tms.ENABLED) {
      const tmsCtx = await tms.getContextoSARA(pregunta);
      if (tmsCtx) systemPrompt += tmsCtx;
    }
    systemPrompt += `

⚠️ MODO CONSULTA INTERNA: quien te escribe es un miembro del equipo de ABSTORAGES, no el cliente. No emitas LEAD_DATA, NUEVA_ORDEN, UPSERT_CONTACTO ni ALERTA_CRITICA — esta consulta no cierra nada, es solo para obtener información.

Hay dos tipos de pregunta y cada una se responde distinto:

1. Si te piden el ESTATUS/ubicación de una carga para informarle al cliente ("dame el estatus del folio X", "dónde va la unidad de X cliente") — tú, NOA, eres quien le da tranquilidad al cliente con esa información. Redacta la respuesta exactamente como si se la fueras a mandar al cliente directo: tono cálido y profesional, sin jerga interna, sin secciones de "PENDIENTE" ni "ACCIONES" dirigidas a un humano, sin decirle a nadie del equipo que escale o avise a alguien. Simplemente los datos que el cliente necesita saber: en qué kilómetro/carretera va la unidad, hacia dónde se dirige, la hora estimada de llegada (ETA), y si todo va en tiempo o hay algún retraso. El que te lee va a copiar tu respuesta y pegarla tal cual en el chat con el cliente — no la conviertas en una lista de pendientes internos.

2. Si te piden algo operativo interno (lista de folios activos, detalle completo de un folio para revisión del equipo, etc.) — ahí sí mantén tu formato normal con todo el detalle operativo que ya manejas.`;
    const msgs = Array.isArray(historial) ? historial.slice(-20) : [];
    let respuesta = '';
    await chatStream(systemPrompt, [...msgs, { role: 'user', content: pregunta.trim() }], (c) => { respuesta += c; }, () => {});
    res.json({ respuesta: limpiarControlParaCliente(respuesta) });
  } catch (e) {
    console.error('[interno/consultar]', e.message);
    res.status(500).json({ error: 'No se pudo consultar al agente' });
  }
});

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

// Runner automático cada 15 minutos — mismo interruptor que el resto
// (20-ago-2026): contacta a varios prospectos sin que nadie lo pida en el
// momento, justo lo que se quiere pausar. El endpoint manual
// (POST /api/prospector/run) sigue libre — ese sí es una acción humana
// explícita, no un barrido automático.
setInterval(() => {
  if (process.env.MENSAJES_MASIVOS !== 'true') {
    console.warn('[OutreachRunner] 🔇 Corrida automática suprimida — MENSAJES_MASIVOS no está en "true".');
    return;
  }
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
// ── Filtro de tokens de control (LEAD_DATA/NUEVA_ORDEN/CERRAR_CHAT/ESCALAR_HUMANO) ─
// Estos tokens son solo para que el backend los parsee — JAMÁS deben llegar al
// cliente final, ni en WhatsApp ni en el chat del portal/widget.
const CONTROL_MARKERS = ['LEAD_DATA:', 'NUEVA_ORDEN:', 'CERRAR_CHAT', 'ESCALAR_HUMANO', 'UPSERT_CONTACTO:', 'ALERTA_CRITICA:', 'ESTATUS_SEGUIMIENTO:'];
const CONTROL_MARKER_MAXLEN = Math.max(...CONTROL_MARKERS.map(m => m.length));

// Limpia texto YA COMPLETO (no streaming) — usado para WhatsApp.
function limpiarControlParaCliente(texto) {
  return texto
    .replace(/LEAD_DATA:\s*\{[^\n]*\}?/gi, '')
    .replace(/NUEVA_ORDEN\s*:\s*\{[\s\S]*?\}/gi, '')
    .replace(/UPSERT_CONTACTO:\s*\{[\s\S]*?\}/gi, '')
    .replace(/ALERTA_CRITICA:\s*\{[\s\S]*?\}/gi, '')
    .replace(/ESTATUS_SEGUIMIENTO:\s*\{[\s\S]*?\}/gi, '')
    .replace(/CERRAR_CHAT/gi, '')
    .replace(/ESCALAR_HUMANO/gi, '')
    .trim();
}

// Filtro para streaming chunk-a-chunk (SSE) — retiene una pequeña cola por si
// un marcador queda partido entre dos chunks, y corta todo lo que venga
// después en cuanto detecta el inicio de un token de control.
function crearFiltroControlStream(onVisible) {
  let buffer = '';
  let cortado = false;
  return function(chunk) {
    if (cortado) return;
    buffer += chunk;

    let idxCorte = -1;
    for (const marker of CONTROL_MARKERS) {
      const idx = buffer.indexOf(marker);
      if (idx !== -1 && (idxCorte === -1 || idx < idxCorte)) idxCorte = idx;
    }
    if (idxCorte !== -1) {
      const visible = buffer.slice(0, idxCorte);
      if (visible) onVisible(visible);
      cortado = true;
      buffer = '';
      return;
    }

    let colaSegura = buffer.length;
    for (let len = Math.min(CONTROL_MARKER_MAXLEN - 1, buffer.length); len > 0; len--) {
      const tail = buffer.slice(-len);
      if (CONTROL_MARKERS.some(m => m.startsWith(tail))) {
        colaSegura = buffer.length - len;
        break;
      }
    }
    if (colaSegura > 0) {
      onVisible(buffer.slice(0, colaSegura));
      buffer = buffer.slice(colaSegura);
    }
  };
}

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

// ─── SEGUIMIENTO PROACTIVO DE LEADS (SARA) ───────────────────────────────────
// Cada 30 min revisa leads que llevan >2h sin cerrar venta y sin seguimiento
// enviado — les manda WhatsApp + llamada de seguimiento, una sola vez por lead.
const SEGUIMIENTO_MIN_HORAS = 2;
const SEGUIMIENTO_MAX_HORAS = 7 * 24; // no perseguir leads de hace semanas
async function revisarLeadsSinRespuesta() {
  // Mismo interruptor que el resto — pedido explícito (20-ago-2026): ni
  // NOA, ni SARA, ni SOFIA mandan nada masivo/automático hasta reactivarlo.
  // Este barrido corre solo cada 30 min sobre TODOS los leads pendientes,
  // sin que nadie lo pida en el momento — justo lo que se quiere pausar.
  if (process.env.MENSAJES_MASIVOS !== 'true') {
    console.warn('[SARA seguimiento] 🔇 Barrido de seguimiento automático suprimido — MENSAJES_MASIVOS no está en "true".');
    return;
  }
  try {
    const rows = await leads.list({ limit: 500 });
    const ahora = Date.now();
    for (const lead of rows) {
      if (!lead.telefono || lead.telefono === '—') continue;
      if (lead.sara_nota === 'cierre_de_venta') continue;
      if (lead.seguimiento_enviado) continue;
      const horas = (ahora - new Date(lead.created_at).getTime()) / 3600000;
      if (horas < SEGUIMIENTO_MIN_HORAS || horas > SEGUIMIENTO_MAX_HORAS) continue;

      const resumenSolicitud = lead.resumen ||
        ((lead.origen && lead.origen !== '—' && lead.destino && lead.destino !== '—') ? `${lead.origen} → ${lead.destino}` : 'tu solicitud de flete');
      try {
        await saraProactivo.enviarSeguimientoLead(lead.telefono, lead.nombre !== '—' ? lead.nombre : null, resumenSolicitud);
        vapi.llamarLead(lead).catch(e => console.error(`[SARA seguimiento] Error llamando a lead ${lead.id}:`, e.message));
        leads.marcarSeguimientoEnviado(lead.id);
        console.log(`[SARA seguimiento] WhatsApp + llamada disparados a lead ${lead.id} (${lead.telefono})`);
      } catch (e) {
        console.error(`[SARA seguimiento] Error con lead ${lead.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[SARA seguimiento] Error revisando leads:', e.message);
  }
}

// ─── START ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ABSTORAGES AI Portal (modo lite)`);
  console.log(`  Portal:    http://localhost:${PORT}`);
  console.log(`  Simulator: http://localhost:${PORT}/simulator`);
  console.log(`  WhatsApp:  ${WA_LIVE ? '🟢 LIVE' : '🟡 stub'}`);
  console.log(`  TTS Voz:   ${EL_LIVE ? '🟢 LIVE' : '🟡 stub (agrega ELEVENLABS_API_KEY)'}`);
  console.log(`  Tarifas:   🟢 dinámicas\n`);
  noaScheduler.iniciar(pushActividad);
  tms.iniciarPrewarmNOA();
  setInterval(revisarLeadsSinRespuesta, 30 * 60 * 1000);
});
