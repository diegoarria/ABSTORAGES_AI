// ── Holkan — lectura de ubicación en vivo desde links "share" sin login ────────
// El link (acceso.holkan.com.mx/share?HASH) expone un endpoint AJAX interno
// que no requiere sesión: basta el mismo hash de la URL.
const { reverseGeocode } = require('./geocode');

const AJAX_URL = 'https://acceso.holkan.com.mx/share/index.php?ajax&module=Route&action=update';

function esUrl(url) {
  return typeof url === 'string' && /holkan\.com\.mx/i.test(url);
}

// El hash va como query string completo, sin "clave=", ej: ?ad81eb7e1946...
function extraerHash(url) {
  try {
    const q = new URL(url).search.replace(/^\?/, '');
    return q || null;
  } catch {
    return null;
  }
}

const cache = new Map();
const TTL_MS = 2 * 60 * 1000;

async function obtenerUbicacion(url, { conDireccion = true } = {}) {
  if (!esUrl(url)) return null;
  const hash = extraerHash(url);
  if (!hash) return null;

  const cached = cache.get(hash);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    if (cached.data.direccion || !conDireccion) return cached.data;
  }

  try {
    const body = new URLSearchParams({ hash, last_update: '{}' });
    const r = await fetch(AJAX_URL, { method: 'POST', body });
    const data = await r.json();
    const car = (data.cars || [])[0];
    if (!car) return null;
    const [carId, etiqueta] = car;
    const info = data[carId];
    if (!info || !info.cur_pos) return null;

    const [lat, lng] = info.cur_pos;
    const speedTexto = (info.status || [])[2] || ''; // ej. "59 Km/h"
    const speedKmh = speedTexto ? parseInt(speedTexto, 10) : null;
    const direccion = conDireccion ? await reverseGeocode(lat, lng) : null;

    const resultado = {
      nombre: (etiqueta || '').split('/')[0] || null,
      lat, lng, speedKmh, rumbo: null,
      timestamp: info.last_update ? new Date(info.last_update * 1000).toISOString() : null,
      direccion,
    };
    cache.set(hash, { data: resultado, ts: Date.now() });
    return resultado;
  } catch (e) {
    console.error('[holkan]', e.message);
    return null;
  }
}

module.exports = { esUrl, obtenerUbicacion };
