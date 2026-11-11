// ── Ronda diaria a los proveedores con planner asignado ─────────────────────
// Pedido explícito del usuario (03-nov-2026, plantillas confirmadas y
// activadas 04-nov-2026): todos los días a las 6:00 AM Monterrey, sin falla,
// a los ~99 proveedores que ya tienen un planner asignado (78 con
// Abigail/Gabriel/Claudia/Yamilet usando disponibilidad_sofia_planner, y 21
// que SOFIA maneja directo en su propia cuenta usando
// disponibilidad_sofia_general_v5 — ver SID_CON_PLANNER/SID_SIN_PLANNER más
// abajo). Si alguna de las dos llegara a dejar de estar aprobada, cae de
// vuelta sola a la plantilla general rotativa como relleno temporal.
//
// A diferencia de las 3 rondas automáticas eliminadas para siempre el mismo
// día (difusionGeneral.js — Top 100 y piloto por horario — y
// sofiaScheduler.js), esta es una lista fija y chica (la que el usuario armó
// a mano con los PDFs de catálogo), no 100 proveedores por volumen ni una
// lista blanca de piloto — por eso es una ronda nueva y separada, no una
// reactivación de las que se borraron.
const contactos = require('./contactos');
const whatsappProactivo = require('./whatsappProactivo');
const agentPause = require('./agentPause');
const actividadBus = require('./actividadBus');
const notifier = require('./notifier');
const respuestaNocheTracker = require('./respuestaNocheTracker');
const fs = require('fs');
const path = require('path');

// Horario definitivo (04-nov-2026): 6:00 AM Monterrey, todos los días.
// Cambiar con SOFIA_DIFUSION_ASIGNADOS_HORA/MINUTO en el entorno si se
// necesita ajustar sin tocar código — solo hace falta redeploy.
const HORA   = Number(process.env.SOFIA_DIFUSION_ASIGNADOS_HORA || 6);
const MINUTO = Number(process.env.SOFIA_DIFUSION_ASIGNADOS_MINUTO || 0);
const VENTANA_MIN = Number(process.env.SOFIA_DIFUSION_ASIGNADOS_VENTANA_MIN || 180); // tolerancia amplia: el horario aún no está decidido
const PAUSA_ENTRE_ENVIOS_MS = Number(process.env.SOFIA_DIFUSION_ASIGNADOS_PAUSA_MS || 3000);
const CHEQUEO_MS = 15 * 60 * 1000;

// Kill switch real — a diferencia de las rondas borradas, esta SÍ se pide
// encendida por default ("todos los días sin falla"). Para apagarla de
// emergencia sin esperar un redeploy, usa la pausa de agente ya existente
// (ver agentPause.js / botón de pausar SOFIA en el portal) — eso corta el
// envío real aquí abajo en el mismo punto que corta todo lo demás de SOFIA.
const HABILITADO = process.env.SOFIA_DIFUSION_ASIGNADOS !== 'false';

const TEXTO_VARIANTE = [
  'Hola {nombre}, buenos días. Soy SOFIA de ABSTORAGES. ¿Qué unidad tienes disponible hoy? Cuéntame la ruta y el tipo, para tenerte en cuenta en cuanto tengamos carga que te acomode.',
  'Buenos días {nombre}, soy SOFIA de ABSTORAGES. ¿Tendrás unidad disponible hoy? Si tienes algo libre, cuéntame en qué ruta y qué tipo de caja, para avisarte en cuanto tengamos algo para ti.',
  'Hola {nombre}, buen día — habla SOFIA de ABSTORAGES. ¿Hoy cuentas con unidad disponible? Si es así, dime la ruta y el tipo de caja para tenerte en mente.',
  'Hola {nombre}, ¿qué tal? Soy SOFIA de ABSTORAGES Logistics. Te escribo para ver si tienes unidad libre hoy — compárteme ruta y tipo de caja para tomarte en cuenta en lo que tengamos disponible.',
];
const NOMBRES_PLANTILLA_GENERAL = ['disponibilidad_general_sofia', 'disponibilidad_general_sofia_v2', 'disponibilidad_general_sofia_v3', 'disponibilidad_general_sofia_v4'];
const VARIANTES_GENERAL = [0, 1, 2, 3].map(i => ({
  sid: process.env[`KAPSO_TEMPLATE_DISPONIBILIDAD_GENERAL_${i + 1}`] || NOMBRES_PLANTILLA_GENERAL[i],
  texto: TEXTO_VARIANTE[i],
}));

