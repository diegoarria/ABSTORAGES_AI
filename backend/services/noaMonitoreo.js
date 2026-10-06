// ── NOA — motor de monitoreo autónomo de viajes en tránsito ─────────────────
// Pedido explícito del usuario (06-oct-2026): separar el dominio de NOA
// (monitorear el viaje una vez que ya va en marcha) del de SOFIA (buscar,
// negociar y colocar al proveedor — eso NO se toca aquí, sigue 100% igual).
//
// Fuente de los viajes a vigilar: colocaciones.js (decisión explícita del
// usuario) — todo folio con estado "colocado" que aún no llega a "entregado".
// GPS: se busca el link compartido del folio en el TMS (tms.buscarFolioNOA)
// y se consulta con gpsProviders (Wialon/Holkan/Protrack365, ya existentes) —
// si el folio no está en el TMS o no tiene GPS, el monitoreo sigue solo con
// las señales de tiempo/hitos que ya trae la colocación.
//
// Reglas determinísticas primero, LLM después (no se usa LLM en esta
// primera versión — ver PROCESO.md / discusión con el usuario: con hitos,
// tiempos y GPS alcanza para la mayoría de las anomalías; el día que haga
// falta interpretar texto ambiguo del operador, eso sí amerita LLM, pero
// no cada minuto de cada viaje — controla el costo).
//
// Escalamiento: reusa alertasStaff.alertarCriticoStaff() tal cual —ya tiene
// dedup, kill-switch, WhatsApp+llamada+grupo— no se duplica nada de eso aquí.
const colocaciones = require('./colocaciones');
const agentPause = require('./agentPause');
const actividadBus = require('./actividadBus');
const alertasStaff = require('./alertasStaff');
const tms = require('./tms');
const gpsProviders = require('./gpsProviders');
const vapi = require('./vapi');
const geocode = require('./geocode');
const noaRiskFeedback = require('./noaRiskFeedback');

const HABILITADO = process.env.NOA_MONITOREO === 'true';
const TICK_MIN = Number(process.env.NOA_MONITOREO_TICK_MIN || 5);

// ── Umbrales configurables (no hardcoded en la lógica — ver sección 7/32 del
// spec del usuario: todo esto debe poder ajustarse sin tocar código) ────────
const UMBRAL = {
  sinActualizacionMin: Number(process.env.NOA_MONITOREO_SIN_ACTUALIZACION_MIN || 90), // sin avance de hito ni contacto, una vez "en_ruta"
  gpsStaleMin:          Number(process.env.NOA_MONITOREO_GPS_STALE_MIN || 45),         // última lectura GPS más vieja que esto = dato caducado
  gpsDetenidoMin:        Number(process.env.NOA_MONITOREO_GPS_DETENIDO_MIN || 40),      // velocidad ~0 sostenida
  retraso: {
    normal:   Number(process.env.NOA_MONITOREO_RETRASO_NORMAL_MIN || 10),
    bajo:     Number(process.env.NOA_MONITOREO_RETRASO_BAJO_MIN || 20),
    medio:    Number(process.env.NOA_MONITOREO_RETRASO_MEDIO_MIN || 45),
    alto:     Number(process.env.NOA_MONITOREO_RETRASO_ALTO_MIN || 90),
  },
  riesgo: { medio: 21, alto: 51, critico: 76 }, // sobre el risk_score 0-100
  // 80km por default a propósito — probado con MTY→CDMX: un punto normal
  // sobre la autopista REAL (que no es recta) ya está a ~137km de la línea
  // recta entre las dos ciudades. Con un umbral bajo, esta heurística generaría
  // alertas falsas en cualquier ruta con curvas reales (que es casi todas).
  // Ver nota completa de limitaciones en distanciaCrossTrackKm().
  desviacionKm:       Number(process.env.NOA_MONITOREO_DESVIACION_KM || 80),
  highSostenidoMin:   Number(process.env.NOA_MONITOREO_HIGH_SOSTENIDO_MIN || 30), // HIGH que no baja ni con chofer contactado = escala igual que CRITICAL
};

