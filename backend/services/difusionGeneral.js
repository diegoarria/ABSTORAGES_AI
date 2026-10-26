// ── Difusión general de disponibilidad — 5:30 AM hora de Monterrey ──────────
// Pedido explícito del usuario (06-oct-2026): todos los días a partir de esa
// hora, SOFIA le manda la plantilla de disponibilidad general SOLO a los
// proveedores que cubren alguna de las 50 rutas más importantes de la Base
// de Datos (backend/data/proveedores-top50-rutas.json) — uno tras otro, sin
// esperar respuesta de nadie antes de seguir con el siguiente. Si un
// proveedor cubre varias de esas 50 rutas, le llega UN solo mensaje, nunca
// uno por ruta (la lista ya sale deduplicada por teléfono).
//
// Apagado por default — requiere SOFIA_DIFUSION_GENERAL=true en el entorno,
// mismo criterio que sofiaScheduler.js/noaScheduler.js: un envío masivo diario
// automático a personas reales no se activa solo.
const fs = require('fs');
const path = require('path');
const contactos = require('./contactos');
const rutasProveedor = require('./rutasProveedor');
const whatsappProactivo = require('./whatsappProactivo');
const agentPause = require('./agentPause');
const actividadBus = require('./actividadBus');
const notifier = require('./notifier');

// Reactivada a pedido explícito del usuario (06-oct-2026) — ya no se detiene
// aquí; el único apagador real es SOFIA_DIFUSION_GENERAL en el entorno.
const HABILITADO = process.env.SOFIA_DIFUSION_GENERAL === 'true';
const HORA   = Number(process.env.SOFIA_DIFUSION_GENERAL_HORA || 5);
const MINUTO = Number(process.env.SOFIA_DIFUSION_GENERAL_MINUTO || 30);
const PAUSA_ENTRE_ENVIOS_MS = Number(process.env.SOFIA_DIFUSION_GENERAL_PAUSA_MS || 3000);
// 4 variaciones de texto en vez de una sola plantilla fija — pedido explícito
// del usuario (05-oct-2026): si siempre es el mismo mensaje, se nota que es un
// bot y se pierde confianza. Rotación por DÍA, no por proveedor (pedido
// explícito del usuario, 20-oct-2026): toda la corrida de un día usa UNA sola
// variante — hoy v1, mañana v2, pasado v3, v4, y vuelve a v1 — en vez de
// repartir las 4 entre los proveedores de la misma corrida (ver
// siguienteVariante() más abajo). Las 4 ya están APPROVED en Meta.
const TEXTO_VARIANTE = [
  'Hola {nombre}, buenos días. Soy SOFIA de ABSTORAGES. ¿Qué unidad tienes disponible hoy? Cuéntame la ruta y el tipo, para tenerte en cuenta en cuanto tengamos carga que te acomode.',
  'Buenos días {nombre}, soy SOFIA de ABSTORAGES. ¿Tendrás unidad disponible hoy? Si tienes algo libre, cuéntame en qué ruta y qué tipo de caja, para avisarte en cuanto tengamos algo para ti.',
  'Hola {nombre}, buen día — habla SOFIA de ABSTORAGES. ¿Hoy cuentas con unidad disponible? Si es así, dime la ruta y el tipo de caja para tenerte en mente.',
  'Hola {nombre}, ¿qué tal? Soy SOFIA de ABSTORAGES Logistics. Te escribo para ver si tienes unidad libre hoy — compárteme ruta y tipo de caja para tomarte en cuenta en lo que tengamos disponible.',
];
const NOMBRES_PLANTILLA = ['disponibilidad_general_sofia', 'disponibilidad_general_sofia_v2', 'disponibilidad_general_sofia_v3', 'disponibilidad_general_sofia_v4'];
const VARIANTES = [0, 1, 2, 3].map(i => ({
  sid: process.env[`KAPSO_TEMPLATE_DISPONIBILIDAD_GENERAL_${i + 1}`] || NOMBRES_PLANTILLA[i],
  texto: TEXTO_VARIANTE[i],
}));
// disponibilidad_general_sofia (v1) siempre está aprobada — nunca se queda sin plantilla.
const CONTENT_SID_FALLBACK = NOMBRES_PLANTILLA[0];
const CHEQUEO_MS = 15 * 60 * 1000;
// Ventana de tolerancia tras la hora programada — solo dentro de este rango se
// considera "toca mandar hoy". Sin esto, prender la función (o que el server
// se reinicie) a cualquier hora del día dispara el envío de inmediato en vez
// de esperar al día siguiente — esto fue un incidente real (29-sep-2026).
const VENTANA_MIN = Number(process.env.SOFIA_DIFUSION_GENERAL_VENTANA_MIN || 90);

