const https = require('https');

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Route cache — keyed by "origen|destino", TTL 24h
const routeCache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function mapsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { reject(e); } });
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function getRouteSecs(origen, destino) {
  const cacheKey = `${origen}|${destino}`;
  const hit = routeCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit;

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json` +
    `?origins=${encodeURIComponent(origen)}` +
    `&destinations=${encodeURIComponent(destino)}` +
    `&mode=driving&departure_time=now` +
    `&key=${MAPS_KEY}`;

  const data = await mapsGet(url);
  const el = data?.rows?.[0]?.elements?.[0];
  if (!el || el.status !== 'OK') throw new Error(`Maps status: ${el?.status}`);

  const duracion_seg = el.duration_in_traffic?.value ?? el.duration?.value;
  const distancia_km = Math.round(el.distance.value / 1000);
  const result = { duracion_seg, distancia_km, ts: Date.now() };
  routeCache.set(cacheKey, result);
  return result;
}

/**
 * Calculates ETA for a folio.
 * Returns:
 *   { llegado: true }                                        — already at destination
 *   { eta: Date, duracion_min, distancia_km, source, salida } — estimated arrival
 *   { eta: Date, source: 'cita' }                           — fallback to appointment
 *   null                                                     — not enough data
 */
async function calcularETA({ ciudad_origen, estado_origen, ciudad_destino, estado_destino,
                              hora_salida_carga, cita_descarga, estatus }) {
  const det = (estatus || '').toLowerCase();

  if (det.includes('destino') || det.includes('descarga') || det.includes('concluido')) {
    return { llegado: true };
  }

  // Google Maps path — requires departure time + both cities + API key
  if (MAPS_KEY && hora_salida_carga && ciudad_origen && ciudad_destino) {
    try {
      const origen  = `${ciudad_origen}, ${estado_origen || ''}, México`;
      const destino = `${ciudad_destino}, ${estado_destino || ''}, México`;
      const ruta    = await getRouteSecs(origen, destino);
      const salida  = new Date(hora_salida_carga);
      const eta     = new Date(salida.getTime() + ruta.duracion_seg * 1000);
      return {
        eta,
        duracion_min: Math.round(ruta.duracion_seg / 60),
        distancia_km: ruta.distancia_km,
        source: 'google',
        salida,
      };
    } catch (e) {
      console.warn('[ETA] Google Maps falló:', e.message);
    }
  }

  // Fallback: use scheduled appointment
  if (cita_descarga) {
    return { eta: new Date(cita_descarga), source: 'cita' };
  }

  return null;
}

module.exports = { calcularETA, ENABLED: !!MAPS_KEY };