// Cooldown entre llamadas reactivas de NOA al chofer por el mismo folio —
// sin esto, un folio que se queda en MEDIUM/HIGH llamaría al chofer cada
// TICK_MIN minutos sin parar.
const COOLDOWN_LLAMADA_MIN = Number(process.env.NOA_MONITOREO_COOLDOWN_LLAMADA_MIN || 45);
const ultimaLlamadaChofer = new Map(); // folio → timestamp

const feed = e => actividadBus.emitir({ agente: 'NOA', ...e });
const minDesde = iso => iso ? (Date.now() - new Date(iso).getTime()) / 60000 : null;

// ── ETA: misma convención de parseo de fecha que sofiaOperacion.js (TMS
// manda "DD/MM/YYYY HH:MM" en fecha_carga) — replicada aquí a propósito en
// vez de importarla porque es una función interna sin exportar; si en el
// futuro se usa en un tercer lugar, vale la pena moverla a un helper común.
function fechaCita(txt) {
  const m = String(txt || '').match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\D+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  const hh = m[4] != null ? Number(m[4]) : 8, mm = m[5] != null ? Number(m[5]) : 0;
  const d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1]), hh + 6, mm)); // hora Monterrey (UTC-6)
  return isNaN(d) ? null : d;
}

function severidadRetraso(minutos) {
  if (minutos == null) return null;
  if (minutos <= UMBRAL.retraso.normal) return null; // no es anomalía, es ruido normal
  if (minutos <= UMBRAL.retraso.bajo) return 'LOW';
  if (minutos <= UMBRAL.retraso.medio) return 'MEDIUM';
  if (minutos <= UMBRAL.retraso.alto) return 'HIGH';
  return 'CRITICAL';
}

// El TMS (Google Apps Script sobre Sheets) puede tardar 30-45s o hacer
// timeout completo en consultas pesadas — ya documentado en tms.js (su
// propio TMS_TIMEOUT_MS es 45s, y buscarFolioNOA hace DOS consultas
// seguidas, hasta 90s en el peor caso). Si cada folio activo esperara eso
// dentro del tick, el monitoreo completo se podría colgar. Por eso el GPS
// corre con su propio timeout corto y nunca bloquea el resto del tick.
const GPS_TIMEOUT_MS = Number(process.env.NOA_MONITOREO_GPS_TIMEOUT_MS || 12000);
function conTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve({ disponible: false, timeout: true }), ms)),
  ]);
}

// ── GPS: best-effort, nunca bloquea el resto del monitoreo si falla o tarda ──
// Si el folio no trae link de GPS (o no se pudo leer), intenta la cuenta
// espejo de Wialon por placas del tractor (ver wialon.js) — no-op si no hay
// WIALON_MIRROR_TOKEN configurado, así que no cambia nada para quien no
// tenga una cuenta espejo dada por su proveedor.
async function leerGPS(c) {
  return conTimeout((async () => {
    try {
      const registros = await tms.buscarFolioNOA(c.folio);
      const url = registros?.[0]?.GPS;
      if (url && gpsProviders.esUrlSoportada(url)) {
        const u = await gpsProviders.obtenerUbicacion(url, { conDireccion: true });
        if (u) return { disponible: true, lectura: u };
      }
      const placas = c.operador?.placas;
      if (placas) {
        const u = await gpsProviders.obtenerUbicacionPorNombre(placas, { conDireccion: true });
        if (u) return { disponible: true, lectura: u, viaCuentaEspejo: true };
      }
      return { disponible: false };
    } catch (e) {
      console.error(`[noaMonitoreo] Error leyendo GPS de ${c.folio}:`, e.message);
      return { disponible: false, error: e.message };
    }
  })(), GPS_TIMEOUT_MS);
}

