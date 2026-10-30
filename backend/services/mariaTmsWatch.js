// ── María — vigilancia proactiva del TMS para clientes nuevos ──────────────
// Pedido explícito del usuario (23-oct-2026): que María se anticipe a lo que
// pasa en el TMS en vez de esperar a que alguien le escriba. Mismo patrón que
// ya usan NOA (noaScheduler.js) y SOFIA (sofiaScheduler.js) contra el TMS —
// María era la única de las 3 sin nada proactivo del lado del TMS.
//
// Cómo funciona: cada CHEQUEO_MS trae la lista de clientes del TMS y la
// compara contra la última "foto" guardada en disco (por RFC, la llave más
// estable). Si aparece un RFC que antes no estaba, es un cliente nuevo
// capturado por alguien del equipo directo en el TMS/AppSheet — María se
// presenta sola, sin que nadie se lo pida, con la misma plantilla ya
// aprobada que usa para presentarse (presentacion_maria_clientes_v1).
//
// PRIMERA CORRIDA = SOLO FOTO, NUNCA CONTACTA A NADIE. Sin esto, la primera
// vez que esto corra en un TMS con cientos de clientes existentes, los
// trataría a TODOS como "nuevos" y le mandaría una presentación a la base
// completa de un jalón — exactamente la clase de incidente real que ya pasó
// con la ronda de SOFIA en septiembre (ver outboundRateLimit.js). Después de
// esa primera foto, cada corrida siguiente compara contra la vez anterior.
//
// Protegido por las mismas 2 capas que ya existen para todo envío proactivo:
// agentPause('maria') y el techo duro diario de outboundRateLimit.js (no
// depende de este archivo para funcionar — es automático vía saraProactivo).
// Apagado por default — requiere MARIA_TMS_WATCH=true en el entorno.
const fs = require('fs');
const path = require('path');
const tms = require('./tms');
const contactos = require('./contactos');
const agentPause = require('./agentPause');
const saraProactivo = require('./saraProactivo');
const actividadBus = require('./actividadBus');
const notifier = require('./notifier');

const HABILITADO = process.env.MARIA_TMS_WATCH === 'true';
const CHEQUEO_MS = Number(process.env.MARIA_TMS_WATCH_CHEQUEO_MIN || 30) * 60 * 1000;
const MAX_POR_CORRIDA = Number(process.env.MARIA_TMS_WATCH_MAX_POR_CORRIDA || 10); // tope aparte del límite diario global
const PLANTILLA_PRESENTACION = process.env.KAPSO_TEMPLATE_PRESENTACION_MARIA || 'presentacion_maria_clientes_v1';

const ESTADO_FILE = path.join(__dirname, '../../data/maria-tms-watch-estado.json');
function leerEstado() {
  try { return JSON.parse(fs.readFileSync(ESTADO_FILE, 'utf8')); } catch { return null; }
}
function guardarEstado(estado) {
  try { fs.mkdirSync(path.dirname(ESTADO_FILE), { recursive: true }); fs.writeFileSync(ESTADO_FILE, JSON.stringify(estado)); }
  catch (e) { console.error('[mariaTmsWatch] No se pudo guardar el estado:', e.message); }
}

const feed = e => actividadBus.emitir({ agente: 'MARIA', ...e });

// Trae TODOS los clientes del TMS, paginado (el TMS tronaba por timeout con
// límites grandes en otras consultas — 100 por página es un término medio
// seguro, ver comentario de desempenoCliente() en tms.js).
async function todosLosClientes() {
  const campos = ['RFC', 'Razon Social', 'Estatus', 'Correo principal', 'Telefono principal', 'Móvil principal'];
  const todos = [];
  let pagina = 1;
  while (true) {
    const r = await tms.query('clientes', { pagina, limite: 100, campos });
    const datos = r?.datos || [];
    if (!datos.length) break;
    todos.push(...datos);
    if (datos.length < 100 || pagina >= 20) break; // tope de 2000 clientes por seguridad
    pagina++;
  }
  return todos;
}

