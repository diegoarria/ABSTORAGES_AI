// ── SOFIA — motor de operación ───────────────────────────────────────────────
// Cómo busca unidad SOFIA cuando entra una orden:
//   1. Ranking: los proveedores que cubren la ruta se ordenan por su
//      desempeño real (colocaciones.estadisticas).
//   2. Escalera: se contacta a los mejores (SOFIA_ESCALERA_TAMANO, default 3).
//      Si en SOFIA_ESCALERA_ESPERA_MIN nadie da una oferta, sigue la siguiente ola.
//   3. Seguimiento: un solo recordatorio a quien no contestó; luego "sin respuesta".
//   4. Ofertas: al llegar ofertas se arma el comparativo y se recomienda —
//      SOFIA NO adjudica sola, una persona aprueba (colocaciones.html).
//   5. Unidad asignada: se le pregunta al proveedor si ya salió y se avisa
//      al equipo de retrasos o falta de confirmación.
//   6. Horario: fuera de horario todo queda en cola (horarioContacto.js).
// Todo lo que sale a proveedores es por plantillas aprobadas. Cada paso queda
// en el feed "En vivo".
const colocaciones = require('./colocaciones');
const horario = require('./horarioContacto');
const agentPause = require('./agentPause');
const actividadBus = require('./actividadBus');
const whatsappProactivo = require('./whatsappProactivo');
const vapi = require('./vapi');
const notifier = require('./notifier');

const OLA_TAM         = Number(process.env.SOFIA_ESCALERA_TAMANO || 3);
const ESPERA_OLA_MIN  = Number(process.env.SOFIA_ESCALERA_ESPERA_MIN || 20);
const RECORD_MIN      = Number(process.env.SOFIA_RECORDATORIO_MIN || 45);
const SIN_RESP_MIN    = Number(process.env.SOFIA_SIN_RESPUESTA_MIN || 90);
const AVISO_OFERTA_MIN = Number(process.env.SOFIA_AVISO_OFERTA_MIN || 30);
const SEG_HORAS       = Number(process.env.SOFIA_SEGUIMIENTO_HORAS || 24);   // si no hay fecha de carga legible
const SEG_ESPERA_H    = Number(process.env.SOFIA_SEGUIMIENTO_ESPERA_H || 3);
const VIDA_MAX_H      = 72;

let sendPush = async () => {};
const feed = e => actividadBus.emitir({ agente: 'SOFIA', ...e });
const push = p => sendPush(p).catch(() => {});
const minDesde = iso => (Date.now() - new Date(iso).getTime()) / 60000;
const pesos = n => (n == null ? 'sin precio' : '$' + Number(n).toLocaleString('es-MX'));
const ruta = c => `${c.origen || '?'} → ${c.destino || '?'}`;

function ordenDe(c) {
  return { folio: c.folio, empresa: c.empresa, origen: c.origen, destino: c.destino, ruta: ruta(c), tipo_unidad: c.tipo_unidad || 'caja seca', fecha_carga: c.fecha_carga || 'por confirmar' };
}

// ── Alta de una búsqueda de unidad ──────────────────────────────────────────
// candidatos = proveedores ya filtrados por ruta y unidad
function iniciarBusqueda(lead, candidatos) {
  const pendientes = candidatos
    .map(p => ({ id: p.id, nombre: p.nombre, telefono: p.telefono, puntaje: colocaciones.puntaje(p.telefono) }))
    .sort((a, b) => b.puntaje - a.puntaje);
  const yaExistia = !!colocaciones.obtener(lead.folio);
  const c = colocaciones.crear({
    folio: lead.folio, origen: lead.origen, destino: lead.destino, tipo_unidad: lead.tipo_unidad,
    fecha_carga: lead.fecha_carga, empresa: lead.empresa || lead.nombre,
    urgente: !!lead.urgente || /urgente/i.test(String(lead.requisitos || '')), pendientes,
  });
  if (!c || yaExistia) return c;
  lanzarOla(c.folio);
  return c;
}