const ESTADO_FILE = path.join(__dirname, '../../data/difusion-general-estado.json');
function leerEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8')); } catch { return {}; }
}
function guardarEstado(estado) {
  try { fs.mkdirSync(path.dirname(ESTADO_FILE), { recursive: true }); fs.writeFileSync(ESTADO_FILE, JSON.stringify(estado)); } catch (e) { console.error('[difusionGeneral] no se pudo guardar el estado:', e.message); }
}
// 'YYYY-MM-DD' Monterrey — evita doble corrida el mismo día, incluso si el
// servidor se reinicia (persistido en disco, no solo en memoria).
let ultimaFechaEnviada = leerEstado().ultimaFechaEnviada || null;
function guardarUltimaFecha(fecha) {
  const estado = leerEstado();
  estado.ultimaFechaEnviada = fecha;
  guardarEstado(estado);
}
// Índice de la última variante usada — pedido explícito del usuario
// (20-oct-2026): ya no se rota por proveedor dentro de una misma corrida,
// se rota por DÍA — toda la corrida usa UNA sola variante, y la siguiente
// corrida (sea la programada o un disparo manual) usa la que sigue en el
// ciclo v1 → v2 → v3 → v4 → v1...
let ultimaVarianteIndex = Number.isInteger(leerEstado().ultimaVarianteIndex) ? leerEstado().ultimaVarianteIndex : -1;
function siguienteVariante() {
  ultimaVarianteIndex = (ultimaVarianteIndex + 1) % VARIANTES.length;
  const estado = leerEstado();
  estado.ultimaVarianteIndex = ultimaVarianteIndex;
  guardarEstado(estado);
  return VARIANTES[ultimaVarianteIndex];
}

function horaYFechaMTY() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Monterrey', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, minutosDelDia: Number(p.hour) * 60 + Number(p.minute) };
}

// Los 100 proveedores más importantes de la Base de Datos — pedido explícito
// del usuario (20-oct-2026), reemplaza el criterio anterior (Top 50 rutas).
// "Importante" = volumen real de servicios colocados con ABSTORAGES, sumado
// sobre TODAS sus rutas (campo c.tarifas: "Ruta: $X mínimo · N servicio(s)
// colocados | ..."), mismo criterio ya usado y validado con el usuario para
// la lista de 50 proveedores que se contactó por el cambio de número de
// SOFIA (16-oct-2026) — no la cantidad de rutas que cubre, el volumen real.
function volumenServicios(c) {
  const tarifas = String(c.tarifas || '');
  let total = 0;
  for (const chunk of tarifas.split('|')) {
    const m = chunk.match(/(\d+)\s*servicio/);
    if (m) total += Number(m[1]);
  }
  return total;
}

// Deduplicados por teléfono, ordenados por volumen descendente, top 100.
async function proveedoresTop100() {
  const bd = await contactos.listarPorAgente('SOFIA', { tipo: 'proveedor' });
  return bd
    .filter(c => c.telefono && !/Estatus en catálogo: (Baja|Suspendido)/i.test(c.notas || ''))
    .map(c => ({ id: c.id, nombre: c.nombre_completo, empresa: c.empresa, telefono: c.telefono, volumen: volumenServicios(c) }))
    .sort((a, b) => b.volumen - a.volumen)
    .slice(0, 100);
}

// ── Difusión ad-hoc para UNA ruta específica, pedida por el equipo por
// WhatsApp (pedido explícito del usuario, 19-oct-2026) — "necesito difusión
// para la ruta X - Y". A diferencia de la difusión general (Top 50, solo
// Diego), esta la puede pedir cualquiera del equipo verificado, y el universo
// de proveedores se arma al vuelo según la ruta pedida, no de una lista fija.
// Pedido explícito del usuario (26-oct-2026): esta difusión ad-hoc usaba un
// match de texto literal propio (si el proveedor tenía "Santa Catarina"
// guardado y se pedía "Monterrey", no emparejaba — nadie salía en la lista
// aunque Santa Catarina SÍ es zona metropolitana de Monterrey). El flujo real
// de requerimientos (buscarUnidadParaOrden en server-lite.js) ya resuelve
// esto bien con rutasProveedor.js (agrupa por zona metropolitana/estado) —
// se unifica aquí para que las dos vías usen el mismo criterio, en vez de
// mantener dos lógicas de match distintas que pueden desalinearse.
async function proveedoresPorRuta(origen, destino) {
  if (!String(origen || '').trim() || !String(destino || '').trim()) return [];
  const bd = await contactos.listarPorAgente('SOFIA', { tipo: 'proveedor' });
  return bd.filter(c => {
    if (!c.telefono || /Estatus en catálogo: (Baja|Suspendido)/i.test(c.notas || '')) return false;
    if (!String(c.rutas || '').trim()) return false;
    return rutasProveedor.cubreRuta(c.rutas, origen, destino).ok;
  }).map(c => ({ id: c.id, nombre: c.nombre_completo, empresa: c.empresa, telefono: c.telefono }));
}

