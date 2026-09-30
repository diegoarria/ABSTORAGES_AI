// ── Difusión general de disponibilidad — 5:45 AM hora de Monterrey ──────────
// Pedido explícito del usuario (29-sep-2026): todos los días a partir de esa
// hora, SOFIA le manda a los proveedores más importantes (por número de
// servicios reales históricos) la plantilla de disponibilidad general, uno
// tras otro, sin esperar respuesta de nadie antes de seguir con el siguiente.
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

const HABILITADO = process.env.SOFIA_DIFUSION_GENERAL === 'true';
const HORA   = Number(process.env.SOFIA_DIFUSION_GENERAL_HORA || 5);
const MINUTO = Number(process.env.SOFIA_DIFUSION_GENERAL_MINUTO || 45);
const TOP_N  = Number(process.env.SOFIA_DIFUSION_GENERAL_N || 50);
const PAUSA_ENTRE_ENVIOS_MS = Number(process.env.SOFIA_DIFUSION_GENERAL_PAUSA_MS || 3000);
const CONTENT_SID = process.env.TWILIO_CONTENT_SID_DISPONIBILIDAD_GENERAL || null;
const CHEQUEO_MS = 15 * 60 * 1000;

let ultimaFechaEnviada = null; // 'YYYY-MM-DD' Monterrey — evita doble corrida el mismo día

function horaYFechaMTY() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Monterrey', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, minutosDelDia: Number(p.hour) * 60 + Number(p.minute) };
}

// Junta los 3 catálogos cargados (directorio general + las 2 rutas MTY) y se
// queda con el mayor número de servicios visto por teléfono — es la señal más
// real que tenemos de "qué tan importante" es un proveedor.
function serviciosPorTelefono() {
  const mapa = new Map();
  for (const archivo of ['proveedores-directorio.json', 'proveedores-mty-guadalajara.json', 'proveedores-mty-gomez-palacio.json']) {
    let lista; try { lista = require('../data/' + archivo); } catch { continue; }
    for (const p of lista) {
      if (!p.telefono) continue;
      const tel10 = String(p.telefono).replace(/\D/g, '').slice(-10);
      const n = Number(p.servicios || 0);
      if (!mapa.has(tel10) || mapa.get(tel10) < n) mapa.set(tel10, n);
    }
  }
  return mapa;
}

async function topProveedores(n) {
  const servicios = serviciosPorTelefono();
  const bd = await contactos.listarPorAgente('SOFIA', { tipo: 'proveedor' });
  return bd
    .filter(c => c.telefono && !/Estatus en catálogo: (Baja|Suspendido)/i.test(c.notas || ''))
    .map(c => ({ id: c.id, nombre: c.nombre_completo, empresa: c.empresa, telefono: c.telefono, servicios: servicios.get(String(c.telefono).replace(/\D/g, '').slice(-10)) || 0 }))
    .sort((a, b) => b.servicios - a.servicios)
    .slice(0, n);
}

const titulo = s => String(s || '').trim().split(/\s+/)[0].toLowerCase().replace(/^./, c => c.toUpperCase());
const feed = e => actividadBus.emitir({ agente: 'SOFIA', ...e });

async function correrSiToca(pushActividad) {
  if (!HABILITADO) return;
  if (agentPause.estaPausado('sofia')) return;
  if (!CONTENT_SID) { console.warn('[difusionGeneral] Plantilla de disponibilidad general aún no configurada (TWILIO_CONTENT_SID_DISPONIBILIDAD_GENERAL) — se omite'); return; }

  const { fecha, minutosDelDia } = horaYFechaMTY();
  if (minutosDelDia < HORA * 60 + MINUTO) return;
  if (ultimaFechaEnviada === fecha) return;
  ultimaFechaEnviada = fecha; // se marca antes de correr — un fallo a medias no la reintenta en bucle

  let lista;
  try { lista = await topProveedores(TOP_N); } catch (e) { console.error('[difusionGeneral] Error armando la lista:', e.message); return; }
  if (!lista.length) { feed({ tipo: 'DISPONIBILIDAD_DIARIA', mensaje: 'Difusión general: no hay proveedores con teléfono para mandarla hoy' }); return; }

  feed({ tipo: 'DISPONIBILIDAD_DIARIA', mensaje: `Difusión general de disponibilidad — empezando con ${lista.length} proveedores, uno tras otro` });

  let enviados = 0, sinCredito = 0, fallidos = 0;
  for (const p of lista) {
    try {
      const r = await whatsappProactivo.enviarPlantillaSinCandado('sofia', p.telefono, CONTENT_SID, { '1': titulo(p.nombre) });
      if (r?.status === 'rate_limited') { sinCredito = lista.length - enviados - fallidos; break; }
      if (r?.status === 'paused') break;
      enviados++;
      whatsappProactivo.registrarEnMemoria?.('sofia', p.telefono, `Hola ${titulo(p.nombre)}, buenos días. Soy SOFIA de ABSTORAGES. ¿Qué unidad tienes disponible hoy? Cuéntame la ruta y el tipo, para tenerte en cuenta en cuanto tengamos carga que te acomode.`);
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
  console.log(`[difusionGeneral] Activo — ${TOP_N} proveedores a partir de las ${HORA}:${String(MINUTO).padStart(2, '0')} (Monterrey)`);
}

module.exports = { iniciar, correrSiToca, topProveedores };
