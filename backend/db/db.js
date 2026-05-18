require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('[DB] Error inesperado en cliente inactivo:', err);
});

const query = (text, params) => pool.query(text, params);

const getClient = () => pool.connect();

// ─── FOLIOS ──────────────────────────────────────────────────────────────────

async function crearFolio(data) {
  const folio = await generarFolio();
  const { rows } = await query(
    `INSERT INTO folios (folio, cliente_id, origen, destino, cp_origen, cp_destino, tipo_unidad, mercancia, peso, fecha_carga, hora_cita, precio_cliente, condiciones_especiales)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [folio, data.cliente_id, data.origen, data.destino, data.cp_origen, data.cp_destino,
     data.tipo_unidad, data.mercancia, data.peso, data.fecha_carga, data.hora_cita,
     data.precio_cliente, data.condiciones_especiales]
  );
  return rows[0];
}

async function generarFolio() {
  const { rows } = await query('SELECT COUNT(*) FROM folios');
  const num = String(parseInt(rows[0].count) + 1).padStart(6, '0');
  return `ABST-${num}`;
}

async function actualizarEstatusFolio(folioId, nuevoEstatus) {
  const { rows } = await query(
    `UPDATE folios SET estatus = $1, estatus_anterior = estatus WHERE id = $2 RETURNING *`,
    [nuevoEstatus, folioId]
  );
  return rows[0];
}

async function obtenerFoliosPorEstatus(estatus) {
  const { rows } = await query(
    `SELECT f.*, c.nombre_comercial as cliente_nombre, p.razon_social as proveedor_nombre
     FROM folios f
     LEFT JOIN clientes c ON f.cliente_id = c.id
     LEFT JOIN proveedores p ON f.proveedor_id = p.id
     WHERE f.estatus = $1
     ORDER BY f.created_at DESC`,
    [estatus]
  );
  return rows;
}

async function obtenerFolioActivo() {
  const { rows } = await query(
    `SELECT f.*, c.nombre_comercial as cliente_nombre, p.razon_social as proveedor_nombre
     FROM folios f
     LEFT JOIN clientes c ON f.cliente_id = c.id
     LEFT JOIN proveedores p ON f.proveedor_id = p.id
     WHERE f.estatus NOT IN ('CONCLUIDO')
     ORDER BY f.created_at DESC`
  );
  return rows;
}

// ─── PROVEEDORES ─────────────────────────────────────────────────────────────

async function obtenerProveedoresPorRuta(origen, destino) {
  const { rows } = await query(
    `SELECT * FROM proveedores
     WHERE $1 = ANY(rutas_operadas) OR $2 = ANY(rutas_operadas)
     AND estatus = 'ACTIVO'
     ORDER BY clasificacion ASC, viajes_completados DESC`,
    [origen, destino]
  );
  return rows;
}

async function obtenerProveedoresRecurrentes() {
  const { rows } = await query(
    `SELECT * FROM proveedores WHERE clasificacion = 'RECURRENTE' AND estatus = 'ACTIVO'`
  );
  return rows;
}

async function actualizarClasificacionProveedor(proveedorId) {
  const { rows } = await query('SELECT viajes_completados FROM proveedores WHERE id = $1', [proveedorId]);
  if (!rows[0]) return;
  const viajes = rows[0].viajes_completados;
  let clasificacion = 'POTENCIAL';
  if (viajes >= 3) clasificacion = 'RECURRENTE';
  else if (viajes >= 1) clasificacion = 'INTERMITENTE';
  await query('UPDATE proveedores SET clasificacion = $1 WHERE id = $2', [clasificacion, proveedorId]);
}

// ─── TARIFARIO ───────────────────────────────────────────────────────────────

async function consultarTarifa(origen, destino, tipoUnidad) {
  const { rows } = await query(
    `SELECT * FROM tarifario
     WHERE LOWER(origen) LIKE LOWER($1) AND LOWER(destino) LIKE LOWER($2)
     AND tipo_unidad = $3 AND vigente = TRUE
     ORDER BY created_at DESC LIMIT 1`,
    [`%${origen}%`, `%${destino}%`, tipoUnidad]
  );
  return rows[0] || null;
}

// ─── ACTIVIDAD LOG ────────────────────────────────────────────────────────────

async function registrarActividad(agente, tipo, folio, mensaje, metadata = {}) {
  const { rows } = await query(
    `INSERT INTO actividad_log (agente, tipo, folio, mensaje, metadata)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [agente, tipo, folio, mensaje, JSON.stringify(metadata)]
  );
  return rows[0];
}

async function obtenerActividadReciente(limite = 50) {
  const { rows } = await query(
    `SELECT * FROM actividad_log ORDER BY created_at DESC LIMIT $1`,
    [limite]
  );
  return rows;
}

// ─── CONVERSACIONES ──────────────────────────────────────────────────────────

async function guardarMensaje(agente, sessionId, role, content, metadata = {}) {
  await query(
    `INSERT INTO conversaciones (agente, session_id, role, content, metadata)
     VALUES ($1,$2,$3,$4,$5)`,
    [agente, sessionId, role, content, JSON.stringify(metadata)]
  );
}

async function obtenerHistorialConversacion(agente, sessionId, limite = 20) {
  const { rows } = await query(
    `SELECT role, content FROM conversaciones
     WHERE agente = $1 AND session_id = $2
     ORDER BY created_at ASC LIMIT $3`,
    [agente, sessionId, limite]
  );
  return rows;
}

// ─── ALERTAS ─────────────────────────────────────────────────────────────────

async function crearAlerta(folioId, tipo, descripcion, nivel = 'ALTA') {
  const { rows } = await query(
    `INSERT INTO alertas (folio_id, tipo, descripcion, nivel)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [folioId, tipo, descripcion, nivel]
  );
  return rows[0];
}

// ─── METRICAS ─────────────────────────────────────────────────────────────────

async function obtenerMetricas() {
  const [foliosActivos, foliosHoy, proveedoresActivos, alertasActivas] = await Promise.all([
    query(`SELECT COUNT(*) FROM folios WHERE estatus NOT IN ('CONCLUIDO')`),
    query(`SELECT COUNT(*) FROM folios WHERE DATE(created_at) = CURRENT_DATE`),
    query(`SELECT COUNT(*) FROM proveedores WHERE estatus = 'ACTIVO'`),
    query(`SELECT COUNT(*) FROM alertas WHERE resuelta = FALSE`),
  ]);
  return {
    folios_activos: parseInt(foliosActivos.rows[0].count),
    folios_hoy: parseInt(foliosHoy.rows[0].count),
    proveedores_activos: parseInt(proveedoresActivos.rows[0].count),
    alertas_activas: parseInt(alertasActivas.rows[0].count),
  };
}

module.exports = {
  query,
  getClient,
  crearFolio,
  generarFolio,
  actualizarEstatusFolio,
  obtenerFoliosPorEstatus,
  obtenerFolioActivo,
  obtenerProveedoresPorRuta,
  obtenerProveedoresRecurrentes,
  actualizarClasificacionProveedor,
  consultarTarifa,
  registrarActividad,
  obtenerActividadReciente,
  guardarMensaje,
  obtenerHistorialConversacion,
  crearAlerta,
  obtenerMetricas,
};
