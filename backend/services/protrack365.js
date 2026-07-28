// ── Protrack365 — lectura de ubicación en vivo desde links "share" sin login ───
// El link de protrack365.com trae un token que en realidad se resuelve contra
// su backend real (real.gpscenter.xyz) — requiere un header Referer para no
// ser rechazado, pero no requiere usuario/contraseña.
const { reverseGeocode } = require('./geocode');

const API_URL = 'https://real.gpscenter.xyz/Share';

// Solo soporta el formato share.jsp?...token=... — la interfaz nueva V2
// (protrack365.com/V2/index.jsp#/...) no trae token en la URL y requiere login.
function esUrl(url) {
  return typeof url === 'string' && /protrack365\.com/i.test(url) && /token=/.test(url);
}

function extraerToken(url) {
  try {
    return new URL(url).searchParams.get('token') || null;
  } catch {
    return null;
  }
}

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
    const r = await fetch(`${API_URL}?method=initialize&token=${encodeURIComponent(token)}&t=${Date.now()}`, {
      headers: { Referer: 'https://real.gpscenter.xyz/' },
    });
    const data = await r.json();
    const rec = data.record;
    if (!rec || rec.lat == null || rec.lng == null) return null;

    const direccion = conDireccion ? await reverseGeocode(rec.lat, rec.lng) : null;
    const resultado = {
      nombre: rec.device_name || null,
      lat: rec.lat, lng: rec.lng, speedKmh: rec.speed ?? null, rumbo: rec.course ?? null,
      timestamp: rec.gpstime ? new Date(rec.gpstime).toISOString() : null,
      direccion,
    };
    cache.set(token, { data: resultado, ts: Date.now() });
    return resultado;
  } catch (e) {
    console.error('[protrack365]', e.message);
    return null;
  }
}

module.exports = { esUrl, obtenerUbicacion };
