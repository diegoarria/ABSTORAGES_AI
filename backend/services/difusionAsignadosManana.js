// ── Ronda de las 9PM a los proveedores con planner asignado — pregunta por MAÑANA ──
// Pedido explícito del usuario (09-nov-2026): además de la ronda de las 6AM
// (difusionAsignados.js, pregunta por disponibilidad de HOY), todos los días
// a las 9PM Monterrey se les vuelve a escribir a los mismos ~99 proveedores
// con planner asignado, pero preguntando por disponibilidad de MAÑANA — para
// poder apartar la unidad un día antes en vez de enterarse la mañana misma.
//
// Usa ignorarCapDiario (igual que la presentación y el recordatorio de
// disponibilidad, ver whatsappProactivo.js) porque este SÍ es un segundo
// contacto intencional del mismo día — la ronda de las 6AM ya consumió el
// candado de "1 contacto al día" para estos mismos proveedores, y sin esto
// esta ronda nunca mandaría nada (mismo choque que el incidente de Oscar,
// 09-nov-2026). Sigue estando acotada a UNA sola corrida por día (ver
// correrSiToca) — no es un bucle, es un segundo horario fijo, deliberado.
const contactos = require('./contactos');
const whatsappProactivo = require('./whatsappProactivo');
const agentPause = require('./agentPause');
const actividadBus = require('./actividadBus');
const respuestaNocheTracker = require('./respuestaNocheTracker');
const notifier = require('./notifier');
const fs = require('fs');
const path = require('path');

const HORA   = Number(process.env.SOFIA_DIFUSION_ASIGNADOS_MANANA_HORA || 21);
const MINUTO = Number(process.env.SOFIA_DIFUSION_ASIGNADOS_MANANA_MINUTO || 0);
const VENTANA_MIN = Number(process.env.SOFIA_DIFUSION_ASIGNADOS_MANANA_VENTANA_MIN || 120);
const PAUSA_ENTRE_ENVIOS_MS = Number(process.env.SOFIA_DIFUSION_ASIGNADOS_MANANA_PAUSA_MS || 3000);
const CHEQUEO_MS = 15 * 60 * 1000;

const HABILITADO = process.env.SOFIA_DIFUSION_ASIGNADOS_MANANA !== 'false';

// Plantilla "con planner" aprobada por Meta (10-nov-2026): disponibilidad_sofia_planner_manana.
// La "sin planner" (21 proveedores que maneja SOFIA directo) todavía no
// tiene nombre confirmado — queda en null (la ronda la omite para ese
// grupo) hasta que se agregue aquí, sin relleno temporal: el texto de
// "mañana" es distinto al de "hoy", reusar la de hoy diría algo falso.
const SID_CON_PLANNER = process.env.KAPSO_TEMPLATE_DISPONIBILIDAD_PLANNER_MANANA || 'disponibilidad_sofia_planner_manana';
const SID_SIN_PLANNER = process.env.KAPSO_TEMPLATE_DISPONIBILIDAD_DIRECTA_MANANA || null;

const ESTADO_FILE = path.join(__dirname, '../../data/difusion-asignados-manana-estado.json');
function leerEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8')); } catch { return {}; }
}
function guardarEstado(estado) {
  try { fs.mkdirSync(path.dirname(ESTADO_FILE), { recursive: true }); fs.writeFileSync(ESTADO_FILE, JSON.stringify(estado)); }
  catch (e) { console.error('[difusionAsignadosManana] no se pudo guardar el estado:', e.message); }
}
let ultimaFechaEnviada = leerEstado().ultimaFechaEnviada || null;
function guardarUltimaFecha(fecha) {
  const estado = leerEstado();
  estado.ultimaFechaEnviada = fecha;
  guardarEstado(estado);
}

function horaYFechaMTY() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Monterrey', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, minutosDelDia: Number(p.hour) * 60 + Number(p.minute) };
}

const titulo = s => String(s || '').trim().split(/\s+/)[0].toLowerCase().replace(/^./, c => c.toUpperCase());
const feed = e => actividadBus.emitir({ agente: 'SOFIA', ...e });

