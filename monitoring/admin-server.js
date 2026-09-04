// ── Panel de administración técnico — servidor propio, proceso propio ────────
// No se monta dentro de server-lite.js ni comparte auth/sesión con el panel
// de negocio. Uso: node monitoring/admin-server.js (o `npm run monitoring:panel`)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const { pool } = require('./lib/adminDb');
const auth = require('./lib/adminAuth');

const app = express();
const PORT = process.env.MONITORING_ADMIN_PORT || 4001;

app.set('trust proxy', 1);
app.use(express.json());

// CORS manual (sin depender del paquete `cors` del repo raíz, para que
// monitoring/ pueda vivir como servicio 100% independiente) — solo necesario
// si despliegas el panel en un dominio distinto al de admin-server.js (ej.
// frontend en Vercel + API aquí en Railway). Si sirves el dist/ desde este
// mismo servidor (opción recomendada en el README), ALLOWED_ORIGIN no hace
// falta y esto no hace nada.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
if (ALLOWED_ORIGIN) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// ── Login ──────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  if (!auth.verificarLogin(username, password)) return res.status(401).json({ error: 'Credenciales inválidas' });

  const sid = auth.crearSesion(username);
  res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`);
  res.json({ ok: true, username });
});

app.post('/api/logout', (req, res) => {
  const sid = auth.parseCookie(req.headers.cookie, auth.SESSION_COOKIE);
  if (sid) auth.destruirSesion(sid);
  res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE}=; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', auth.requiereSesion, (req, res) => res.json({ username: req.monitoringUser }));

// Todo lo demás bajo /api requiere sesión — el rol de Postgres (monitoring_admin)
// ya limita qué puede leer/escribir, esto es la capa de "quién puede entrar
// al panel en absoluto".
app.use('/api', auth.requiereSesion);

// ── Dashboard — estado actual por servicio + latencia promedio 24h ──────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const { rows: ultimos } = await pool.query(`
      SELECT DISTINCT ON (service_name) service_name, status, checked_at, latency_ms, status_code
      FROM service_checks
      ORDER BY service_name, checked_at DESC
    `);
    const { rows: promedios } = await pool.query(`
      SELECT service_name, ROUND(AVG(latency_ms)) AS avg_latency_ms
      FROM service_checks
      WHERE checked_at > NOW() - INTERVAL '24 hours'
      GROUP BY service_name
    `);
    const promediosPorServicio = Object.fromEntries(promedios.map(p => [p.service_name, Number(p.avg_latency_ms)]));
    res.json(ultimos.map(u => ({ ...u, avg_latency_ms_24h: promediosPorServicio[u.service_name] ?? null })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Eventos de seguridad — filtrable por severidad y tipo ────────────────────
app.get('/api/security-events', async (req, res) => {
  try {
    const { severity, type, limit = 100 } = req.query;
    const cond = [], vals = [];
    if (severity) { vals.push(severity); cond.push(`severity = $${vals.length}`); }
    if (type)     { vals.push(type);     cond.push(`event_type = $${vals.length}`); }
    vals.push(Math.min(Number(limit) || 100, 500));
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM security_events ${where} ORDER BY detected_at DESC LIMIT $${vals.length}`, vals
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Incidentes — lista + marcar como resuelto ─────────────────────────────────
app.get('/api/incidents', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM incidents ORDER BY created_at DESC LIMIT 200`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/incidents/:id/resolve', async (req, res) => {
  try {
    // monitoring_admin solo tiene GRANT UPDATE en (resolved, resolved_at) —
    // si esta query intentara tocar otra columna, Postgres la rechazaría.
    const { rows } = await pool.query(
      `UPDATE incidents SET resolved = true, resolved_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Incidente no encontrado' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Historial de alertas ──────────────────────────────────────────────────────
app.get('/api/alerts', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT alert_log.*, incidents.summary_text, incidents.severity
      FROM alert_log
      JOIN incidents ON incidents.id = alert_log.incident_id
      ORDER BY alert_log.sent_at DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sirve el build de React (npm run build en admin-panel/) ─────────────────
const DIST = path.join(__dirname, 'admin-panel/dist');
app.use(express.static(DIST));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'No encontrado' });
  res.sendFile(path.join(DIST, 'index.html'), (err) => {
    if (err) res.status(500).send('Build del panel no encontrado — corre "npm run build" en monitoring/admin-panel/');
  });
});

app.listen(PORT, () => console.log(`[monitoring/admin-server] Escuchando en :${PORT}`));
