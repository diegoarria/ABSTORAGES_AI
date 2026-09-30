// ── Reporte de disponibilidad — dos veces al día, email a Diego, Rafael y
// Gabriel ── Lista completa de proveedores con unidades disponibles (fecha,
// ruta, nombre, teléfono), según lo que cada proveedor le fue diciendo a
// SOFIA. Pedido explícito del usuario (29-sep-2026): a las 7:00 AM y a las
// 19:05 (justo después de los KPIs) todos los días.
const fs = require('fs');
const path = require('path');
const colocaciones = require('./colocaciones');
const notifier = require('./notifier');

const HORAS = [
  { hora: Number(process.env.REPORTE_DISPONIBILIDAD_HORA1 || 7),  minuto: Number(process.env.REPORTE_DISPONIBILIDAD_MIN1 || 0),  clave: 'manana' },
  { hora: Number(process.env.REPORTE_DISPONIBILIDAD_HORA2 || 19), minuto: Number(process.env.REPORTE_DISPONIBILIDAD_MIN2 || 5),  clave: 'noche' },
];
// Ventana de tolerancia tras cada hora programada — sin esto, activar o
// reiniciar el servicio a cualquier hora dispara el envío de inmediato en vez
// de esperar al siguiente horario (mismo incidente real de difusionGeneral.js
// del 29-sep-2026, aplicado aquí desde el inicio para no repetirlo).
const VENTANA_MIN = Number(process.env.REPORTE_DISPONIBILIDAD_VENTANA_MIN || 90);

const ESTADO_FILE = path.join(__dirname, '../../data/reporte-disponibilidad-estado.json');
function leerEstado() { try { return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8')); } catch { return {}; } }
function guardarEstado(e) {
  try { fs.mkdirSync(path.dirname(ESTADO_FILE), { recursive: true }); fs.writeFileSync(ESTADO_FILE, JSON.stringify(e)); }
  catch (err) { console.error('[reporteDisponibilidad] no se pudo guardar el estado:', err.message); }
}
// { fecha: 'YYYY-MM-DD', manana: true, noche: true } — persistido en disco
// para que un reinicio el mismo día no repita un reporte ya enviado.
let estado = leerEstado();

function minutosDelDiaMTY() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Monterrey', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, minutos: Number(p.hour) * 60 + Number(p.minute) };
}

// Solo cuenta como "unidad disponible" lo que sigue vigente: no lo ya vencido
// (la fecha pasó sin que SOFIA lo confirmara) ni lo cancelado a mano.
function listaDisponibles() {
  return colocaciones.disponibilidades()
    .filter(d => d.estado === 'pendiente' || d.estado === 'recordada')
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
}

async function enviar() {
  const lista = listaDisponibles();
  await notifier.notificarListaDisponibilidad(lista);
  return lista;
}

async function tick() {
  const { fecha, minutos } = minutosDelDiaMTY();
  if (estado.fecha !== fecha) estado = { fecha };
  for (const h of HORAS) {
    if (estado[h.clave]) continue;
    const inicio = h.hora * 60 + h.minuto;
    if (minutos < inicio || minutos > inicio + VENTANA_MIN) continue;
    estado[h.clave] = true;
    guardarEstado(estado);
    try { await enviar(); console.log(`[reporteDisponibilidad] Reporte de las ${h.hora}:${String(h.minuto).padStart(2, '0')} enviado`); }
    catch (e) { console.error('[reporteDisponibilidad] Error enviando:', e.message); }
  }
}

function iniciar() {
  setInterval(() => tick().catch(e => console.error('[reporteDisponibilidad]', e.message)), 5 * 60 * 1000);
  console.log('[reporteDisponibilidad] Activo — reportes a las 7:00 AM y 19:05 (Monterrey)');
}

module.exports = { iniciar, tick, enviar, listaDisponibles };