// Misma lista que difusionAsignados.js (duplicada a propósito, igual que ese
// archivo ya duplica criterio de otros — mantiene cada ronda independiente
// y fácil de apagar sin tocar la otra).
async function proveedoresAsignados() {
  const bd = await contactos.listarPorAgente('SOFIA', { tipo: 'proveedor' });
  return bd
    .filter(c => c.telefono && c.planner_asignado && !/Estatus en catálogo: (Baja|Suspendido)/i.test(c.notas || ''))
    .map(c => ({ id: c.id, nombre: c.nombre_completo, empresa: c.empresa, telefono: c.telefono, planner: c.planner_asignado }));
}

// Simulación — arma la lista completa (proveedor, plantilla exacta,
// variables exactas, texto que registraría en memoria) SIN llamar a Kapso
// ni mandar nada real. Pedido explícito del usuario (10-nov-2026): antes de
// soltar una plantilla nueva a los 99 de una sola vez, poder revisarla.
async function simularRonda() {
  let lista;
  try { lista = await proveedoresAsignados(); } catch (e) { return { ok: false, motivo: 'error_lista', error: e.message }; }
  const plan = [];
  let sinPlantilla = 0;
  for (const p of lista) {
    const esSofia = p.planner === 'SOFIA';
    const nombre = titulo(p.nombre);
    if (esSofia) {
      if (!SID_SIN_PLANNER) { sinPlantilla++; continue; }
      plan.push({ telefono: p.telefono, nombre: p.nombre, planner: p.planner, contentSid: SID_SIN_PLANNER, variables: { '1': nombre }, textoEjemplo: `Hola ${nombre}, soy SOFIA de ABSTORAGES. ¿Qué unidades tendrás disponibles mañana? Cuéntame qué ruta o rutas tienes para apartarte la unidad desde hoy y buscar conectarte con nuestros clientes.` });
    } else {
      if (!SID_CON_PLANNER) { sinPlantilla++; continue; }
      plan.push({ telefono: p.telefono, nombre: p.nombre, planner: p.planner, contentSid: SID_CON_PLANNER, variables: { '1': nombre, '2': p.planner }, textoEjemplo: `Hola ${nombre}, soy SOFIA, asistente de ${p.planner} en ABSTORAGES. ¿Qué unidades tendrás disponibles mañana? Cuéntame la ruta para apartártela desde hoy y buscar conectarte con nuestros clientes.` });
    }
  }
  return { ok: true, total: lista.length, seMandarian: plan.length, sinPlantilla, plan };
}

