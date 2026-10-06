// ── Difusión semanal de disponibilidad a clientes ────────────────────────────
// Pedido explícito del usuario (06-oct-2026): SARA se adelanta en vez de
// esperar a que el cliente pida carga — una vez por semana le escribe a los
// clientes que ya cerraron con nosotros antes: "tenemos unidades disponibles
// para estos próximos días, si requieres servicio podemos atenderte".
//
// Mismo patrón que difusionGeneral.js (la de SOFIA a proveedores), pero:
//   - destinatarios: contactos tipo 'cliente' de la Base de Datos (no proveedores)
//   - una vez por SEMANA, no todos los días
//   - el remitente es SARA, con su propio número y su propio límite diario
//
// Apagado por default — requiere SARA_DIFUSION_CLIENTES=true en el entorno,
// mismo criterio que difusionGeneral.js: un envío masivo automático a
// clientes reales no se activa solo.
const fs = require('fs');
const path = require('path');
const contactos = require('./contactos');
const whatsappProactivo = require('./whatsappProactivo');
const agentPause = require('./agentPause');
const actividadBus = require('./actividadBus');
const notifier = require('./notifier');

const HABILITADO = process.env.SARA_DIFUSION_CLIENTES === 'true';
const DIA_SEMANA = Number(process.env.SARA_DIFUSION_CLIENTES_DIA ?? 1); // 0=domingo … 1=lunes (default)
const HORA   = Number(process.env.SARA_DIFUSION_CLIENTES_HORA || 9);
const MINUTO = Number(process.env.SARA_DIFUSION_CLIENTES_MINUTO || 0);
const PAUSA_ENTRE_ENVIOS_MS = Number(process.env.SARA_DIFUSION_CLIENTES_PAUSA_MS || 3000);
const VENTANA_MIN = Number(process.env.SARA_DIFUSION_CLIENTES_VENTANA_MIN || 90);
const CHEQUEO_MS = 15 * 60 * 1000;

// Plantilla pendiente de crear y someter a aprobación en Twilio/Meta (mismo
// proceso que las de saraProactivo.js) — texto sugerido:
//   "Hola {{1}}, soy SARA de ABSTORAGES. Tenemos unidades disponibles para
//    estos próximos días. Si requieres servicio de transporte, podemos
//    atenderte — cuéntame qué ruta necesitas."
const CONTENT_SID = process.env.TWILIO_CONTENT_SID_DISPONIBILIDAD_CLIENTES || null;
const TEXTO = 'Hola {nombre}, soy SARA de ABSTORAGES. Tenemos unidades disponibles para estos próximos días — si requieres servicio de transporte, podemos atenderte. ¿Qué ruta necesitas?';

const ESTADO_FILE = path.join(__dirname, '../../data/difusion-clientes-estado.json');
function leerUltimaFecha() {
  try { return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8')).ultimaFechaEnviada || null; } catch { return null; }
}
function guardarUltimaFecha(fecha) {
  try { fs.mkdirSync(path.dirname(ESTADO_FILE), { recursive: true }); fs.writeFileSync(ESTADO_FILE, JSON.stringify({ ultimaFechaEnviada: fecha })); } catch (e) { console.error('[difusionClientes] no se pudo guardar el estado:', e.message); }
}
// 'YYYY-MM-DD' Monterrey — evita doble corrida la misma semana, incluso si el
// servidor se reinicia (persistido en disco, no solo en memoria).
let ultimaFechaEnviada = leerUltimaFecha();

function horaFechaDiaMTY() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Monterrey', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { fecha: `${p.year}-${p.month}-${p.day}`, minutosDelDia: Number(p.hour) * 60 + Number(p.minute), diaSemana: DIAS[p.weekday] };
}

async function clientesConocidos() {
  const bd = await contactos.listarPorAgente('SARA', { tipo: 'cliente' });
  return bd.filter(c => c.telefono && c.telefono !== '—');
}