// Plantillas aprobadas por Meta (04-nov-2026): disponibilidad_sofia_planner
// para los 78 proveedores con planner humano asignado (Abigail/Gabriel/
// Claudia/Yamilet), disponibilidad_sofia_general_v5 para los 21 que SOFIA
// maneja en su propia cuenta. Se puede sobreescribir por entorno sin tocar
// código vía KAPSO_TEMPLATE_DISPONIBILIDAD_PLANNER / _DIRECTA.
const SID_CON_PLANNER = process.env.KAPSO_TEMPLATE_DISPONIBILIDAD_PLANNER || 'disponibilidad_sofia_planner';
const SID_SIN_PLANNER = process.env.KAPSO_TEMPLATE_DISPONIBILIDAD_DIRECTA || 'disponibilidad_sofia_general_v5';

const ESTADO_FILE = path.join(__dirname, '../../data/difusion-asignados-estado.json');
function leerEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8')); } catch { return {}; }
}
function guardarEstado(estado) {
  try { fs.mkdirSync(path.dirname(ESTADO_FILE), { recursive: true }); fs.writeFileSync(ESTADO_FILE, JSON.stringify(estado)); }
  catch (e) { console.error('[difusionAsignados] no se pudo guardar el estado:', e.message); }
}
let ultimaFechaEnviada = leerEstado().ultimaFechaEnviada || null;
function guardarUltimaFecha(fecha) {
  const estado = leerEstado();
  estado.ultimaFechaEnviada = fecha;
  guardarEstado(estado);
}
// Rota por día entre las 4 variantes de la plantilla general — mismo
// criterio que ya se usaba en difusionGeneral.js (solo aplica mientras no
// haya plantilla nueva aprobada y se esté usando el relleno temporal).
let ultimaVarianteIndex = Number.isInteger(leerEstado().ultimaVarianteIndex) ? leerEstado().ultimaVarianteIndex : -1;
function siguienteVarianteGeneral() {
  ultimaVarianteIndex = (ultimaVarianteIndex + 1) % VARIANTES_GENERAL.length;
  const estado = leerEstado();
  estado.ultimaVarianteIndex = ultimaVarianteIndex;
  guardarEstado(estado);
  return VARIANTES_GENERAL[ultimaVarianteIndex];
}

function horaYFechaMTY() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Monterrey', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, minutosDelDia: Number(p.hour) * 60 + Number(p.minute) };
}

const titulo = s => String(s || '').trim().split(/\s+/)[0].toLowerCase().replace(/^./, c => c.toUpperCase());
const feed = e => actividadBus.emitir({ agente: 'SOFIA', ...e });

// Todos los proveedores con planner_asignado (humano o "SOFIA") — la lista
// que el usuario armó a mano, no un criterio calculado como el Top 100.
async function proveedoresAsignados() {
  const bd = await contactos.listarPorAgente('SOFIA', { tipo: 'proveedor' });
  return bd
    .filter(c => c.telefono && c.planner_asignado && !/Estatus en catálogo: (Baja|Suspendido)/i.test(c.notas || ''))
    .map(c => ({ id: c.id, nombre: c.nombre_completo, empresa: c.empresa, telefono: c.telefono, planner: c.planner_asignado }));
}

