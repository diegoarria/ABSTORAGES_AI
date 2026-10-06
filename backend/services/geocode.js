// Reverse geocoding compartido por todos los proveedores de GPS — convierte
// lat/lng en una dirección legible (Nominatim/OpenStreetMap, gratuito).
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16`, {
      headers: { 'User-Agent': 'ABSTORAGES-ops/1.0 (contacto@abstorages.com)' },
    });
    const data = await r.json();
    return data.display_name || null;
  } catch {
    return null;
  }
}

// Forward geocoding — nombre de ciudad/estado → {lat, lng}. Usado por
// noaMonitoreo.js para el chequeo de desviación de ruta (línea recta
// origen→destino, ver ese archivo para las limitaciones de esto). Cache en
// memoria porque origen/destino se repiten mucho entre folios de las mismas
// rutas frecuentes — evita pegarle a Nominatim en cada tick.
const cacheForward = new Map();
async function forwardGeocode(query) {
  if (!query) return null;
  const key = String(query).trim().toLowerCase();
  if (cacheForward.has(key)) return cacheForward.get(key);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=mx`, {
      headers: { 'User-Agent': 'ABSTORAGES-ops/1.0 (contacto@abstorages.com)' },
    });
    const data = await r.json();
    const resultado = data?.[0] ? { lat: Number(data[0].lat), lng: Number(data[0].lon) } : null;
    cacheForward.set(key, resultado); // cachea también los null — evita re-preguntar por ciudades que Nominatim no reconoce
    return resultado;
  } catch {
    return null;
  }
}

module.exports = { reverseGeocode, forwardGeocode };