// ── Distancia perpendicular (cross-track) de un punto a la línea recta
// origen→destino, en km — fórmula esférica estándar de navegación. Es una
// heurística DÉBIL para "desviación de ruta": no conoce la carretera real
// (curvas, montaña, rodeos legítimos), solo la línea recta entre dos
// ciudades. Por eso en evaluarViaje() nunca pesa más que MEDIUM ni dispara
// CRITICAL por sí sola — sirve para detectar desvíos groseros, no para
// vigilancia de geocerca real (eso requeriría un polyline de Google Maps
// Directions, que este proyecto no tiene contratado — ver tariff.js).
const R_TIERRA_KM = 6371;
const rad = g => g * Math.PI / 180;
function distanciaCrossTrackKm(origen, destino, punto) {
  const d13 = Math.acos(Math.min(1, Math.max(-1,
    Math.sin(rad(origen.lat)) * Math.sin(rad(punto.lat)) +
    Math.cos(rad(origen.lat)) * Math.cos(rad(punto.lat)) * Math.cos(rad(punto.lng - origen.lng))
  )));
  if (!isFinite(d13) || d13 === 0) return 0;
  const bearing = (lat1, lng1, lat2, lng2) => {
    const y = Math.sin(rad(lng2 - lng1)) * Math.cos(rad(lat2));
    const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lng2 - lng1));
    return Math.atan2(y, x);
  };
  const theta13 = bearing(origen.lat, origen.lng, punto.lat, punto.lng);
  const theta12 = bearing(origen.lat, origen.lng, destino.lat, destino.lng);
  const dxt = Math.asin(Math.sin(d13) * Math.sin(theta13 - theta12)) * R_TIERRA_KM;
  return Math.abs(dxt);
}