async function ejecutarRonda() {
  if (agentPause.estaPausado('sofia')) return { ok: false, motivo: 'pausado' };
  let lista;
  try { lista = await proveedoresAsignados(); } catch (e) { console.error('[difusionAsignados] Error armando la lista:', e.message); return { ok: false, motivo: 'error_lista' }; }
  if (!lista.length) { feed({ tipo: 'DIFUSION_ASIGNADOS', mensaje: 'Ronda diaria a proveedores con planner: nadie tiene planner asignado todavía' }); return { ok: true, enviados: 0, total: 0 }; }

  // Variante general del día (relleno temporal mientras no haya plantillas nuevas aprobadas)
  const varianteGeneral = (!SID_CON_PLANNER || !SID_SIN_PLANNER) ? siguienteVarianteGeneral() : null;

  feed({ tipo: 'DIFUSION_ASIGNADOS', mensaje: `Ronda diaria a proveedores con planner asignado — empezando con ${lista.length} proveedores, uno tras otro` });

  let enviados = 0, sinCredito = 0, fallidos = 0, yaContestoAnoche = 0;
  for (const p of lista) {
    try {
      // Pedido explícito del usuario (10-nov-2026): si ya contestó la
      // difusión de las 9PM de anoche, no se le vuelve a escribir en la de
      // las 6AM — se espera hasta la ronda de las 9PM de hoy.
      if (respuestaNocheTracker.yaRespondioALaNoche(p.telefono)) { yaContestoAnoche++; continue; }
      const esSofia = p.planner === 'SOFIA';
      let contentSid, variables, textoEnviado;
      if (esSofia) {
        if (SID_SIN_PLANNER) {
          contentSid = SID_SIN_PLANNER;
          variables = { '1': titulo(p.nombre) };
          textoEnviado = `Hola ${titulo(p.nombre)}, soy SOFIA de ABSTORAGES. ¿Qué unidades tienes libres para hoy? Cuéntame qué ruta o rutas tienes y buscaremos conectarte con nuestros clientes hoy. Si no se logra hoy, por favor sígueme enviando tus disponibilidades para buscar conectarte los próximos días.`;
        } else {
          contentSid = varianteGeneral.sid;
          variables = { '1': titulo(p.nombre) };
          textoEnviado = varianteGeneral.texto.replace('{nombre}', titulo(p.nombre));
        }
      } else {
        if (SID_CON_PLANNER) {
          contentSid = SID_CON_PLANNER;
          variables = { '1': titulo(p.nombre), '2': p.planner };
          textoEnviado = `Hola ${titulo(p.nombre)}, soy SOFIA, asistente de ${p.planner} en ABSTORAGES. ¿Qué unidades tienes libres para hoy? Cuéntame qué ruta o rutas tienes y buscaremos conectarte con nuestros clientes hoy. Si no se logra hoy, por favor sígueme enviando tus disponibilidades para buscar conectarte los próximos días.`;
        } else {
          // Relleno temporal: todavía no menciona al planner, porque la
          // plantilla aprobada hoy no tiene esa variable.
          contentSid = varianteGeneral.sid;
          variables = { '1': titulo(p.nombre) };
          textoEnviado = varianteGeneral.texto.replace('{nombre}', titulo(p.nombre));
        }
      }
      const r = await whatsappProactivo.enviarPlantillaSinCandado('sofia', p.telefono, contentSid, variables);
      if (r?.status === 'rate_limited') { sinCredito = lista.length - enviados - fallidos; break; }
      if (r?.status === 'paused') break;
      if (r?.status === 'ya_contactado_hoy' || r?.status === 'baneado') continue; // ya se le escribió hoy por otro motivo, o está baneado — ninguno cuenta como falla ni como enviado
      enviados++;
      whatsappProactivo.registrarEnMemoria?.('sofia', p.telefono, textoEnviado);
      contactos.upsertContacto({ agente: 'sofia', telefono: p.telefono, resumen_interaccion: 'Ronda diaria a proveedores con planner asignado', canal: 'whatsapp-plantilla' }).catch(() => {});
    } catch (e) { fallidos++; console.error(`[difusionAsignados] Error mandando a ${p.nombre}:`, e.message); }
    await new Promise(res => setTimeout(res, PAUSA_ENTRE_ENVIOS_MS));
  }

  const resumen = `Ronda diaria a proveedores con planner: ${enviados} enviados de ${lista.length}${yaContestoAnoche ? ` · ${yaContestoAnoche} saltados (ya habían contestado la ronda de las 9PM)` : ''}${sinCredito ? ` · ${sinCredito} sin enviar por tope diario` : ''}${fallidos ? ` · ${fallidos} con error` : ''}${!SID_CON_PLANNER || !SID_SIN_PLANNER ? ' · usando plantilla general (las nuevas con/sin planner aún no están configuradas)' : ''}.`;
  feed({ tipo: 'DIFUSION_ASIGNADOS', mensaje: resumen });
  notifier.notificarAlerta({ title: 'SOFIA — Ronda diaria a proveedores con planner', body: resumen, tipo: 'DIFUSION_ASIGNADOS' }).catch(() => {});
  console.log(`[difusionAsignados] ${resumen}`);
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

// Disparo manual — por si el usuario quiere mandarla ya en vez de esperar
// al horario programado, el mismo día. Mismo criterio que dispararManual
// en difusionGeneral.js.
async function dispararManual() {
  const { fecha } = horaYFechaMTY();
  ultimaFechaEnviada = fecha;
  guardarUltimaFecha(fecha);
  return ejecutarRonda();
}

function iniciar() {
  if (!HABILITADO) { console.log('[difusionAsignados] Desactivado (SOFIA_DIFUSION_ASIGNADOS=false)'); return; }
  setInterval(() => correrSiToca().catch(e => console.error('[difusionAsignados]', e.message)), CHEQUEO_MS);
  correrSiToca().catch(() => {}); // por si el server arranca ya pasada la hora
  console.log(`[difusionAsignados] Activo — proveedores con planner asignado, a partir de las ${HORA}:${String(MINUTO).padStart(2, '0')} (Monterrey)`);
}

module.exports = { iniciar, correrSiToca, dispararManual, proveedoresAsignados, ejecutarRonda };
