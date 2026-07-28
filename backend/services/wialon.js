// ── Wialon — lectura de ubicación en vivo desde links "Locator" sin login ──────
// El link que Wialon genera para compartir sin usuario/contraseña
// (hosting.wialon.com/locator/...?t=TOKEN) usa ese mismo token como
// credencial de sesión restringida de su API pública (Remote API).
// No requiere API key propia — el token ya viene en la URL que guarda el TMS.
const { reverseGeocode } = require('./geocode');

const API_URL = 'https://hst-api.wialon.com/wialon/ajax.html';

function esUrl(url) {
  return typeof url === 'string' && /wialon\.(com|us)\b/i.test(url);
}

function extraerToken(url) {
  try {
    return new URL(url).searchParams.get('t') || null;
  } catch {
    return null;
  }
}

async function login(token) {
  const params = encodeURIComponent(JSON.stringify({ token }));
  const r = await fetch(`${API_URL}?svc=token/login&params=${params}`);
  const data = await r.json();
  if (data.error) throw new Error(`Wialon token/login error ${data.error}`);
  return data;
}

async function obtenerUnidad(sid, id) {
  const params = encodeURIComponent(JSON.stringify({ id, flags: 1025 })); // 1 base + 1024 última posición
  const r = await fetch(`${API_URL}?svc=core/search_item&params=${params}&sid=${sid}`);
  const data = await r.json();
  if (data.error) throw new Error(`Wialon search_item error ${data.error}`);
  return data.item;
}

// Cache corta por token — evita re-loguear en Wialon si preguntan por el
// mismo folio varias veces seguidas (ej. cliente + equipo interno).
const cache = new Map();
const TTL_MS = 2 * 60 * 1000;

async function obtenerUbicacion(url, { conDireccion = true } = {}) {
  if (!esUrl(url)) return null;
  const token = extraerToken(url);
  if (!token) return null;

  const cached = cache.get(token);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    if (cached.data.direccion || !conDireccion) return cached.data;
  }

  try {
    const sesion = await login(token);
    const tokenInfo = JSON.parse(sesion.token || '{}');
    const unitId = (tokenInfo.items || [])[0];
    if (!unitId) return null;

    const unidad = await obtenerUnidad(sesion.eid, unitId);
    if (!unidad || !unidad.pos) return null;

    const { x: lng, y: lat, s: speedKmh, c: rumbo, t: ts } = unidad.pos;
    const direccion = conDireccion ? await reverseGeocode(lat, lng) : null;

    const data = {
      nombre: unidad.nm || null,
      lat, lng, speedKmh, rumbo,
      timestamp: ts ? new Date(ts * 1000).toISOString() : null,
      direccion,
    };
    cache.set(token, { data, ts: Date.now() });
    return data;
  } catch (e) {
    console.error('[wialon]', e.message);
    return null;
  }
}

module.exports = { esUrl, obtenerUbicacion };