// ── Construye el contexto operativo + detecta anomalías (determinístico) ──
// No muta `c` — colocaciones.todas() devuelve referencias al objeto vivo en
// memoria, y cualquier campo que se le pegue aquí quedaría persistido en
// disco la próxima vez que CUALQUIER otra parte del sistema llame guardar().
// Todo lo que hay que recordar entre ticks se devuelve y se guarda explícito
// vía colocaciones.actualizarMonitoreoNOA().
async function evaluarViaje(c) {
  const anomalias = [];
  const ahora = Date.now();
  let detenidoDesde = null, gpsVelocidadUltima = null;

  // 1) Retraso contra la cita de descarga (si ya se conoce)
  const citaDescarga = fechaCita(c.fecha_descarga || c.fecha_carga);
  let retrasoMin = null;
  if (citaDescarga && !colocaciones.hitoAlcanzado(c, 'llego_destino')) {
    retrasoMin = Math.round((ahora - citaDescarga.getTime()) / 60000);
    const sev = severidadRetraso(retrasoMin);
    if (sev) anomalias.push({
      tipo: 'RETRASO_ETA', severity: sev, confidence: 0.9,
      reason: `${retrasoMin} min respecto a la cita de descarga`,
      evidence: { citaDescarga: citaDescarga.toISOString(), retrasoMin },
      recommended_action: sev === 'CRITICAL' || sev === 'HIGH' ? 'escalate_to_human' : 'monitor',
    });
  }

  // 2) Sin avance ni contacto desde hace mucho, una vez que ya salió a ruta
  if (colocaciones.hitoAlcanzado(c, 'en_ruta') && !colocaciones.hitoAlcanzado(c, 'llego_destino')) {
    const ultimoHito = Object.entries(c.hitos || {}).sort((a, b) => new Date(b[1].en) - new Date(a[1].en))[0];
    const minSinHito = ultimoHito ? minDesde(ultimoHito[1].en) : null;
    if (minSinHito != null && minSinHito >= UMBRAL.sinActualizacionMin) {
      anomalias.push({
        tipo: 'SIN_ACTUALIZACION', severity: minSinHito >= UMBRAL.sinActualizacionMin * 2 ? 'HIGH' : 'MEDIUM', confidence: 0.7,
        reason: `${Math.round(minSinHito)} min sin ningún avance de hito (último: ${ultimoHito[0]})`,
        evidence: { ultimoHito: ultimoHito[0], en: ultimoHito[1].en },
        recommended_action: 'request_driver_confirmation',
      });
    }
  }

  // 3) Retrasos ya reportados por el propio operador (vía SOFIA) — si hay
  //    uno reciente sin resolver, cuenta como señal de riesgo adicional.
  const ultimoRetraso = (c.retrasos || [])[c.retrasos?.length - 1];
  if (ultimoRetraso && minDesde(ultimoRetraso.en) < 180) {
    anomalias.push({
      tipo: 'RETRASO_REPORTADO', severity: 'LOW', confidence: 1.0,
      reason: `El operador reportó: "${ultimoRetraso.detalle || 'sin detalle'}"`,
      evidence: ultimoRetraso, recommended_action: 'monitor',
    });
  }

  // 4) GPS (best-effort)
  const gps = await leerGPS(c);
  if (gps.disponible && gps.lectura) {
    const edadMin = minDesde(gps.lectura.timestamp);
    if (edadMin != null && edadMin >= UMBRAL.gpsStaleMin) {
      anomalias.push({
        tipo: 'GPS_SIN_DATO', severity: 'MEDIUM', confidence: 0.6,
        reason: `Última lectura de GPS hace ${Math.round(edadMin)} min`,
        evidence: { timestamp: gps.lectura.timestamp }, recommended_action: 'request_driver_confirmation',
      });
    } else if ((gps.lectura.speedKmh || 0) < 3) {
      // Velocidad ~0 — se guarda la marca de tiempo del primer "detenido"
      // visto en monitoreoNOA.detenidoDesde para medir cuánto lleva así
      // entre un tick y el siguiente, sin inventar historial que no se tiene.
      detenidoDesde = c.monitoreoNOA?.detenidoDesde && c.monitoreoNOA?.gpsVelocidadUltima < 3
        ? c.monitoreoNOA.detenidoDesde : new Date().toISOString();
      const minDetenido = minDesde(detenidoDesde);
      if (minDetenido >= UMBRAL.gpsDetenidoMin) {
        anomalias.push({
          tipo: 'UNEXPECTED_STOP', severity: minDetenido >= UMBRAL.gpsDetenidoMin * 2 ? 'HIGH' : 'MEDIUM', confidence: 0.75,
          reason: `GPS muestra ${Math.round(minDetenido)} min detenido${gps.lectura.direccion ? ' en ' + gps.lectura.direccion : ''}`,
          evidence: { lat: gps.lectura.lat, lng: gps.lectura.lng, speedKmh: gps.lectura.speedKmh, detenidoDesde },
          recommended_action: 'request_driver_confirmation',
        });
      }
    }
    gpsVelocidadUltima = gps.lectura.speedKmh ?? null;
  }
  // Sin link de GPS para este folio: no es anomalía (muchos folios no lo
  // traen capturado), solo queda registrado para que el score lo sepa.

  // 5) Desviación de ruta — ver distanciaCrossTrackKm() para las limitaciones
  // de esta heurística (línea recta, no carretera real). Solo se evalúa ya
  // en ruta y con GPS disponible, para no generar ruido en carga/descarga
  // donde moverse unos km del centro de la ciudad es normal.
  if (colocaciones.hitoAlcanzado(c, 'en_ruta') && !colocaciones.hitoAlcanzado(c, 'llego_destino') && gps.disponible && gps.lectura) {
    try {
      const [org, dst] = await Promise.all([geocode.forwardGeocode(c.origen), geocode.forwardGeocode(c.destino)]);
      if (org && dst) {
        const descKm = distanciaCrossTrackKm(org, dst, { lat: gps.lectura.lat, lng: gps.lectura.lng });
        if (descKm >= UMBRAL.desviacionKm) {
          anomalias.push({
            tipo: 'DESVIACION_RUTA', severity: descKm >= UMBRAL.desviacionKm * 2 ? 'MEDIUM' : 'LOW', confidence: 0.5,
            reason: `GPS está a ~${Math.round(descKm)} km de la línea recta ${c.origen} → ${c.destino}`,
            evidence: { lat: gps.lectura.lat, lng: gps.lectura.lng, descKm: Math.round(descKm) },
            recommended_action: 'request_driver_confirmation',
          });
        }
      }
    } catch (e) {
      console.error(`[noaMonitoreo] Error calculando desviación de ruta de ${c.folio}:`, e.message);
    }
  }

  return { anomalias, retrasoMin, gps, detenidoDesde, gpsVelocidadUltima };
}

