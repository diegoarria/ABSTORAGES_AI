// ── Memoria compartida cross-agente (SARA/SOFIA/NOA) — contactos + interacciones ─
// Solo se guarda un contacto cuando hay un cierre real (venta/acuerdo confirmado),
// nunca por un prospecto que no llegó a nada — ver los call sites en server-lite.js.
//
// Con DATABASE_URL configurada, persiste en Postgres. Sin ella (modo server-lite,
// como corre hoy en producción), cae a un archivo JSON en disco — antes esto se
// omitía en silencio sin DATABASE_URL, así que en la práctica nunca se guardaba
// nada. Mismo patrón que ordersStore.js/leads.js: cada función atrapa sus propios
// errores y degrada en vez de propagar la excepción.
const fs   = require('fs');
const path = require('path');
const db = require('../db/db');

const USA_DB = !!process.env.DATABASE_URL;
const FILE = path.join(__dirname, '../../data/contactos.json');
const MAX_REGISTROS = 3000;

function cargar() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return [];
}

let cache = cargar();

let saveTimer = null;
function guardarDisco() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(cache, null, 2)); }
    catch (e) { console.error('[Contactos] Error guardando en disco:', e.message); }
  }, 500);
}

function normalizarTelefono(t) {
  return (t || '').replace(/\D/g, '').slice(-10);
}

function upsertEnMemoria({ agente, tipo, nombre_completo, puesto, telefono, email, empresa, tipo_carga, resumen_interaccion, canal, notas }) {
  const AGENTE = (agente || '').toUpperCase();
  const tel = normalizarTelefono(telefono);
  let existente = null;
  if (tel) existente = cache.find(c => normalizarTelefono(c.telefono) === tel);
  if (!existente && email) existente = cache.find(c => c.email && c.email.toLowerCase() === email.toLowerCase());

  const ahora = new Date().toISOString();
  let contacto;
  if (existente) {
    existente.nombre_completo = nombre_completo || existente.nombre_completo;
    existente.puesto          = puesto || existente.puesto;
    existente.telefono        = telefono || existente.telefono;
    existente.email           = email || existente.email;
    existente.empresa         = empresa || existente.empresa;
    existente.tipo_carga      = tipo_carga || existente.tipo_carga;
    existente.tipo            = tipo || existente.tipo;
    existente.notas           = notas || existente.notas;
    existente.fecha_ultimo_contacto = ahora;
    contacto = existente;
  } else {
    contacto = {
      id: `CT-${Date.now().toString(36).toUpperCase()}`,
      agente_asignado: AGENTE, tipo: tipo || null,
      nombre_completo: nombre_completo || 'Sin nombre', puesto: puesto || null, telefono: telefono || null,
      email: email || null, empresa: empresa || null, tipo_carga: tipo_carga || null, notas: notas || null,
      fecha_primer_contacto: ahora, fecha_ultimo_contacto: ahora, created_at: ahora,
    };
    cache.push(contacto);
    if (cache.length > MAX_REGISTROS) cache = cache.slice(-MAX_REGISTROS);
  }

  contacto.interacciones = contacto.interacciones || [];
  contacto.interacciones.unshift({ agente: AGENTE, canal: canal || 'otro', resumen: resumen_interaccion || null, fecha: ahora });
  contacto.interacciones = contacto.interacciones.slice(0, 50);

  guardarDisco();
  return contacto;
}

async function upsertContacto(datos) {
  if (USA_DB) {
    try {
      const contacto = await db.upsertContacto(datos);
      console.log(`[Contactos] Upsert (Postgres) ${datos.agente} → ${contacto.nombre_completo} (${contacto.id})`);
      return contacto;
    } catch (e) {
      console.error('[Contactos] Postgres falló en upsert, cae a archivo:', e.message);
    }
  }
  const contacto = upsertEnMemoria(datos);
  console.log(`[Contactos] Upsert (archivo) ${datos.agente} → ${contacto.nombre_completo} (${contacto.id})`);
  return contacto;
}

async function listarPorAgente(agente, opts = {}) {
  if (USA_DB) {
    try { return await db.listarContactosPorAgente(agente, opts); }
    catch (e) { console.error('[Contactos] Postgres falló listando, cae a archivo:', e.message); }
  }
  const AGENTE = (agente || '').toUpperCase();
  let rows = cache.filter(c => c.agente_asignado === AGENTE || (c.interacciones || []).some(i => i.agente === AGENTE));
  if (opts.tipo) rows = rows.filter(c => c.tipo === opts.tipo);
  if (opts.q) {
    const q = opts.q.toLowerCase();
    rows = rows.filter(c =>
      (c.nombre_completo || '').toLowerCase().includes(q) ||
      (c.empresa || '').toLowerCase().includes(q) ||
      (c.tipo_carga || '').toLowerCase().includes(q));
  }
  return [...rows].sort((a, b) => new Date(b.fecha_ultimo_contacto) - new Date(a.fecha_ultimo_contacto));
}

