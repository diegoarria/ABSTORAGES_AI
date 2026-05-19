// ─── CARRIERS — Pool de transportistas registrados por LUCA ──────────────────

const pool = new Map();

function add(data) {
  const id = `CARR-${(data.nombre || 'OP').replace(/\s/g,'').slice(0,4).toUpperCase()}${new Date().getFullYear()}`;
  const carrier = { id, registered_at: new Date().toISOString(), activo: true, ...data };
  pool.set(id, carrier);
  return carrier;
}

function list() {
  return [...pool.values()].sort((a, b) => new Date(b.registered_at) - new Date(a.registered_at));
}

function findByRuta(origen, destino) {
  const q = [origen, destino].map(s => s?.toLowerCase());
  return list().filter(c =>
    c.activo &&
    c.disponibilidad !== 'no_disponible' &&
    (c.rutas || []).some(r => q.some(term => r.toLowerCase().includes(term)))
  );
}

// Extrae datos de carrier del JSON que LUCA genera en el chat
function extractFromText(text) {
  const match = text.match(/REGISTRO_CARRIER_COMPLETO:\s*(\{[\s\S]*?\})/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    return add(data);
  } catch (_) { return null; }
}

module.exports = { add, list, findByRuta, extractFromText };