// ── Risk score: suma ponderada de las anomalías detectadas, 0-100 ─────────
const PESO_SEVERIDAD = { LOW: 10, MEDIUM: 25, HIGH: 45, CRITICAL: 70 };
function calcularRiesgo(anomalias) {
  if (!anomalias.length) return { score: 0, severidad: 'NORMAL' };
  const score = Math.min(100, anomalias.reduce((acc, a) => acc + (PESO_SEVERIDAD[a.severity] || 0) * a.confidence, 0));
  const severidad = score >= UMBRAL.riesgo.critico ? 'CRITICAL' : score >= UMBRAL.riesgo.alto ? 'HIGH' : score >= UMBRAL.riesgo.medio ? 'MEDIUM' : 'NORMAL';
  return { score: Math.round(score), severidad };
}

function resumenDecision(c, anomalias, riesgo) {
  if (!anomalias.length) return `Sin novedad — riesgo ${riesgo.score}/100.`;
  const partes = anomalias.map(a => a.reason).join('; ');
  return `Riesgo ${riesgo.score}/100 (${riesgo.severidad}) — ${partes}.`;
}

// ── Episodios: un tramo continuo de MEDIUM+ para un folio ─────────────────
// Se usa para dos cosas: (2) saber cuánto lleva sostenido un HIGH para
// escalar aunque nunca llegue a CRITICAL, y (6) tener algo concreto que
// marcar después como "fue real" o "fue ruido" para calibrar los umbrales
// (ver noaRiskFeedback.js) — mucho más útil que calificar cada tick suelto.
const ORDEN_SEVERIDAD = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
function actualizarEpisodio(c, riesgo, anomalias) {
  const actual = c.monitoreoNOA?.episodio || null;
  if (riesgo.severidad === 'NORMAL') {
    if (actual) {
      try {
        noaRiskFeedback.registrarEpisodio({
          folio: c.folio, desde: actual.desde,
          maxSeveridad: actual.maxSeveridad, maxScore: actual.maxScore, tipos: actual.tipos,
        });
      } catch (e) { console.error('[noaMonitoreo] Error registrando episodio cerrado:', e.message); }
    }
    return null;
  }
  const tiposNuevos = anomalias.map(a => a.tipo);
  if (!actual) {
    return { desde: new Date().toISOString(), maxSeveridad: riesgo.severidad, maxScore: riesgo.score, tipos: [...new Set(tiposNuevos)] };
  }
  return {
    desde: actual.desde,
    maxSeveridad: ORDEN_SEVERIDAD[riesgo.severidad] > ORDEN_SEVERIDAD[actual.maxSeveridad] ? riesgo.severidad : actual.maxSeveridad,
    maxScore: Math.max(actual.maxScore || 0, riesgo.score),
    tipos: [...new Set([...(actual.tipos || []), ...tiposNuevos])],
  };
}

// ── Cierra el loop con el chofer antes de necesitar a un humano ───────────
// Reusa vapi.llamarStatusChofer tal cual (ya trae pausa/rate-limit/contexto
// de folio) — la respuesta llega de forma asíncrona por /api/vapi/webhook,
// igual que cualquier otra llamada de NOA (alerta_critica / estatus_relevante
// vía structuredData, ver server-lite.js), no hay nada nuevo que cablear ahí.
async function intentarLlamarChofer(c, riesgo, decision) {
  const ultima = ultimaLlamadaChofer.get(c.folio) || 0;
  if (Date.now() - ultima < COOLDOWN_LLAMADA_MIN * 60000) return;
  const telefono = c.operador?.telefono || c.ganador?.tel;
  if (!telefono) return; // sin teléfono no hay a quién llamar — ya es una limitación conocida, no una anomalía nueva
  ultimaLlamadaChofer.set(c.folio, Date.now());
  try {
    await vapi.llamarStatusChofer({
      telefono, nombre: c.operador?.nombre || c.ganador?.nombre || 'transportista',
      folio: c.folio, ruta: `${c.origen || '?'} → ${c.destino || '?'}`,
    });
    feed({ tipo: 'LLAMADA_PROACTIVA', mensaje: `Folio ${c.folio}: NOA llamó al chofer por riesgo ${riesgo.severidad} — ${decision}`, metadata: { folio: c.folio, severidad: riesgo.severidad } });
  } catch (e) {
    console.error(`[noaMonitoreo] Error llamando al chofer del folio ${c.folio}:`, e.message);
  }
}