const titulo = s => String(s || '').trim().split(/\s+/)[0].toLowerCase().replace(/^./, c => c.toUpperCase());
const feed = e => actividadBus.emitir({ agente: 'SARA', ...e });

async function correrSiToca() {
  if (!HABILITADO) return;
  if (agentPause.estaPausado('sara')) return;
  if (!CONTENT_SID) { console.warn('[difusionClientes] Falta TWILIO_CONTENT_SID_DISPONIBILIDAD_CLIENTES — se omite'); return; }

  const { fecha, minutosDelDia, diaSemana } = horaFechaDiaMTY();
  if (diaSemana !== DIA_SEMANA) return;
  const inicioMin = HORA * 60 + MINUTO;
  if (minutosDelDia < inicioMin || minutosDelDia > inicioMin + VENTANA_MIN) return;
  if (ultimaFechaEnviada === fecha) return;
  ultimaFechaEnviada = fecha; // se marca antes de correr — un fallo a medias no la reintenta en bucle
  guardarUltimaFecha(fecha);

  let lista;
  try { lista = await clientesConocidos(); } catch (e) { console.error('[difusionClientes] Error armando la lista:', e.message); return; }
  if (!lista.length) { feed({ tipo: 'DISPONIBILIDAD_CLIENTES', mensaje: 'Difusión semanal a clientes: no hay clientes con teléfono para mandarla hoy' }); return; }

  feed({ tipo: 'DISPONIBILIDAD_CLIENTES', mensaje: `Difusión semanal de disponibilidad a clientes — empezando con ${lista.length} clientes, uno tras otro` });

  let enviados = 0, sinCredito = 0, fallidos = 0;
  for (const c of lista) {
    try {
      const r = await whatsappProactivo.enviarPlantillaSinCandado('sara', c.telefono, CONTENT_SID, { '1': titulo(c.nombre_completo) });
      if (r?.status === 'rate_limited') { sinCredito = lista.length - enviados - fallidos; break; }
      if (r?.status === 'paused') break;
      enviados++;
      whatsappProactivo.registrarEnMemoria?.('sara', c.telefono, TEXTO.replace('{nombre}', titulo(c.nombre_completo)));
      contactos.upsertContacto({ agente: 'sara', tipo: 'cliente', telefono: c.telefono, resumen_interaccion: 'Difusión semanal de disponibilidad', canal: 'whatsapp-plantilla' }).catch(() => {});
    } catch (e) { fallidos++; console.error(`[difusionClientes] Error mandando a ${c.nombre_completo}:`, e.message); }
    await new Promise(res => setTimeout(res, PAUSA_ENTRE_ENVIOS_MS));
  }

  const resumen = `Difusión semanal a clientes: ${enviados} enviados de ${lista.length}${sinCredito ? ` · ${sinCredito} sin enviar por tope diario` : ''}${fallidos ? ` · ${fallidos} con error` : ''}.`;
  feed({ tipo: 'DISPONIBILIDAD_CLIENTES', mensaje: resumen });
  notifier.notificarAlerta({ title: 'SARA — Difusión semanal de disponibilidad', body: resumen, tipo: 'DISPONIBILIDAD_CLIENTES' }).catch(() => {});
  console.log(`[difusionClientes] ${resumen}`);
}

function iniciar() {
  if (!HABILITADO) { console.log('[difusionClientes] Desactivado (SARA_DIFUSION_CLIENTES != "true")'); return; }
  setInterval(() => correrSiToca().catch(e => console.error('[difusionClientes]', e.message)), CHEQUEO_MS);
  correrSiToca().catch(() => {}); // por si el server arranca ya pasada la hora
  console.log(`[difusionClientes] Activo — día ${DIA_SEMANA} (0=domingo) a partir de las ${HORA}:${String(MINUTO).padStart(2, '0')} (Monterrey)`);
}

module.exports = { iniciar, correrSiToca };