async function correr() {
  if (!HABILITADO) return;
  if (!tms.ENABLED) return;
  if (agentPause.estaPausado('maria')) return;

  let clientes;
  try { clientes = await todosLosClientes(); }
  catch (e) { console.error('[mariaTmsWatch] Error consultando el TMS:', e.message); return; }
  if (!clientes.length) return;

  const estadoAnterior = leerEstado();
  const rfcsActuales = new Set(clientes.map(c => c['RFC']).filter(Boolean));

  if (!estadoAnterior) {
    // Primera corrida — solo guarda la foto, no contacta a nadie.
    guardarEstado({ rfcs: [...rfcsActuales], ultimaCorrida: new Date().toISOString() });
    feed({ tipo: 'TMS_WATCH_INICIAL', mensaje: `Foto inicial del TMS guardada — ${rfcsActuales.size} clientes conocidos. A partir de ahora, cualquier cliente nuevo que aparezca se detecta solo.` });
    console.log(`[mariaTmsWatch] Primera corrida — foto de ${rfcsActuales.size} clientes guardada, sin contactar a nadie`);
    return;
  }

  const rfcsAnteriores = new Set(estadoAnterior.rfcs || []);
  const nuevos = clientes.filter(c => c['RFC'] && !rfcsAnteriores.has(c['RFC']));

  // Se guarda la foto actualizada ANTES de contactar — un fallo a medias
  // nunca vuelve a intentar contactar al mismo cliente en la siguiente corrida.
  guardarEstado({ rfcs: [...rfcsActuales], ultimaCorrida: new Date().toISOString() });

  if (!nuevos.length) return;

  feed({ tipo: 'TMS_WATCH_CLIENTE_NUEVO', mensaje: `TMS: ${nuevos.length} cliente(s) nuevo(s) detectado(s) — María se presenta sola` });

  let contactados = 0;
  for (const c of nuevos.slice(0, MAX_POR_CORRIDA)) {
    const telefono = c['Móvil principal'] || c['Telefono principal'];
    if (!telefono) continue;
    try {
      // Si ya es un contacto conocido (alguien lo dio de alta a mano antes,
      // o ya habló con María por otro canal), no se le vuelve a "presentar".
      const conocido = await contactos.buscarPorTelefono(telefono, 'maria').catch(() => null);
      if (conocido) continue;

      const nombre = (c['Razon Social'] || '').split(/\s+/)[0] || 'ahí';
      const r = await saraProactivo.enviarPlantilla(telefono, PLANTILLA_PRESENTACION, { '1': nombre });
      if (r?.status === 'paused' || r?.status === 'rate_limited') break; // se respeta el freno, no se sigue insistiendo
      saraProactivo.registrarEnMemoria(telefono, `¡Hola! Soy María Fernández, ejecutiva comercial de ABSTORAGES Logistics Solutions. Te escribo para presentarme: a partir de ahora me voy a sumar al equipo que te atiende.`);
      contactos.upsertContacto({ agente: 'maria', tipo: 'cliente', telefono, nombre_completo: c['Razon Social'], resumen_interaccion: 'Cliente nuevo detectado en el TMS — presentación automática', canal: 'whatsapp-plantilla' }).catch(() => {});
      contactados++;
    } catch (e) { console.error(`[mariaTmsWatch] Error contactando a ${c['Razon Social']}:`, e.message); }
  }

  const resumen = `TMS: ${nuevos.length} cliente(s) nuevo(s) detectado(s), María se presentó con ${contactados}.`;
  feed({ tipo: 'TMS_WATCH_CLIENTE_NUEVO', mensaje: resumen });
  notifier.notificarAlerta({ title: 'María — clientes nuevos detectados en el TMS', body: resumen, tipo: 'TMS_WATCH_CLIENTE_NUEVO' }).catch(() => {});
  console.log(`[mariaTmsWatch] ${resumen}`);
}

function iniciar() {
  if (!HABILITADO) { console.log('[mariaTmsWatch] Desactivado (MARIA_TMS_WATCH != "true")'); return; }
  setInterval(() => correr().catch(e => console.error('[mariaTmsWatch]', e.message)), CHEQUEO_MS);
  correr().catch(e => console.error('[mariaTmsWatch]', e.message));
  console.log(`[mariaTmsWatch] Activo — revisando el TMS cada ${CHEQUEO_MS / 60000} min por clientes nuevos`);
}

module.exports = { iniciar, correr };