// ── Tick: revisa todos los viajes colocados y aún no entregados ───────────
async function evaluarYActuar(c) {
  try {
    const { anomalias, gps, detenidoDesde, gpsVelocidadUltima } = await evaluarViaje(c);
    const riesgo = calcularRiesgo(anomalias);
    const decision = resumenDecision(c, anomalias, riesgo);
    const episodio = actualizarEpisodio(c, riesgo, anomalias);

    colocaciones.actualizarMonitoreoNOA(c.folio, {
      riskScore: riesgo.score, severidad: riesgo.severidad, anomalias,
      decisionSummary: decision,
      detenidoDesde: detenidoDesde || null,
      gpsVelocidadUltima: gpsVelocidadUltima ?? null,
      gpsDisponible: gps.disponible,
      episodio,
    });

    if (riesgo.severidad === 'CRITICAL' || riesgo.severidad === 'HIGH') {
      feed({ tipo: 'RIESGO_VIAJE', mensaje: `Folio ${c.folio}: ${decision}`, metadata: { folio: c.folio, severidad: riesgo.severidad, score: riesgo.score } });
    }

    // Antes de necesitar a un humano, NOA intenta cerrar el loop sola
    // llamando al chofer — MEDIUM+ (no espera a CRITICAL).
    if (riesgo.severidad !== 'NORMAL' && riesgo.severidad !== 'LOW') {
      await intentarLlamarChofer(c, riesgo, decision);
    }

    // Escalamiento: CRITICAL escala siempre. Además, un HIGH sostenido por
    // más de highSostenidoMin (el chofer ya fue contactado y el riesgo no
    // bajó) escala igual aunque nunca cruce a CRITICAL — antes esto se
    // quedaba en silencio indefinidamente si el risk score no subía más.
    const minEpisodio = episodio ? minDesde(episodio.desde) : null;
    const highSostenido = riesgo.severidad === 'HIGH' && minEpisodio != null && minEpisodio >= UMBRAL.highSostenidoMin;

    if (riesgo.severidad === 'CRITICAL' || highSostenido) {
      const motivo = highSostenido && riesgo.severidad !== 'CRITICAL'
        ? `${decision} (HIGH sostenido ${Math.round(minEpisodio)} min sin bajar pese a contactar al chofer)`
        : decision;
      await alertasStaff.alertarCriticoStaff({ folio: c.folio, motivo, canal: 'monitoreo-noa' });
    }
  } catch (e) {
    console.error(`[noaMonitoreo] Error evaluando folio ${c.folio}:`, e.message);
  }
}

async function tick() {
  if (!HABILITADO) return;
  if (agentPause.estaPausado('noa')) return;

  // En paralelo, no uno por uno — cada evaluarViaje() ya trae su propio
  // timeout de GPS (ver leerGPS), así que un tick completo con N viajes
  // activos tarda ~GPS_TIMEOUT_MS en el peor caso, no N×GPS_TIMEOUT_MS.
  const activos = colocaciones.todas().filter(c => c.estado === 'colocado' && !colocaciones.hitoAlcanzado(c, 'entregado'));
  await Promise.allSettled(activos.map(evaluarYActuar));
}

function iniciar() {
  if (!HABILITADO) { console.log('[noaMonitoreo] Desactivado (NOA_MONITOREO != "true")'); return; }
  setInterval(() => tick().catch(e => console.error('[noaMonitoreo]', e.message)), TICK_MIN * 60 * 1000);
  console.log(`[noaMonitoreo] Activo — revisando viajes colocados cada ${TICK_MIN} min`);
}

// Lista para un futuro dashboard (o el ops-center/colocaciones.html ya
// existentes) — ordenada de más a menos riesgo. No se construye UI nueva
// en esta primera versión, solo se deja el dato disponible.
function viajesMonitoreados() {
  return colocaciones.todas()
    .filter(c => c.estado === 'colocado' && c.monitoreoNOA)
    .map(c => ({ folio: c.folio, origen: c.origen, destino: c.destino, empresa: c.empresa, ganador: c.ganador?.nombre || null, ...c.monitoreoNOA }))
    .sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
}

module.exports = { iniciar, tick, viajesMonitoreados, evaluarViaje, calcularRiesgo };