function lanzarOla(folio) {
  const c = colocaciones.obtener(folio);
  if (!c || c.estado !== 'buscando' || !c.pendientes.length) return false;
  if (agentPause.estaPausado('sofia')) return false;
  if (!horario.permitido(c.urgente)) {
    if (!c.avisos.enEspera) {
      colocaciones.marcarAviso(folio, 'enEspera');
      feed({ tipo: 'EN_ESPERA_HORARIO', mensaje: `Folio ${folio} (${ruta(c)}): fuera de horario de contacto (${horario.INICIO}:00–${horario.FIN}:00) — SOFIA empezará a contactar proveedores al abrir el horario` });
    }
    return false;
  }
  const ola = c.ola + 1;
  const siguientes = [...c.pendientes].sort((a, b) => colocaciones.puntaje(b.telefono) - colocaciones.puntaje(a.telefono)).slice(0, OLA_TAM);
  siguientes.forEach(p => colocaciones.marcarContactado(folio, p, ola));
  const orden = ordenDe(c);
  feed({ tipo: 'CONTACTANDO_PROVEEDORES', mensaje: `Folio ${folio} (${ruta(c)}) — ola ${ola}: SOFIA contactó a ${siguientes.map(p => p.nombre).join(', ')}${c.pendientes.length ? ` · quedan ${c.pendientes.length} en espera` : ''}`, metadata: { folio, ola } });
  if (ola === 1) push({ title: '🚚 SOFIA está contactando proveedores', body: `Folio ${folio} · ${ruta(c)} · ${siguientes.map(p => p.nombre).join(', ')}`, tag: 'sofia-contactando', url: '/actividad.html', tipo: 'CONTACTANDO_PROVEEDORES' });
  const provs = siguientes.map(p => ({ id: p.id, nombre: p.nombre, telefono: p.telefono, rutas: [], tipos_unidad: [], activo: true }));
  vapi.lanzarLlamadasProveedores(orden, provs)
    .then(r => feed({ tipo: 'VAPI_INICIADO', mensaje: `Folio ${folio} — ${r.llamadas} llamada(s) iniciada(s) en la ola ${ola}`, metadata: { folio, ...r } }))
    .catch(e => console.error('[sofiaOperacion] Error lanzando llamadas:', e.message));
  whatsappProactivo.preguntarDisponibilidadATodos(provs, orden).catch(e => console.error('[sofiaOperacion] Error preguntando disponibilidad:', e.message));
  return true;
}

// ── Ofertas ─────────────────────────────────────────────────────────────────
function avisarOferta(folio, quien) {
  const c = colocaciones.obtener(folio); if (!c) return;
  const comp = colocaciones.comparativo(c);
  const rec = comp.find(f => f.recomendado);
  feed({ tipo: 'OFERTA', mensaje: `Folio ${folio}: ${quien} tiene unidad${comp.find(f => f.nombre === quien)?.precio ? ` a ${pesos(comp.find(f => f.nombre === quien).precio)}` : ''} · ${comp.length} oferta(s) en total${rec ? ` · recomendado: ${rec.nombre} (${pesos(rec.precio)})` : ''}`, metadata: { folio } });
  push({ title: `📊 Oferta para el folio ${folio}`, body: `${comp.length} oferta(s)${rec ? ` · recomendado: ${rec.nombre} ${pesos(rec.precio)}` : ''} — entra a aprobar`, tag: 'oferta-' + folio, url: '/colocaciones.html', tipo: 'OFERTA', urgente: comp.length === 1 });
}

function ofertaPorLlamada(folio, proveedorId, datos) {
  const r = colocaciones.registrarOfertaVapi(folio, proveedorId, datos);
  if (r && datos.disponible) avisarOferta(folio, r.colocacion.proveedores[Object.keys(r.colocacion.proveedores).find(k => String(r.colocacion.proveedores[k].id) === String(proveedorId))]?.nombre || 'Un proveedor');
}

