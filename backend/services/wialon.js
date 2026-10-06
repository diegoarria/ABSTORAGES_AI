// ── Wialon — lectura de ubicación en vivo desde links "Locator" sin login ──────
// El link que Wialon genera para compartir sin usuario/contraseña
// (hosting.wialon.com/locator/...?t=TOKEN) usa ese mismo token como
// credencial de sesión restringida de su API pública (Remote API).
// No requiere API key propia — el token ya viene en la URL que guarda el TMS.
//
// ── Cuenta espejo (opcional) ─────────────────────────────────────────────
// Lo de arriba solo ve UNA unidad (la del link que compartió el proveedor
// para ese folio). Si el proveedor en cambio da un token de cuenta completa
// ("cuenta espejo" — acceso de solo lectura a toda su flota en Wialon), con
// WIALON_MIRROR_TOKEN configurado se puede listar/leer cualquier unidad de
// esa flota sin depender de que compartan un link por viaje. Apagado por
// default — sin el env var, el comportamiento de arriba no cambia en nada.
const { reverseGeocode } = require('./geocode');

const API_URL = 'https://hst-api.wialon.com/wialon/ajax.html';
const MIRROR_TOKEN = process.env.WIALON_MIRROR_TOKEN || null;

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

// ── Cuenta espejo: sesión de flota completa (cacheada, se re-loguea si expira) ─
let sesionFlota = null; // { sid, eid, ts }
const FLOTA_SID_TTL_MS = 10 * 60 * 1000;

async function sesionDeFlota() {
  if (!MIRROR_TOKEN) return null;
  if (sesionFlota && Date.now() - sesionFlota.ts < FLOTA_SID_TTL_MS) return sesionFlota;
  const data = await login(MIRROR_TOKEN);
  sesionFlota = { sid: data.eid, ts: Date.now() };
  return sesionFlota;
}

// Lista toda la flota visible con la cuenta espejo — {id, nombre}[]. Usado
// por gpsProviders para encontrar una unidad por placas/nombre cuando el
// folio no trae un link de GPS propio.
async function listarFlota() {
  if (!MIRROR_TOKEN) return [];
  try {
    const sesion = await sesionDeFlota();
    const params = encodeURIComponent(JSON.stringify({
      spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
      force: 1, flags: 1, from: 0, to: 0,
    }));
    const r = await fetch(`${API_URL}?svc=core/search_items&params=${params}&sid=${sesion.sid}`);
    const data = await r.json();
    if (data.error) throw new Error(`Wialon search_items error ${data.error}`);
    return (data.items || []).map(it => ({ id: it.id, nombre: it.nm }));
  } catch (e) {
    console.error('[wialon] Error listando flota de cuenta espejo:', e.message);
    return [];
  }
}

// Busca una unidad por nombre/placas (match parcial, insensible a mayúsculas)
// dentro de la cuenta espejo y devuelve su ubicación — mismo shape que
// obtenerUbicacion(url). null si no hay cuenta espejo o no se encuentra.
async function obtenerUbicacionPorNombre(nombreBuscado, { conDireccion = true } = {}) {
  if (!MIRROR_TOKEN || !nombreBuscado) return null;
  try {
    const sesion = await sesionDeFlota();
    const flota = await listarFlota();
    const q = String(nombreBuscado).toLowerCase().replace(/[^a-z0-9]/g, '');
    const unidad = flota.find(u => String(u.nombre || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(q));
    if (!unidad) return null;
    const item = await obtenerUnidad(sesion.sid, unidad.id);
    if (!item || !item.pos) return null;
    const { x: lng, y: lat, s: speedKmh, c: rumbo, t: ts } = item.pos;
    const direccion = conDireccion ? await reverseGeocode(lat, lng) : null;
    return { nombre: item.nm || null, lat, lng, speedKmh, rumbo, timestamp: ts ? new Date(ts * 1000).toISOString() : null, direccion };
  } catch (e) {
    console.error('[wialon] Error buscando unidad en cuenta espejo:', e.message);
    return null;
  }
}

module.exports = { esUrl, obtenerUbicacion, listarFlota, obtenerUbicacionPorNombre, MIRROR_ACTIVO: !!MIRROR_TOKEN };
