require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const basicAuth = require('./middleware/auth');
const sessions = require('./services/sessions');
const saraRoutes = require('./routes/sara');
const sofiaRoutes = require('./routes/sofia');
const prospectorRoutes = require('./routes/prospector');
const lucaRoutes = require('./routes/luca');
const vapiWebhookRoutes = require('./routes/vapi-webhook');
const waWebhookRoutes  = require('./routes/whatsapp-webhook');
const { suscribirNuevaOrden, suscribirActividad, publicarActividad } = require('./services/redis');
const { registrarActividad, obtenerActividadReciente, obtenerMetricas } = require('./db/db');
const tariff = require('./services/tariff');

const USERS = require('./data/users.json');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── AUTH ROUTES (public — before basicAuth) ──────────────────────────────────
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = USERS.find(u => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });

  const sessionId = sessions.create({ id: user.id, nombre: user.nombre, email: user.email, role: user.role });
  res.cookie('abs_session', sessionId, { httpOnly: true, sameSite: 'lax', maxAge: 86400000 });
  res.json({ ok: true, nombre: user.nombre, role: user.role });
});

app.post('/api/logout', (req, res) => {
  const match = req.headers.cookie?.match(/abs_session=([^;]+)/);
  if (match) sessions.destroy(match[1]);
  res.clearCookie('abs_session');
  res.json({ ok: true });
});

// ─── FRONTEND ─────────────────────────────────────────────────────────────────
app.use(basicAuth);
app.use(express.static(path.join(__dirname, '../frontend')));

// Rutas explícitas para las páginas HTML
app.get('/simulator', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/simulator.html'));
});

// ─── SSE — ACTIVIDAD LOG ──────────────────────────────────────────────────────
const sseClients = new Set();

app.get('/api/actividad/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sseClients.add(sendEvent);
  req.on('close', () => sseClients.delete(sendEvent));

  // Enviar actividad reciente al conectar
  obtenerActividadReciente(20).then((actividades) => {
    sendEvent({ type: 'historial', actividades });
  }).catch(() => {});
});

function broadcastActividad(evento) {
  sseClients.forEach((client) => {
    try {
      client({ type: 'actividad', ...evento });
    } catch (e) {
      sseClients.delete(client);
    }
  });
}

// ─── RUTAS API ────────────────────────────────────────────────────────────────
app.use('/api/sara', saraRoutes);
app.use('/api/sofia', sofiaRoutes);
app.use('/api/prospector', prospectorRoutes);
app.use('/api/luca', lucaRoutes);
app.use('/api/vapi', vapiWebhookRoutes);
app.use('/api/whatsapp', waWebhookRoutes);

// GET /api/me — usuario autenticado actual
app.get('/api/me', (req, res) => {
  res.json(req.user);
});

// GET /api/tarifa/contexto — tarifario dinámico en tiempo real
app.get('/api/tarifa/contexto', (req, res) => {
  const tipoUnidad = req.query.unidad || 'caja seca 53';
  res.json(tariff.getContext(tipoUnidad));
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    agentes: ['SARA', 'SOFIA'],
    version: '1.0.0',
  });
});

// GET /api/metricas
app.get('/api/metricas', async (req, res) => {
  try {
    const metricas = await obtenerMetricas();
    res.json(metricas);
  } catch (err) {
    console.error('[Server] Error obteniendo métricas:', err);
    res.status(500).json({ error: 'Error al obtener métricas' });
  }
});

// ─── REDIS — SUSCRIPCIONES ────────────────────────────────────────────────────
try {
  // SOFIA escucha nueva_orden de SARA
  suscribirNuevaOrden(async (orden) => {
    console.log(`[Redis → SOFIA] Nueva orden recibida: ${orden.folio}`);
    await registrarActividad('SOFIA', 'INFO', orden.folio, `Nueva orden recibida de SARA: ${orden.folio}`);
    broadcastActividad({
      agente: 'SOFIA',
      tipo: 'NUEVA_ORDEN',
      folio: orden.folio,
      mensaje: `SOFIA recibió nueva orden: ${orden.folio} — ${orden.ruta?.origen || ''} → ${orden.ruta?.destino || ''}`,
      timestamp: new Date().toISOString(),
    });
  });

  // Broadcast de actividad a todos los clientes SSE
  suscribirActividad((evento) => {
    broadcastActividad(evento);
  });

  console.log('[Redis] Suscripciones configuradas');
} catch (err) {
  console.warn('[Redis] No disponible, continuando sin Redis:', err.message);
}

// ─── INICIAR SERVIDOR ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║        ABSTORAGES AI Portal — v1.0.0            ║
║  SARA (Sales AI) + SOFIA (Operations Planner)   ║
╠══════════════════════════════════════════════════╣
║  Portal:    http://localhost:${PORT}               ║
║  API:       http://localhost:${PORT}/api           ║
║  Health:    http://localhost:${PORT}/api/health    ║
╚══════════════════════════════════════════════════╝
  `);
});

module.exports = app;
