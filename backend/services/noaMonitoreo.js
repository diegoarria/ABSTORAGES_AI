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
};

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
async function leerGPS(folio) {
  return conTimeout((async () => {
    try {
      const registros = await tms.buscarFolioNOA(folio);
      const url = registros?.[0]?.GPS;
      if (!url || !gpsProviders.esUrlSoportada(url)) return { disponible: false };
      const u = await gpsProviders.obtenerUbicacion(url, { conDireccion: true });
      if (!u) return { disponible: true, lectura: null };
      return { disponible: true, lectura: u };
    } catch (e) {
      console.error(`[noaMonitoreo] Error leyendo GPS de ${folio}:`, e.message);
      return { disponible: false, error: e.message };
    }
  })(), GPS_TIMEOUT_MS);
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
  const gps = await leerGPS(c.folio);
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

// ── Tick: revisa todos los viajes colocados y aún no entregados ───────────
async function evaluarYActuar(c) {
  try {
    const { anomalias, gps, detenidoDesde, gpsVelocidadUltima } = await evaluarViaje(c);
    const riesgo = calcularRiesgo(anomalias);
    const decision = resumenDecision(c, anomalias, riesgo);

    colocaciones.actualizarMonitoreoNOA(c.folio, {
      riskScore: riesgo.score, severidad: riesgo.severidad, anomalias,
      decisionSummary: decision,
      detenidoDesde: detenidoDesde || null,
      gpsVelocidadUltima: gpsVelocidadUltima ?? null,
      gpsDisponible: gps.disponible,
    });

    if (riesgo.severidad === 'CRITICAL' || riesgo.severidad === 'HIGH') {
      feed({ tipo: 'RIESGO_VIAJE', mensaje: `Folio ${c.folio}: ${decision}`, metadata: { folio: c.folio, severidad: riesgo.severidad, score: riesgo.score } });
    }

    // Solo lo CRÍTICO escala solo — reusa el pipeline ya construido de
    // NOA (dedup + kill-switch + WhatsApp/llamada/grupo), sin duplicar
    // nada de esa lógica aquí.
    if (riesgo.severidad === 'CRITICAL') {
      await alertasStaff.alertarCriticoStaff({ folio: c.folio, motivo: decision, canal: 'monitoreo-noa' });
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
