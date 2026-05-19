// ─── GPS LIVE — Posiciones en tiempo real de unidades ─────────────────────────
// Recibe coordenadas de cualquier fuente: tracker hardware, celular del chofer,
// API de plataforma externa (Wialon, Tracksolid, Teltonika, etc.)

// Mapa: folioOrId → { lat, lng, velocidad, rumbo, ts, fuente, chofer, folio, estatus }
const posiciones = new Map();

// Listeners SSE activos (portal web esperando actualizaciones)
const listeners = new Set();

function actualizar(folio, datos) {
  const anterior = posiciones.get(folio) || {};
  const registro = {
    ...anterior,
    ...datos,
    folio,
    ts: Date.now(),
  };
  posiciones.set(folio, registro);

  // Notificar a todos los listeners SSE del portal
  const payload = `data: ${JSON.stringify({ type: 'gps_update', unidad: registro })}\n\n`;
  listeners.forEach(res => {
    try { res.write(payload); } catch (_) { listeners.delete(res); }
  });

  return registro;
}

function obtener(folio) {
  return posiciones.get(folio) || null;
}

function listar() {
  return [...posiciones.values()];
}

function agregarListener(res) {
  listeners.add(res);
}

function removerListener(res) {
  listeners.delete(res);
}

// Token simple para que trackers externos puedan hacer POST sin sesión de usuario
const GPS_TOKEN = process.env.GPS_TOKEN || 'abstorages-gps-2025';

module.exports = { actualizar, obtener, listar, agregarListener, removerListener, GPS_TOKEN };
