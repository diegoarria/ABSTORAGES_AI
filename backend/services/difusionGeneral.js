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
// bot y se pierde confianza. Se rota una por proveedor (round-robin), cada una
// con su propio Content SID aprobado por Meta por separado. Solo se usan las
// que ya tengan SID configurado — las que falten simplemente no entran a la
// rotación todavía.
const TEXTO_VARIANTE = [
  'Hola {nombre}, buenos días. Soy SOFIA de ABSTORAGES. ¿Qué unidad tienes disponible hoy? Cuéntame la ruta y el tipo, para tenerte en cuenta en cuanto tengamos carga que te acomode.',
  'Buenos días {nombre}, soy SOFIA de ABSTORAGES. ¿Tendrás unidad disponible hoy? Si tienes algo libre, cuéntame en qué ruta y qué tipo de caja, para avisarte en cuanto tengamos algo para ti.',
  '{nombre}, buen día — habla SOFIA de ABSTORAGES. ¿Hoy cuentas con unidad disponible? Si es así, dime la ruta y el tipo de caja para tenerte en mente.',
  'Hola {nombre}, ¿qué tal? Soy SOFIA de ABSTORAGES Logistics. Te escribo para ver si tienes unidad libre hoy — compárteme ruta y tipo de caja para tomarte en cuenta en lo que tengamos disponible.',
];
const VARIANTES = [1, 2, 3, 4]
  .map(n => ({
    sid: process.env[`TWILIO_CONTENT_SID_DISPONIBILIDAD_GENERAL_${n}`] || (n === 1 ? process.env.TWILIO_CONTENT_SID_DISPONIBILIDAD_GENERAL : null) || null,
    texto: TEXTO_VARIANTE[n - 1],
  }))
  .filter(v => v.sid);
// Mientras ninguna plantilla dedicada esté aprobada, cae a la de disponibilidad
// que ya existe y está aprobada — con valores genéricos, porque esta difusión
// no es de una ruta ni una carga específica.
const CONTENT_SID_FALLBACK = process.env.TWILIO_CONTENT_SID_DISPONIBILIDAD || null;
const CHEQUEO_MS = 15 * 60 * 1000;
// Ventana de tolerancia tras la hora programada — solo dentro de este rango se
// considera "toca mandar hoy". Sin esto, prender la función (o que el server
// se reinicie) a cualquier hora del día dispara el envío de inmediato en vez
// de esperar al día siguiente — esto fue un incidente real (29-sep-2026).
const VENTANA_MIN = Number(process.env.SOFIA_DIFUSION_GENERAL_VENTANA_MIN || 90);

const ESTADO_FILE = path.join(__dirname, '../../data/difusion-general-estado.json');
function leerUltimaFecha() {
  try { return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8')).ultimaFechaEnviada || null; } catch { return null; }
}
function guardarUltimaFecha(fecha) {
  try { fs.mkdirSync(path.dirname(ESTADO_FILE), { recursive: true }); fs.writeFileSync(ESTADO_FILE, JSON.stringify({ ultimaFechaEnviada: fecha })); } catch (e) { console.error('[difusionGeneral] no se pudo guardar el estado:', e.message); }
}
// 'YYYY-MM-DD' Monterrey — evita doble corrida el mismo día, incluso si el
// servidor se reinicia (persistido en disco, no solo en memoria).
let ultimaFechaEnviada = leerUltimaFecha();

function horaYFechaMTY() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Monterrey', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, minutosDelDia: Number(p.hour) * 60 + Number(p.minute) };
}

// Las 50 rutas más importantes (ya sembradas en la Base de Datos con el
// mismo texto "Municipio - Municipio" que trae c.rutas de cada proveedor —
// ver backend/data/proveedores-top50-rutas.json y contactos.js).
function rutasTop50() {
  let lista; try { lista = require('../data/proveedores-top50-rutas.json'); } catch { return new Set(); }
  return new Set(lista.map(r => String(r.destino || '').trim().toLowerCase()).filter(Boolean));
}

// Proveedores de la Base de Datos que cubren al menos una de esas 50 rutas —
// deduplicados por teléfono, para que a nadie le llegue más de un mensaje
// aunque cubra varias rutas del Top 50.
async function proveedoresTop50Rutas() {
  const rutas = rutasTop50();
  if (!rutas.size) return [];
  const bd = await contactos.listarPorAgente('SOFIA', { tipo: 'proveedor' });
  return bd.filter(c => {
    if (!c.telefono || /Estatus en catálogo: (Baja|Suspendido)/i.test(c.notas || '')) return false;
    const susRutas = String(c.rutas || '').split(/[,;\n]+/).map(r => r.trim().toLowerCase()).filter(Boolean);
    return susRutas.some(r => rutas.has(r));
  }).map(c => ({ id: c.id, nombre: c.nombre_completo, empresa: c.empresa, telefono: c.telefono }));
}