// Manda la plantilla de disponibilidad (ya aprobada: disponibilidad_unidad_sofia)
// a cada proveedor que cubre la ruta pedida, uno tras otro. "cliente" es opcional
// — pedido explícito del usuario (23-oct-2026): si se da, se guarda en la memoria
// de CADA proveedor contactado (ver whatsappProactivo.preguntarDisponibilidad)
// para que SOFIA nunca vuelva a preguntar nombre/ruta/fecha/unidad cuando
// contesten — ya se los dio ella en el mensaje que mandó.
async function dispararPorRuta({ origen, destino, fecha, tipo_carga, cliente }) {
  if (agentPause.estaPausado('sofia')) return { ok: false, motivo: 'pausado' };
  let lista;
  try { lista = await proveedoresPorRuta(origen, destino); }
  catch (e) { console.error('[difusionGeneral] Error armando lista por ruta:', e.message); return { ok: false, motivo: 'error_lista' }; }
  if (!lista.length) return { ok: true, enviados: 0, total: 0 };

  // Cliente top5 — pedido explícito del usuario (26-oct-2026): búsqueda con
  // urgencia real, manda más rápido en vez de esperar la pausa normal entre envíos.
  const perfil = cliente ? await contactos.obtenerPerfilClientePorNombre(cliente).catch(() => null) : null;
  const esTop5 = perfil?.prioridad === 'top5';
  const pausaMs = esTop5 ? Math.min(1000, PAUSA_ENTRE_ENVIOS_MS) : PAUSA_ENTRE_ENVIOS_MS;

  feed({ tipo: 'DIFUSION_RUTA_EQUIPO', mensaje: `${esTop5 ? '🔴 URGENTE (cliente top5) — ' : ''}Difusión por ruta ${origen} → ${destino}${cliente ? ` (cliente: ${cliente})` : ''} — empezando con ${lista.length} proveedores` });

  let enviados = 0, fallidos = 0;
  for (const p of lista) {
    try {
      const r = await whatsappProactivo.preguntarDisponibilidad(p, { ruta: `${origen} → ${destino}`, origen, destino, tipo_unidad: tipo_carga, fecha_carga: fecha, empresa: cliente, prioridad: perfil?.prioridad, exigencia_calidad: perfil?.exigencia_calidad });
      if (r?.status === 'rate_limited' || r?.status === 'paused') break;
      enviados++;
    } catch (e) { fallidos++; console.error(`[difusionGeneral] Error mandando a ${p.nombre}:`, e.message); }
    await new Promise(res => setTimeout(res, pausaMs));
  }
  const resumen = `Difusión ruta ${origen} → ${destino}: ${enviados} enviados de ${lista.length}${fallidos ? ` · ${fallidos} con error` : ''}.`;
  feed({ tipo: 'DIFUSION_RUTA_EQUIPO', mensaje: resumen });
  console.log(`[difusionGeneral] ${resumen}`);
  return { ok: true, enviados, total: lista.length, fallidos, resumen };
}

const titulo = s => String(s || '').trim().split(/\s+/)[0].toLowerCase().replace(/^./, c => c.toUpperCase());
const feed = e => actividadBus.emitir({ agente: 'SOFIA', ...e });