async function obtenerDetalle(id) {
  if (USA_DB) {
    try {
      const detalle = await db.obtenerContactoDetalle(id);
      if (detalle) return detalle;
    } catch (e) { console.error('[Contactos] Postgres falló en detalle, cae a archivo:', e.message); }
  }
  return cache.find(c => c.id === id) || null;
}

// Búsqueda por teléfono — permite que la IA reconozca a un contacto ya
// registrado ANTES de responder (recall real dentro de la conversación, no
// solo un dato guardado para que un humano lo consulte en el dashboard).
async function buscarPorTelefono(telefono, agente) {
  const tel = normalizarTelefono(telefono);
  if (!tel) return null;
  if (USA_DB) {
    try {
      const encontrado = await db.buscarContactoPorTelefono(tel, agente);
      if (encontrado) return encontrado;
    } catch (e) { console.error('[Contactos] Postgres falló buscando por teléfono, cae a archivo:', e.message); }
  }
  const AGENTE = agente ? agente.toUpperCase() : null;
  return cache.find(c =>
    normalizarTelefono(c.telefono) === tel &&
    (!AGENTE || c.agente_asignado === AGENTE || (c.interacciones || []).some(i => i.agente === AGENTE))
  ) || null;
}

// Bloque de contexto a inyectar en el system prompt cuando quien escribe/llama
// ya es un contacto conocido — esto es lo que convierte "está guardado" en
// "la IA realmente se acuerda": se arma con las últimas interacciones reales.
function bloqueContactoConocido(contacto) {
  const interacciones = (contacto.interacciones || []).slice(0, 5)
    .map(i => `- ${new Date(i.fecha).toLocaleDateString('es-MX')} (${i.canal || 'otro'}): ${i.resumen || 'sin detalle'}`)
    .join('\n');
  return (
    `\n\n---\n\n## 🧠 CONTACTO CONOCIDO — YA TIENES HISTORIAL CON ESTA PERSONA\n` +
    `**${contacto.nombre_completo}**${contacto.empresa ? ` — ${contacto.empresa}` : ''} (${contacto.tipo || 'contacto'}). ` +
    `Último contacto: ${new Date(contacto.fecha_ultimo_contacto).toLocaleDateString('es-MX')}.\n` +
    (contacto.notas ? `**Nota importante guardada sobre esta persona — síguela siempre**: ${contacto.notas}\n\n` : '\n') +
    (interacciones ? `Interacciones previas relevantes:\n${interacciones}\n\n` : '\n') +
    `IMPORTANTE: esta persona YA está registrada en la Base de Datos de ABSTORAGES — NO le pidas nombre completo, teléfono ni correo, y NO apliques la regla de "PRIMER MENSAJE" con ella (esa regla es solo para desconocidos). Si te saluda, salúdala por su nombre y sigue la conversación normal.\n` +
    `Ya la conoces — no repitas preguntas que ya tienes contestadas ahí, y usa ese historial para dar continuidad natural a la conversación. No lo menciones de forma robótica ("según mis registros..."), solo úsalo como lo haría alguien que de verdad se acuerda.`
  );
}

// ── Contactos permanentes — blindados contra pérdida de datos ────────────────
// A diferencia de un alta normal, estos quedan también aquí, en código,
// committeados a git — así sobreviven aunque se pierda el archivo de disco Y
// pasan por Postgres cuando USA_DB (que es como corre hoy en producción real,
// no el archivo — ver upsertContacto arriba). Se reinsertan solos al arrancar
// si por lo que sea ya no están. Pedido explícito del usuario: guardar estos
// contactos "para siempre", mismo criterio que BANEOS_MANUALES en ipBanlist.js.
const CONTACTOS_PERMANENTES = [
  {
    agente: 'sofia', tipo: 'proveedor',
    nombre_completo: 'Francisco Favio',
    telefono: '+5216681328696',
    notas: 'Clave: P1561 LOGVE',
  },
  {
    agente: 'sofia', tipo: 'proveedor',
    nombre_completo: 'Marco Arzate',
    telefono: '+5217121791028',
    notas: 'Dirigirse a él SIEMPRE como "Sr. Marco" en cada mensaje — no usar solo "Marco" ni el apellido solo.',
  },
];

async function sembrarContactosPermanentes() {
  for (const c of CONTACTOS_PERMANENTES) {
    try {
      const yaExiste = await buscarPorTelefono(c.telefono, c.agente);
      if (yaExiste) continue;
      await upsertContacto({
        agente: c.agente, tipo: c.tipo, nombre_completo: c.nombre_completo,
        telefono: c.telefono, notas: c.notas,
        resumen_interaccion: 'Alta permanente — protegido en código, no solo en disco/Postgres', canal: 'permanente',
      });
      console.log(`[Contactos] Sembrado contacto permanente: ${c.nombre_completo} (${c.telefono})`);
    } catch (e) {
      console.error(`[Contactos] Error sembrando contacto permanente ${c.nombre_completo}:`, e.message);
    }
  }
}
sembrarContactosPermanentes();

module.exports = { upsertContacto, listarPorAgente, obtenerDetalle, buscarPorTelefono, bloqueContactoConocido };
