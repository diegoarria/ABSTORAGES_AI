// ── Colocaciones — ciclo de vida de cada servicio que SOFIA busca colocar ────
// Un "servicio colocado" = una orden a la que ya se le asignó proveedor.
// Aquí vive todo lo que SOFIA hace por folio: a quién contactó, en qué ola,
// quién respondió y cuánto tardó, las ofertas, el ganador y el seguimiento
// de la unidad. De aquí salen el ranking de proveedores, la recomendación de
// a quién asignar y los KPIs diarios.
//
// Persistencia: data/sofia-operacion.json (archivo escrito en runtime, vive
// en el volumen de Railway). Es un solo proceso, así que basta con un caché
// en memoria + guardado con debounce.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const FILE = path.join(DATA_DIR, 'sofia-operacion.json');

let db = { colocaciones: {}, sugerencias: [], kpi: {} };
try {
  if (fs.existsSync(FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch (e) { console.error('[colocaciones] No se pudo leer el archivo, se arranca vacío:', e.message); }

let timer = null;
function guardar() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) { console.error('[colocaciones] Error guardando:', e.message); }
  }, 300);
}

const tel10 = t => String(t || '').replace(/\D/g, '').slice(-10);
const ahora = () => new Date().toISOString();

// Fecha calendario en hora de Monterrey → 'YYYY-MM-DD'
function fechaMTY(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Monterrey', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(d)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// ── Alta / consulta ─────────────────────────────────────────────────────────
function crear({ folio, origen, destino, tipo_unidad, fecha_carga, empresa, urgente, pendientes }) {
  if (!folio) return null;
  if (db.colocaciones[folio]) return db.colocaciones[folio]; // idempotente
  db.colocaciones[folio] = {
    folio, origen: origen || '', destino: destino || '', tipo_unidad: tipo_unidad || '', fecha_carga: fecha_carga || '',
    empresa: empresa || '', urgente: !!urgente,
    creada: ahora(), estado: 'buscando', ola: 0, ultimaOlaEn: null,
    proveedores: {}, pendientes: pendientes || [],
    ganador: null, colocadoEn: null,
    seguimiento: { estado: 'pendiente' },
    avisos: {},
  };
  guardar();
  return db.colocaciones[folio];
}

const obtener = folio => db.colocaciones[folio] || null;
const todas = () => Object.values(db.colocaciones);
const abiertas = () => todas().filter(c => c.estado === 'buscando');

function marcarContactado(folio, prov, ola) {
  const c = obtener(folio); if (!c) return;
  const k = tel10(prov.telefono);
  c.proveedores[k] = { tel: prov.telefono, nombre: prov.nombre, id: prov.id || null, ola, contactadoEn: ahora(), estado: 'esperando', respondioEn: null, oferta: null, recordatorioEn: null };
  c.pendientes = c.pendientes.filter(p => tel10(p.telefono) !== k);
  c.ola = Math.max(c.ola, ola); c.ultimaOlaEn = ahora();
  guardar();
}

// Colocaciones abiertas (o recién colocadas) donde este teléfono fue contactado, la más reciente primero
function porTelefono(telefono, soloAbiertas = true) {
  const k = tel10(telefono);
  return todas()
    .filter(c => c.proveedores[k] && (!soloAbiertas || c.estado === 'buscando'))
    .sort((a, b) => new Date(c2(b, k)) - new Date(c2(a, k)));
}
const c2 = (c, k) => c.proveedores[k].contactadoEn;

// Cualquier mensaje entrante del proveedor = respondió (aunque aún no dé oferta)
function registrarRespuesta(telefono) {
  const k = tel10(telefono);
  const c = porTelefono(telefono)[0];
  if (!c) return null;
  const p = c.proveedores[k];
  if (p.estado === 'esperando') { p.estado = 'respondio'; p.respondioEn = ahora(); guardar(); }
  return c.folio;
}

function registrarOferta(telefono, { disponible, precio, unidad, notas }) {
  const k = tel10(telefono);
  const c = porTelefono(telefono)[0];
  if (!c) return null;
  const p = c.proveedores[k];
  p.respondioEn = p.respondioEn || ahora();
  const n = Number(String(precio || '').replace(/[^\d.]/g, ''));
  if (disponible === false) { p.estado = 'rechazo'; p.oferta = null; }
  else { p.estado = 'acepto'; p.oferta = { precio: isNaN(n) || !n ? null : n, unidad: unidad || null, notas: notas || null, en: ahora() }; }
  guardar();
  return { folio: c.folio, colocacion: c };
}

// Resultado de una llamada de Vapi (el proveedor se identifica por su id de contacto)
function registrarOfertaVapi(folio, proveedorId, { disponible, precio }) {
  const c = obtener(folio); if (!c) return null;
  const p = Object.values(c.proveedores).find(x => String(x.id) === String(proveedorId));
  if (!p) return null;
  return registrarOferta(p.tel, { disponible, precio, unidad: null, notas: 'por llamada' });
}

function asignar(folio, { tel, nombre, precio, aprobadoPor }) {
  const c = obtener(folio); if (!c) return null;
  const k = tel10(tel);
  const p = c.proveedores[k];
  c.ganador = { tel: tel || null, nombre: nombre || p?.nombre || 'Proveedor', precio: precio ?? p?.oferta?.precio ?? null, aprobadoPor: aprobadoPor || null, en: ahora() };
  c.estado = 'colocado'; c.colocadoEn = ahora(); c.pendientes = [];
  c.seguimiento = { estado: 'asignado' };
  c.hitos = { asignado: { en: ahora(), detalle: null } }; c.chequeos = {}; c.alertasSeg = {}; c.retrasos = [];
  guardar();
  return c;
}

// ── Hitos del servicio ya colocado ──────────────────────────────────────────
const HITOS = ['asignado', 'unidad_confirmada', 'llego_carga', 'cargado', 'en_ruta', 'llego_destino', 'entregado', 'evidencia'];
const idxHito = h => HITOS.indexOf(h);
// ¿ya se alcanzó este hito (o uno posterior)?
function hitoAlcanzado(c, hito) {
  const i = idxHito(hito);
  return Object.keys(c.hitos || {}).some(h => idxHito(h) >= i && h !== 'evidencia') || (hito === 'evidencia' && !!c.hitos?.evidencia);
}
function marcarHito(folio, hito, detalle) {
  const c = obtener(folio); if (!c || idxHito(hito) < 0) return null;
  c.hitos = c.hitos || {};
  if (!c.hitos[hito]) c.hitos[hito] = { en: ahora(), detalle: detalle ? String(detalle).slice(0, 200) : null };
  c.seguimiento = { ...c.seguimiento, estado: hito, actualizadoEn: ahora() };
  guardar(); return c;
}
function registrarRetraso(folio, detalle) {
  const c = obtener(folio); if (!c) return null;
  (c.retrasos = c.retrasos || []).push({ en: ahora(), detalle: detalle ? String(detalle).slice(0, 200) : null });
  guardar(); return c;
}
// Datos del operador/unidad — SOLO se guardan para el equipo; nunca se repiten por chat
function guardarOperador(folio, { nombre, placas, telefono }) {
  const c = obtener(folio); if (!c) return null;
  c.operador = { ...(c.operador || {}), ...(nombre ? { nombre: String(nombre).slice(0, 80) } : {}), ...(placas ? { placas: String(placas).slice(0, 30) } : {}), ...(telefono ? { telefono: String(telefono).slice(0, 30) } : {}), en: ahora() };
  guardar(); return c;
}
function marcarChequeo(folio, clave) { const c = obtener(folio); if (!c) return; (c.chequeos = c.chequeos || {})[clave] = ahora(); guardar(); }
function marcarAlertaSeg(folio, clave) { const c = obtener(folio); if (!c) return; (c.alertasSeg = c.alertasSeg || {})[clave] = ahora(); guardar(); }

function cambiarEstado(folio, estado) { const c = obtener(folio); if (!c) return null; c.estado = estado; guardar(); return c; }
function marcarAviso(folio, clave) { const c = obtener(folio); if (!c) return; c.avisos[clave] = ahora(); guardar(); }
function actualizarSeguimiento(folio, parche) {
  const c = obtener(folio); if (!c) return null;
  c.seguimiento = { ...c.seguimiento, ...parche, actualizadoEn: ahora() }; guardar(); return c;
}
function guardarCambios() { guardar(); }

// ── Desempeño de proveedores (base del ranking y de la escalera) ────────────
function estadisticas(telefono) {
  const k = tel10(telefono);
  let contactado = 0, respondio = 0, acepto = 0, colocado = 0, cumplido = 0, retraso = 0;
  const tiempos = [];
  for (const c of todas()) {
    const p = c.proveedores[k]; if (!p) continue;
    contactado++;
    if (p.respondioEn) { respondio++; tiempos.push((new Date(p.respondioEn) - new Date(p.contactadoEn)) / 60000); }
    if (p.estado === 'acepto') acepto++;
    if (c.ganador && tel10(c.ganador.tel) === k) {
      colocado++;
      if (hitoAlcanzado(c, 'cargado')) cumplido++;
      if ((c.retrasos || []).length) retraso++;
    }
  }
  tiempos.sort((a, b) => a - b);
  const mediana = tiempos.length ? tiempos[Math.floor(tiempos.length / 2)] : null;
  // Suavizado (+1/+2): un proveedor nuevo arranca en 0.5, no en 0 ni en 1
  const tasaResp = (respondio + 1) / (contactado + 2);
  const rapidez = mediana == null ? 0.5 : Math.max(0, Math.min(1, 1 - (mediana - 15) / 105)); // ≤15 min = 1, ≥120 min = 0
  const tasaAcepta = (acepto + 1) / (respondio + 2);
  const cumpl = (cumplido + 1) / (colocado + 2);
  const puntaje = +(0.4 * tasaResp + 0.2 * rapidez + 0.2 * tasaAcepta + 0.2 * cumpl).toFixed(3);
  return { contactado, respondio, acepto, colocado, cumplido, retraso, medianaMin: mediana == null ? null : Math.round(mediana), puntaje };
}

const puntaje = telefono => estadisticas(telefono).puntaje;

// ── Comparativo de ofertas y recomendación ──────────────────────────────────
// costo ajustado = precio × (1.10 − 0.10 × puntaje): a precio igual gana el más
// confiable; un proveedor mucho más barato sigue ganando. Es sugerencia — la
// aprobación siempre es de una persona.
function comparativo(c) {
  const filas = Object.values(c.proveedores)
    .filter(p => p.estado === 'acepto')
    .map(p => {
      const st = estadisticas(p.tel);
      const precio = p.oferta?.precio ?? null;
      return { tel: p.tel, nombre: p.nombre, precio, unidad: p.oferta?.unidad || null, notas: p.oferta?.notas || null, puntaje: st.puntaje, medianaMin: st.medianaMin, colocado: st.colocado, retraso: st.retraso,
        ajustado: precio ? precio * (1.10 - 0.10 * st.puntaje) : Infinity };
    })
    .sort((a, b) => a.ajustado - b.ajustado);
  if (filas[0] && filas[0].ajustado !== Infinity) filas[0].recomendado = true;
  return filas;
}

function ranking() {
  const tels = new Map();
  for (const c of todas()) for (const p of Object.values(c.proveedores)) tels.set(tel10(p.tel), p);
  return [...tels.values()].map(p => ({ tel: p.tel, nombre: p.nombre, ...estadisticas(p.tel) })).sort((a, b) => b.puntaje - a.puntaje);
}

// ── Sugerencias que hace un proveedor (rutas / unidades) — las aprueba una persona ─
function agregarSugerencia({ telefono, nombre, tipo, valor }) {
  if (!telefono || !valor || !['ruta_agregar', 'ruta_quitar', 'unidad_agregar'].includes(tipo)) return null;
  const dup = db.sugerencias.find(s => s.estado === 'pendiente' && tel10(s.telefono) === tel10(telefono) && s.tipo === tipo && s.valor.toLowerCase() === String(valor).toLowerCase());
  if (dup) return dup;
  const s = { id: 'SG-' + Date.now().toString(36).toUpperCase(), telefono, nombre: nombre || '', tipo, valor: String(valor).slice(0, 120), estado: 'pendiente', creada: ahora() };
  db.sugerencias.push(s); db.sugerencias = db.sugerencias.slice(-300); guardar();
  return s;
}
const sugerencias = (estado = 'pendiente') => db.sugerencias.filter(s => !estado || s.estado === estado);
function resolverSugerencia(id, estado) { const s = db.sugerencias.find(x => x.id === id); if (!s) return null; s.estado = estado; s.resueltaEn = ahora(); guardar(); return s; }

// ── Base de los KPIs ────────────────────────────────────────────────────────
function kpiBase(fecha = fechaMTY()) {
  const mes = fecha.slice(0, 7);
  const cs = todas();
  const colocadasHoy = cs.filter(c => c.colocadoEn && fechaMTY(c.colocadoEn) === fecha);
  const delDia = new Set([...cs.filter(c => fechaMTY(c.creada) === fecha).map(c => c.folio), ...colocadasHoy.map(c => c.folio)]);
  const colocadasMes = cs.filter(c => c.colocadoEn && fechaMTY(c.colocadoEn).slice(0, 7) === mes);
  return { serviciosDelDia: delDia.size, colocadosHoy: colocadasHoy.length, colocadosMes: colocadasMes.length };
}

const kpiMeta = () => db.kpi;
function kpiGuardar(parche) { db.kpi = { ...db.kpi, ...parche }; guardar(); }

module.exports = {
  fechaMTY, tel10, crear, obtener, todas, abiertas, marcarContactado, porTelefono, registrarRespuesta, registrarOferta, registrarOfertaVapi,
  HITOS, hitoAlcanzado, marcarHito, registrarRetraso, guardarOperador, marcarChequeo, marcarAlertaSeg,
  asignar, cambiarEstado, marcarAviso, actualizarSeguimiento, guardarCambios, estadisticas, puntaje, comparativo, ranking,
  agregarSugerencia, sugerencias, resolverSugerencia, kpiBase, kpiMeta, kpiGuardar,
};