// ── Señales que SOFIA escribe en el chat con un proveedor ───────────────────
function json(respuesta, clave) {
  const m = String(respuesta || '').match(new RegExp(clave + '\\s*:\\s*(\\{[^\\n]+\\})'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function procesarSenales({ telefono, nombre, respuesta }) {
  try {
    colocaciones.registrarRespuesta(telefono);
    const quien = nombre || telefono;

    const of = json(respuesta, 'OFERTA_PROVEEDOR');
    if (of && typeof of.disponible === 'boolean') {
      const r = colocaciones.registrarOferta(telefono, of);
      if (r) {
        if (of.disponible) avisarOferta(r.folio, quien);
        else feed({ tipo: 'OFERTA', mensaje: `Folio ${r.folio}: ${quien} no tiene unidad disponible` });
      }
    }

    // El servicio colocado más reciente de este proveedor que aún no termina
    const servicioActivo = () => colocaciones.todas()
      .filter(x => x.estado === 'colocado' && x.ganador && colocaciones.tel10(x.ganador.tel) === colocaciones.tel10(telefono) && !colocaciones.hitoAlcanzado(x, 'entregado'))
      .sort((a, b) => new Date(b.colocadoEn) - new Date(a.colocadoEn))[0];

    const est = json(respuesta, 'ESTATUS_UNIDAD');
    const HITO_DE = { unidad_confirmada: 'unidad_confirmada', llego_carga: 'llego_carga', cargado: 'cargado', salio: 'en_ruta', en_ruta: 'en_ruta', llego_destino: 'llego_destino', entregado: 'entregado', evidencia_recibida: 'evidencia' };
    if (est && (HITO_DE[est.estado] || est.estado === 'retraso')) {
      const c = servicioActivo() || (est.estado === 'evidencia_recibida' ? colocaciones.todas().filter(x => x.estado === 'colocado' && x.ganador && colocaciones.tel10(x.ganador.tel) === colocaciones.tel10(telefono)).sort((a, b) => new Date(b.colocadoEn) - new Date(a.colocadoEn))[0] : null);
      if (c) {
        const detalle = String(est.detalle || '').slice(0, 200);
        if (est.estado === 'retraso') colocaciones.registrarRetraso(c.folio, detalle);
        else colocaciones.marcarHito(c.folio, HITO_DE[est.estado], detalle);
        const etiqueta = { unidad_confirmada: 'confirmó unidad y operador', llego_carga: 'llegó a carga', cargado: 'ya cargó', salio: 'salió y va en ruta', en_ruta: 'va en ruta', llego_destino: 'llegó a destino', entregado: 'entregó', evidencia_recibida: 'mandó evidencia de entrega', retraso: 'REPORTA RETRASO' }[est.estado];
        feed({ tipo: 'SEGUIMIENTO_UNIDAD', mensaje: `Folio ${c.folio}: ${quien} ${etiqueta}${detalle ? ' — ' + detalle.slice(0, 160) : ''}`, metadata: { folio: c.folio, estado: est.estado } });
        if (est.estado === 'retraso') push({ title: `Retraso — folio ${c.folio}`, body: `${quien}: ${detalle || 'sin detalle'}. Avisa al cliente (SARA/ventas).`, tag: 'retraso-' + c.folio, url: '/actividad.html', tipo: 'RETRASO', urgente: true });
        if (est.estado === 'entregado') push({ title: `Entregado — folio ${c.folio}`, body: `${quien} reporta entrega. Falta confirmar evidencia.`, tag: 'entregado-' + c.folio, url: '/colocaciones.html', tipo: 'SEGUIMIENTO' });
      }
    }

    // Datos del operador y la unidad — se guardan solo para el equipo, nunca se repiten
    const op = json(respuesta, 'OPERADOR_UNIDAD');
    if (op && (op.operador || op.placas || op.telefono)) {
      const c = servicioActivo();
      if (c) {
        colocaciones.guardarOperador(c.folio, { nombre: op.operador, placas: op.placas, telefono: op.telefono });
        feed({ tipo: 'SEGUIMIENTO_UNIDAD', mensaje: `Folio ${c.folio}: ${quien} registró los datos del operador y la unidad (visibles en Colocaciones)` });
      }
    }

    const sg = json(respuesta, 'SUGERENCIA_PROVEEDOR');
    if (sg) {
      const s = colocaciones.agregarSugerencia({ telefono, nombre, tipo: sg.tipo, valor: sg.valor });
      if (s) feed({ tipo: 'SUGERENCIA', mensaje: `${quien} sugiere ${{ ruta_agregar: 'agregar la ruta', ruta_quitar: 'quitar la ruta', unidad_agregar: 'agregar el tipo de unidad' }[s.tipo]} "${s.valor}" — pendiente de tu aprobación en Base de Datos` });
    }
  } catch (e) { console.error('[sofiaOperacion] Error procesando señales:', e.message); }
}

// ── Aprobación humana → SOFIA cierra ────────────────────────────────────────
async function aprobar(folio, { tel, manual, precio, aprobadoPor }) {
  const c = colocaciones.obtener(folio);
  if (!c) throw new Error('Folio no encontrado');
  if (c.estado === 'colocado') throw new Error('Este folio ya está colocado');
  const p = tel ? c.proveedores[colocaciones.tel10(tel)] : null;
  if (tel && !p) throw new Error('Ese proveedor no está en la búsqueda de este folio');
  const nombre = p?.nombre || String(manual || '').trim();
  if (!nombre) throw new Error('Indica el proveedor');
  colocaciones.asignar(folio, { tel: tel || null, nombre, precio: precio ?? p?.oferta?.precio ?? null, aprobadoPor });
  const g = colocaciones.obtener(folio).ganador;
  feed({ tipo: 'PROVEEDOR_GANADOR', mensaje: `✅ Folio ${folio} COLOCADO con ${nombre}${g.precio ? ' a ' + pesos(g.precio) : ''} (aprobó ${aprobadoPor || 'el equipo'})`, metadata: { folio } });
  notifier.notificarAsignacion(folio, nombre, g.precio ? pesos(g.precio) : null).catch(() => {});
  let mensaje = false;
  if (tel && !agentPause.estaPausado('sofia')) {
    try {
      const r = await whatsappProactivo.enviarEstatusFolio('sofia', tel, nombre, folio, 'te asignamos este servicio. En breve te confirmamos los detalles de carga');
      mensaje = !!r;
    } catch (e) { console.error('[sofiaOperacion] Error avisando al ganador:', e.message); }
  }
  return { ok: true, folio, ganador: g, mensajeAlGanador: mensaje };
}

// ── Tick cada minuto ────────────────────────────────────────────────────────
function fechaCargaDate(txt) {
  const m = String(txt || '').match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (!m) return null;
  const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(y, Number(m[2]) - 1, Number(m[1]), 8);
  return isNaN(d) ? null : d;
}

function tickBusqueda(c) {
  if (minDesde(c.creada) > VIDA_MAX_H * 60) {
    colocaciones.cambiarEstado(c.folio, 'sin_unidad');
    feed({ tipo: 'SIN_UNIDAD', mensaje: `Folio ${c.folio} (${ruta(c)}): más de ${VIDA_MAX_H} h sin colocar — SOFIA dejó de buscar` });
    return;
  }
  const comp = colocaciones.comparativo(c);
  if (comp.length) { // hay ofertas: se deja de escalar y se espera la decisión humana
    if (!c.avisos.recordatorioAprobacion && minDesde(comp.map(f => c.proveedores[colocaciones.tel10(f.tel)].oferta.en).sort()[0]) > AVISO_OFERTA_MIN) {
      colocaciones.marcarAviso(c.folio, 'recordatorioAprobacion');
      push({ title: `⏰ Ofertas sin aprobar — folio ${c.folio}`, body: `${comp.length} oferta(s) esperando tu decisión`, tag: 'oferta-pend-' + c.folio, url: '/colocaciones.html', tipo: 'OFERTA', urgente: true });
    }
    return;
  }
  if (!horario.permitido(c.urgente)) return;

  const provs = Object.values(c.proveedores);
  for (const p of provs) {
    if (p.estado !== 'esperando') continue;
    const edad = minDesde(p.contactadoEn);
    if (edad >= SIN_RESP_MIN) {
      p.estado = 'sin_respuesta'; colocaciones.guardarCambios();
      feed({ tipo: 'SIN_RESPUESTA', mensaje: `Folio ${c.folio}: ${p.nombre} no respondió` });
    } else if (edad >= RECORD_MIN && !p.recordatorioEn) {
      p.recordatorioEn = new Date().toISOString(); colocaciones.guardarCambios();
      whatsappProactivo.preguntarDisponibilidad({ nombre: p.nombre, telefono: p.tel }, ordenDe(c)).catch(e => console.error('[sofiaOperacion] Error en recordatorio:', e.message));
      feed({ tipo: 'RECORDATORIO', mensaje: `Folio ${c.folio}: recordatorio único a ${p.nombre} (no había respondido)` });
    }
  }

  if (c.pendientes.length) {
    const ultimaOla = provs.filter(p => p.ola === c.ola);
    const nadieActivo = ultimaOla.length && ultimaOla.every(p => ['rechazo', 'sin_respuesta'].includes(p.estado));
    if (!c.ultimaOlaEn || nadieActivo || minDesde(c.ultimaOlaEn) >= ESPERA_OLA_MIN) lanzarOla(c.folio);
  } else if (provs.length && provs.every(p => ['rechazo', 'sin_respuesta'].includes(p.estado))) {
    colocaciones.cambiarEstado(c.folio, 'sin_unidad');
    feed({ tipo: 'SIN_UNIDAD', mensaje: `Folio ${c.folio} (${ruta(c)}): ningún proveedor tiene unidad — revisar manualmente` });
    push({ title: '⚠️ Sin unidad disponible — SOFIA', body: `Folio ${c.folio} (${ruta(c)}): todos los proveedores contactados dijeron que no o no respondieron`, tag: 'sin-unidad', url: '/colocaciones.html', tipo: 'SIN_UNIDAD', urgente: true });
  }
}

// Chequeos por horario a lo largo del servicio. Cada uno sale UNA sola vez, por
// plantilla aprobada, solo en horario de contacto y solo si ese hito aún no
// se alcanza. Si no hay respuesta tras SEG_ESPERA_H, alerta al equipo.
const RUTA_H    = Number(process.env.SOFIA_SEG_RUTA_H || 5);      // horas después de cargar
const ENTREGA_H = Number(process.env.SOFIA_SEG_ENTREGA_H || 12);  // horas después de cargar
const H = 3600000;

function citaCarga(c) {
  return fechaCargaDate(c.fecha_carga) || new Date(new Date(c.colocadoEn).getTime() + SEG_HORAS * H);
}
function cuandoCargo(c) {
  const h = c.hitos?.cargado || c.hitos?.en_ruta;
  return h ? new Date(h.en).getTime() : null;
}
const CHEQUEOS = [
  { clave: 'previo',  hito: 'unidad_confirmada', etiqueta: 'confirmación de unidad y operador',
    cuando: c => Math.max(citaCarga(c).getTime() - 12 * H, new Date(c.colocadoEn).getTime() + H),
    texto: 'confirma por favor la unidad y el operador que va a cargar (nombre del operador, placas y su teléfono)' },
  { clave: 'carga',   hito: 'cargado', etiqueta: 'llegada y salida de carga',
    cuando: c => citaCarga(c).getTime() + 2 * H,
    texto: 'confirma por favor si la unidad ya llegó a carga y ya salió' },
  { clave: 'ruta',    hito: 'llego_destino', etiqueta: 'avance en ruta',
    cuando: c => (cuandoCargo(c) == null ? null : cuandoCargo(c) + RUTA_H * H),
    texto: 'cuéntame por favor cómo va la unidad en ruta y a qué hora estima llegar' },
  { clave: 'entrega', hito: 'entregado', etiqueta: 'entrega y evidencia',
    cuando: c => (cuandoCargo(c) == null ? null : cuandoCargo(c) + ENTREGA_H * H),
    texto: 'confirma por favor si ya entregó y mándame la foto del acuse de entrega' },
];

function tickSeguimiento(c) {
  if (!c.ganador?.tel) return;
  if (colocaciones.hitoAlcanzado(c, 'entregado')) return;
  const ahora = Date.now();
  for (const k of CHEQUEOS) {
    if (colocaciones.hitoAlcanzado(c, k.hito)) continue;
    const enviado = c.chequeos?.[k.clave];
    if (!enviado) {
      const cuando = k.cuando(c);
      if (cuando == null || ahora < cuando || !horario.permitido(false)) continue;
      colocaciones.marcarChequeo(c.folio, k.clave);
      whatsappProactivo.enviarEstatusFolio('sofia', c.ganador.tel, c.ganador.nombre, c.folio, k.texto)
        .catch(e => console.error('[sofiaOperacion] Error en seguimiento:', e.message));
      feed({ tipo: 'SEGUIMIENTO_UNIDAD', mensaje: `Folio ${c.folio}: SOFIA le pidió a ${c.ganador.nombre} ${k.etiqueta}` });
      break; // un chequeo por servicio por ciclo
    } else if (!c.alertasSeg?.[k.clave] && minDesde(enviado) > SEG_ESPERA_H * 60) {
      colocaciones.marcarAlertaSeg(c.folio, k.clave);
      feed({ tipo: 'SEGUIMIENTO_UNIDAD', mensaje: `Folio ${c.folio}: ${c.ganador.nombre} no ha confirmado ${k.etiqueta}` });
      push({ title: `Sin confirmar — folio ${c.folio}`, body: `${c.ganador.nombre} no respondió: ${k.etiqueta}. Revísalo.`, tag: 'seg-' + c.folio + k.clave, url: '/colocaciones.html', tipo: 'SEGUIMIENTO', urgente: true });
    }
  }
}

function tick() {
  if (agentPause.estaPausado('sofia')) return;
  for (const c of colocaciones.todas()) {
    try {
      if (c.estado === 'buscando') tickBusqueda(c);
      else if (c.estado === 'colocado') tickSeguimiento(c);
    } catch (e) { console.error('[sofiaOperacion] Error en tick de', c.folio, e.message); }
  }
}

function iniciar({ sendPush: sp } = {}) {
  if (sp) sendPush = sp;
  setInterval(tick, 60 * 1000);
  console.log(`[sofiaOperacion] Activo — escalera de ${OLA_TAM}, horario ${horario.INICIO}:00–${horario.FIN}:00`);
}

module.exports = { iniciar, iniciarBusqueda, lanzarOla, procesarSenales, ofertaPorLlamada, aprobar, tick };
