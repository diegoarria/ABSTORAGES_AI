// ── Panel de administración técnico — servidor propio, proceso propio ────────
// No se monta dentro de server-lite.js ni comparte auth/sesión con el panel
// de negocio. Uso: node monitoring/admin-server.js (o `npm run monitoring:panel`)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const { pool } = require('./lib/adminDb');
const { pool: poolEscritura } = require('./lib/db'); // rol monitoring_service — sí puede INSERT
const auth = require('./lib/adminAuth');

const app = express();
const PORT = process.env.MONITORING_ADMIN_PORT || 4001;

app.set('trust proxy', 1);
app.use(express.json());

// Bootstrap del primer usuario del panel — monitoring/data/admin-users.json
// vive en el disco efímero del contenedor (nunca se commitea, está en
// .gitignore), así que en un despliegue nuevo no hay forma de correr
// `createAdminUser.js` a mano sin acceso SSH. Si no hay ningún usuario
// todavía y vienen estas 2 variables, se crea una sola vez al arrancar —
// no pisa un usuario que ya exista con ese mismo nombre.
if (process.env.MONITORING_BOOTSTRAP_USER && process.env.MONITORING_BOOTSTRAP_PASS) {
  try {
    if (!auth.verificarLogin(process.env.MONITORING_BOOTSTRAP_USER, process.env.MONITORING_BOOTSTRAP_PASS)) {
      auth.upsertUser(process.env.MONITORING_BOOTSTRAP_USER, process.env.MONITORING_BOOTSTRAP_PASS);
      console.log(`[monitoring/admin-server] Usuario bootstrap "${process.env.MONITORING_BOOTSTRAP_USER}" creado/actualizado.`);
    }
  } catch (e) {
    console.error('[monitoring/admin-server] Error en bootstrap de usuario:', e.message);
  }
}

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

// ── Intake de eventos reportados por el backend de negocio ──────────────────
// El negocio (server-lite.js) NUNCA tiene credenciales de esta base — le
// avisa a monitoring por HTTP, con un secreto compartido, y monitoring hace
// el INSERT usando sus propias credenciales (monitoring_service). Así se
// mantiene el aislamiento real: negocio no toca la base de monitoring, y
// monitoring no toca la de negocio — solo se pasan un mensaje.
app.post('/internal/report-event', express.json(), async (req, res) => {
  const secreto = req.headers['x-intake-secret'];
  if (!process.env.MONITORING_INTAKE_SECRET || secreto !== process.env.MONITORING_INTAKE_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const { event_type, severity, source_ip, details } = req.body || {};
  if (!event_type || !severity) return res.status(400).json({ error: 'event_type y severity requeridos' });

  try {
    await poolEscritura.query(
      `INSERT INTO security_events (event_type, severity, source_ip, details) VALUES ($1, $2, $3, $4)`,
      [event_type, severity, source_ip || null, JSON.stringify(details || {})]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin-server] Error insertando evento reportado:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Registro de cada contacto proactivo real que sale (llamada o plantilla) ──
// Reportado por el negocio justo después de un envío real (nunca de uno
// omitido por pausa/límite) — permite que monitoring detecte solo un
// volumen fuera de lo normal, sin que nadie tenga que preguntar primero.
app.post('/internal/outbound-contact', express.json(), async (req, res) => {
  const secreto = req.headers['x-intake-secret'];
  if (!process.env.MONITORING_INTAKE_SECRET || secreto !== process.env.MONITORING_INTAKE_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const { agente, canal, destinatario, detalle } = req.body || {};
  if (!agente || !canal) return res.status(400).json({ error: 'agente y canal requeridos' });
  try {
    await poolEscritura.query(
      `INSERT INTO outbound_contact_log (agente, canal, destinatario, detalle) VALUES ($1, $2, $3, $4)`,
      [agente, canal, destinatario || null, JSON.stringify(detalle || {})]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin-server] Error insertando outbound-contact:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Agent control — fuente de verdad de qué IA está pausada ──────────────────
// GET/POST bajo /internal usan el secreto compartido (el negocio nunca tiene
// credenciales de esta base). GET/POST bajo /api usan sesión del panel — un
// humano pausando/reanudando desde aquí directamente.
async function leerAgentControl() {
  const { rows } = await poolEscritura.query(`SELECT agente, paused, motivo, changed_by, changed_at FROM agent_control`);
  return Object.fromEntries(rows.map(r => [r.agente, { paused: r.paused, motivo: r.motivo, changed_by: r.changed_by, changed_at: r.changed_at }]));
}
async function escribirAgentControl(agente, paused, motivo, changedBy) {
  await poolEscritura.query(
    `INSERT INTO agent_control (agente, paused, motivo, changed_by, changed_at) VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (agente) DO UPDATE SET paused = $2, motivo = $3, changed_by = $4, changed_at = NOW()`,
    [agente, paused, motivo || null, changedBy || null]
  );
}

app.get('/internal/agent-control', async (req, res) => {
  const secreto = req.headers['x-intake-secret'];
  if (!process.env.MONITORING_INTAKE_SECRET || secreto !== process.env.MONITORING_INTAKE_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try { res.json(await leerAgentControl()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/internal/agent-control/:agente', express.json(), async (req, res) => {
  const secreto = req.headers['x-intake-secret'];
  if (!process.env.MONITORING_INTAKE_SECRET || secreto !== process.env.MONITORING_INTAKE_SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const agente = req.params.agente;
  if (!['sara', 'sofia', 'noa'].includes(agente)) return res.status(400).json({ error: 'agente inválido' });
  const { paused, motivo, changedBy } = req.body || {};
  try {
    await escribirAgentControl(agente, !!paused, motivo, changedBy || 'negocio');
    res.json(await leerAgentControl());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Todo lo demás bajo /api requiere sesión — el rol de Postgres (monitoring_admin)
// ya limita qué puede leer/escribir, esto es la capa de "quién puede entrar
// al panel en absoluto".
app.use('/api', auth.requiereSesion);

app.get('/api/agent-control', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT agente, paused, motivo, changed_by, changed_at FROM agent_control ORDER BY agente`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent-control/:agente', async (req, res) => {
  const agente = req.params.agente;
  if (!['sara', 'sofia', 'noa'].includes(agente)) return res.status(400).json({ error: 'agente inválido' });
  const { paused, motivo } = req.body || {};
  try {
    await escribirAgentControl(agente, !!paused, motivo, req.monitoringUser);
    const { rows } = await pool.query(`SELECT agente, paused, motivo, changed_by, changed_at FROM agent_control ORDER BY agente`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