const titulo = s => String(s || '').trim().split(/\s+/)[0].toLowerCase().replace(/^./, c => c.toUpperCase());
const feed = e => actividadBus.emitir({ agente: 'SOFIA', ...e });

async function correrSiToca(pushActividad) {
  if (!HABILITADO) return;
  if (agentPause.estaPausado('sofia')) return;
  const usaVariantes = VARIANTES.length > 0;
  if (!usaVariantes && !CONTENT_SID_FALLBACK) { console.warn('[difusionGeneral] Ninguna plantilla de disponibilidad configurada (ni variantes ni la de siempre) — se omite'); return; }

  const { fecha, minutosDelDia } = horaYFechaMTY();
  const inicioMin = HORA * 60 + MINUTO;
  if (minutosDelDia < inicioMin || minutosDelDia > inicioMin + VENTANA_MIN) return;
  if (ultimaFechaEnviada === fecha) return;
  ultimaFechaEnviada = fecha; // se marca antes de correr — un fallo a medias no la reintenta en bucle
  guardarUltimaFecha(fecha);

  let lista;
  try { lista = await proveedoresTop50Rutas(); } catch (e) { console.error('[difusionGeneral] Error armando la lista:', e.message); return; }
  if (!lista.length) { feed({ tipo: 'DISPONIBILIDAD_DIARIA', mensaje: 'Difusión general: ningún proveedor con teléfono cubre alguna de las 50 rutas más importantes hoy' }); return; }

  feed({ tipo: 'DISPONIBILIDAD_DIARIA', mensaje: `Difusión general de disponibilidad (Top 50 rutas) — empezando con ${lista.length} proveedores, uno tras otro` });

  let enviados = 0, sinCredito = 0, fallidos = 0;
  let i = 0;
  for (const p of lista) {
    try {
      const variante = usaVariantes ? VARIANTES[i % VARIANTES.length] : null;
      const CONTENT_SID = variante ? variante.sid : CONTENT_SID_FALLBACK;
      const variables = variante
        ? { '1': titulo(p.nombre) }
        : { '1': titulo(p.nombre), '2': 'cualquier tipo de unidad', '3': 'cualquier origen', '4': 'cualquier destino', '5': 'hoy' };
      const r = await whatsappProactivo.enviarPlantillaSinCandado('sofia', p.telefono, CONTENT_SID, variables);
      i++;
      if (r?.status === 'rate_limited') { sinCredito = lista.length - enviados - fallidos; break; }
      if (r?.status === 'paused') break;
      enviados++;
      const textoEnviado = variante
        ? variante.texto.replace('{nombre}', titulo(p.nombre))
        : `Hola ${titulo(p.nombre)}, buscamos unidad para cualquier ruta hoy. ¿Tienes disponibilidad? Cuéntame qué unidad y para dónde.`;
      whatsappProactivo.registrarEnMemoria?.('sofia', p.telefono, textoEnviado);
      contactos.upsertContacto({ agente: 'sofia', telefono: p.telefono, resumen_interaccion: 'Difusión general de disponibilidad (ronda diaria 5:45 AM)', canal: 'whatsapp-plantilla' }).catch(() => {});
    } catch (e) { fallidos++; console.error(`[difusionGeneral] Error mandando a ${p.nombre}:`, e.message); }
    await new Promise(res => setTimeout(res, PAUSA_ENTRE_ENVIOS_MS));
  }

  const resumen = `Difusión general del día: ${enviados} enviados de ${lista.length}${sinCredito ? ` · ${sinCredito} sin enviar por tope diario` : ''}${fallidos ? ` · ${fallidos} con error` : ''}.`;
  feed({ tipo: 'DISPONIBILIDAD_DIARIA', mensaje: resumen });
  notifier.notificarAlerta({ title: 'SOFIA — Difusión general de disponibilidad', body: resumen, tipo: 'DISPONIBILIDAD_DIARIA' }).catch(() => {});
  console.log(`[difusionGeneral] ${resumen}`);
}

function iniciar(pushActividad) {
  if (!HABILITADO) { console.log('[difusionGeneral] Desactivado (SOFIA_DIFUSION_GENERAL != "true")'); return; }
  setInterval(() => correrSiToca(pushActividad).catch(e => console.error('[difusionGeneral]', e.message)), CHEQUEO_MS);
  correrSiToca(pushActividad).catch(() => {}); // por si el server arranca ya pasada la hora
  console.log(`[difusionGeneral] Activo — proveedores del Top 50 de rutas, a partir de las ${HORA}:${String(MINUTO).padStart(2, '0')} (Monterrey)`);
}

module.exports = { iniciar, correrSiToca, proveedoresTop50Rutas };