async function ejecutarRonda() {
  if (agentPause.estaPausado('sofia')) return { ok: false, motivo: 'pausado' };
  if (!SID_CON_PLANNER && !SID_SIN_PLANNER) {
    console.warn('[difusionAsignadosManana] Ninguna plantilla de "mañana" está configurada — se omite la ronda');
    return { ok: false, motivo: 'plantillas_no_configuradas' };
  }
  let lista;
  try { lista = await proveedoresAsignados(); } catch (e) { console.error('[difusionAsignadosManana] Error armando la lista:', e.message); return { ok: false, motivo: 'error_lista' }; }
  if (!lista.length) { feed({ tipo: 'DIFUSION_ASIGNADOS_MANANA', mensaje: 'Ronda 9PM (disponibilidad de mañana): nadie tiene planner asignado todavía' }); return { ok: true, enviados: 0, total: 0 }; }

  feed({ tipo: 'DIFUSION_ASIGNADOS_MANANA', mensaje: `Ronda 9PM — preguntando disponibilidad de mañana a ${lista.length} proveedores, uno tras otro` });

  let enviados = 0, sinCredito = 0, fallidos = 0, sinPlantilla = 0;
  for (const p of lista) {
    try {
      const esSofia = p.planner === 'SOFIA';
      if (esSofia && !SID_SIN_PLANNER) { sinPlantilla++; continue; } // plantilla "sin planner" aún no confirmada
      let contentSid, variables, textoEnviado;
      const nombre = titulo(p.nombre);
      if (esSofia) {
        contentSid = SID_SIN_PLANNER;
        variables = { '1': nombre };
        textoEnviado = `Hola ${nombre}, soy SOFIA de ABSTORAGES. ¿Qué unidades tendrás disponibles mañana? Cuéntame qué ruta o rutas tienes para apartarte la unidad desde hoy y buscar conectarte con nuestros clientes.`;
      } else {
        if (!SID_CON_PLANNER) { sinPlantilla++; continue; } // plantilla "con planner" aún no confirmada
        contentSid = SID_CON_PLANNER;
        variables = { '1': nombre, '2': p.planner };
        textoEnviado = `Hola ${nombre}, soy SOFIA, asistente de ${p.planner} en ABSTORAGES. ¿Qué unidades tendrás disponibles mañana? Cuéntame la ruta para apartártela desde hoy y buscar conectarte con nuestros clientes.`;
      }
      // ignorarCapDiario: ver nota al inicio del archivo — este es un
      // segundo contacto intencional del mismo día, distinto en propósito
      // al de la ronda de las 6AM.
      const r = await whatsappProactivo.enviarPlantillaSinCandado('sofia', p.telefono, contentSid, variables, { ignorarCapDiario: true });
      if (r?.status === 'rate_limited') { sinCredito = lista.length - enviados - fallidos; break; }
      if (r?.status === 'paused') break;
      if (r?.status === 'baneado') continue; // está baneado — no cuenta como falla ni como enviado
      enviados++;
      whatsappProactivo.registrarEnMemoria?.('sofia', p.telefono, textoEnviado);
      contactos.upsertContacto({ agente: 'sofia', telefono: p.telefono, resumen_interaccion: 'Ronda 9PM — disponibilidad de mañana', canal: 'whatsapp-plantilla' }).catch(() => {});
      // Pedido explícito del usuario (10-nov-2026): si contesta a este
      // mensaje, la ronda de las 6AM de mañana ya no debe volver a
      // escribirle — ver respuestaNocheTracker.js.
      respuestaNocheTracker.marcarEnvioNoche(p.telefono);
    } catch (e) { fallidos++; console.error(`[difusionAsignadosManana] Error mandando a ${p.nombre}:`, e.message); }
    await new Promise(res => setTimeout(res, PAUSA_ENTRE_ENVIOS_MS));
  }

  const resumen = `Ronda 9PM (disponibilidad de mañana): ${enviados} enviados de ${lista.length}${sinPlantilla ? ` · ${sinPlantilla} omitidos por falta de plantilla` : ''}${sinCredito ? ` · ${sinCredito} sin enviar por tope diario` : ''}${fallidos ? ` · ${fallidos} con error` : ''}.`;
  feed({ tipo: 'DIFUSION_ASIGNADOS_MANANA', mensaje: resumen });
  notifier.notificarAlerta({ title: 'SOFIA — Ronda 9PM (disponibilidad de mañana)', body: resumen, tipo: 'DIFUSION_ASIGNADOS_MANANA' }).catch(() => {});
  console.log(`[difusionAsignadosManana] ${resumen}`);
  return { ok: true, enviados, total: lista.length, sinCredito, fallidos, resumen };
}

async function correrSiToca() {
  if (!HABILITADO) return;
  const { fecha, minutosDelDia } = horaYFechaMTY();
  const inicioMin = HORA * 60 + MINUTO;
  if (minutosDelDia < inicioMin || minutosDelDia > inicioMin + VENTANA_MIN) return;
  if (ultimaFechaEnviada === fecha) return;
  ultimaFechaEnviada = fecha; // se marca antes de correr — un fallo a medias no la reintenta en bucle
  guardarUltimaFecha(fecha);
  await ejecutarRonda();
}

async function dispararManual() {
  const { fecha } = horaYFechaMTY();
  ultimaFechaEnviada = fecha;
  guardarUltimaFecha(fecha);
  return ejecutarRonda();
}

function iniciar() {
  if (!HABILITADO) { console.log('[difusionAsignadosManana] Desactivado (SOFIA_DIFUSION_ASIGNADOS_MANANA=false)'); return; }
  setInterval(() => correrSiToca().catch(e => console.error('[difusionAsignadosManana]', e.message)), CHEQUEO_MS);
  correrSiToca().catch(() => {});
  console.log(`[difusionAsignadosManana] Activo — proveedores con planner asignado, preguntando disponibilidad de mañana a partir de las ${HORA}:${String(MINUTO).padStart(2, '0')} (Monterrey)`);
}

module.exports = { iniciar, correrSiToca, dispararManual, proveedoresAsignados, ejecutarRonda, simularRonda };