// Arma la lista y manda, uno por uno — usado tanto por la corrida programada
// (correrSiToca) como por el disparo manual de Diego por WhatsApp
// (dispararManual, ver server-lite.js: "manda/lanza la difusión general").
async function ejecutarDifusion() {
  if (agentPause.estaPausado('sofia')) return { ok: false, motivo: 'pausado' };
  const usaVariantes = VARIANTES.length > 0;
  if (!usaVariantes && !CONTENT_SID_FALLBACK) { console.warn('[difusionGeneral] Ninguna plantilla de disponibilidad configurada — se omite'); return { ok: false, motivo: 'sin_plantilla' }; }

  let lista;
  try { lista = await proveedoresTop100(); } catch (e) { console.error('[difusionGeneral] Error armando la lista:', e.message); return { ok: false, motivo: 'error_lista' }; }
  if (!lista.length) { feed({ tipo: 'DISPONIBILIDAD_DIARIA', mensaje: 'Difusión general: no hay proveedores con teléfono en la Base de Datos' }); return { ok: true, enviados: 0, total: 0 }; }

  // Una sola variante para TODA la corrida (pedido explícito del usuario,
  // 20-oct-2026): ya no rota por proveedor dentro de la misma corrida — rota
  // por DÍA. Esta corrida usa la que sigue en el ciclo v1→v2→v3→v4→v1...,
  // persistido en disco para que sobreviva un redeploy/reinicio del server.
  const variante = usaVariantes ? siguienteVariante() : null;
  feed({ tipo: 'DISPONIBILIDAD_DIARIA', mensaje: `Difusión general de disponibilidad (Top 100 proveedores) — variante "${variante?.sid || CONTENT_SID_FALLBACK}" — empezando con ${lista.length} proveedores, uno tras otro` });

  let enviados = 0, sinCredito = 0, fallidos = 0;
  for (const p of lista) {
    try {
      const CONTENT_SID = variante ? variante.sid : CONTENT_SID_FALLBACK;
      const variables = variante
        ? { '1': titulo(p.nombre) }
        : { '1': titulo(p.nombre), '2': 'cualquier tipo de unidad', '3': 'cualquier origen', '4': 'cualquier destino', '5': 'hoy' };
      const r = await whatsappProactivo.enviarPlantillaSinCandado('sofia', p.telefono, CONTENT_SID, variables);
      if (r?.status === 'rate_limited') { sinCredito = lista.length - enviados - fallidos; break; }
      if (r?.status === 'paused') break;
      enviados++;
      const textoEnviado = variante
        ? variante.texto.replace('{nombre}', titulo(p.nombre))
        : `Hola ${titulo(p.nombre)}, buscamos unidad para cualquier ruta hoy. ¿Tienes disponibilidad? Cuéntame qué unidad y para dónde.`;
      whatsappProactivo.registrarEnMemoria?.('sofia', p.telefono, textoEnviado);
      contactos.upsertContacto({ agente: 'sofia', telefono: p.telefono, resumen_interaccion: 'Difusión general de disponibilidad', canal: 'whatsapp-plantilla' }).catch(() => {});
    } catch (e) { fallidos++; console.error(`[difusionGeneral] Error mandando a ${p.nombre}:`, e.message); }
    await new Promise(res => setTimeout(res, PAUSA_ENTRE_ENVIOS_MS));
  }

  const resumen = `Difusión general (variante "${variante?.sid || CONTENT_SID_FALLBACK}"): ${enviados} enviados de ${lista.length}${sinCredito ? ` · ${sinCredito} sin enviar por tope diario` : ''}${fallidos ? ` · ${fallidos} con error` : ''}.`;
  feed({ tipo: 'DISPONIBILIDAD_DIARIA', mensaje: resumen });
  notifier.notificarAlerta({ title: 'SOFIA — Difusión general de disponibilidad', body: resumen, tipo: 'DISPONIBILIDAD_DIARIA' }).catch(() => {});
  console.log(`[difusionGeneral] ${resumen}`);
  return { ok: true, enviados, total: lista.length, sinCredito, fallidos, resumen };
}

async function correrSiToca(pushActividad) {
  if (!HABILITADO) return;
  const { fecha, minutosDelDia } = horaYFechaMTY();
  const inicioMin = HORA * 60 + MINUTO;
  if (minutosDelDia < inicioMin || minutosDelDia > inicioMin + VENTANA_MIN) return;
  if (ultimaFechaEnviada === fecha) return;
  ultimaFechaEnviada = fecha; // se marca antes de correr — un fallo a medias no la reintenta en bucle
  guardarUltimaFecha(fecha);
  await ejecutarDifusion();
}

// Disparo manual — pedido explícito del usuario (19-oct-2026): si Diego le
// escribe a SOFIA por WhatsApp "manda/lanza la difusión general", el handler
// de Kapso en server-lite.js llama esto (tras pedir confirmación con el
// número real de proveedores). Marca el día como ya corrido, para que la
// corrida programada de las 5:30 AM no la repita si cae el mismo día.
async function dispararManual() {
  const { fecha } = horaYFechaMTY();
  ultimaFechaEnviada = fecha;
  guardarUltimaFecha(fecha);
  return ejecutarDifusion();
}

function iniciar(pushActividad) {
  if (!HABILITADO) { console.log('[difusionGeneral] Desactivado (SOFIA_DIFUSION_GENERAL != "true")'); return; }
  setInterval(() => correrSiToca(pushActividad).catch(e => console.error('[difusionGeneral]', e.message)), CHEQUEO_MS);
  correrSiToca(pushActividad).catch(() => {}); // por si el server arranca ya pasada la hora
  console.log(`[difusionGeneral] Activo — Top 100 proveedores por volumen, a partir de las ${HORA}:${String(MINUTO).padStart(2, '0')} (Monterrey)`);
}

module.exports = { iniciar, correrSiToca, proveedoresTop100, dispararManual, dispararPorRuta, proveedoresPorRuta };
