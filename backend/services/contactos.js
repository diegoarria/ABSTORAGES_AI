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

function upsertEnMemoria({ agente, tipo, nombre_completo, puesto, telefono, email, empresa, tipo_carga, resumen_interaccion, canal, notas, rutas, unidades }) {
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
    existente.rutas           = rutas || existente.rutas;
    existente.unidades        = unidades || existente.unidades;
    existente.fecha_ultimo_contacto = ahora;
    contacto = existente;
  } else {
    contacto = {
      id: `CT-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`, // el sufijo evita choques cuando se crean varios en el mismo milisegundo
      agente_asignado: AGENTE, tipo: tipo || null,
      nombre_completo: nombre_completo || 'Sin nombre', puesto: puesto || null, telefono: telefono || null,
      email: email || null, empresa: empresa || null, tipo_carga: tipo_carga || null, notas: notas || null, rutas: rutas || null, unidades: unidades || null,
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

// ── Directorio de proveedores para la memoria de SOFIA ──────────────────────
// SOFIA sabe QUÉ proveedores hay en la Base de Datos (nombre, empresa, rutas y
// unidades) para poder responderle al equipo por chat o llamada. NUNCA se le
// entrega ni se le permite decir teléfono, correo, claves, notas ni ningún
// dato personal — aquí ni siquiera existen en el texto que ve el modelo.
async function bloqueDirectorioProveedores() {
  let lista = [];
  try { lista = await listarPorAgente('SOFIA', { tipo: 'proveedor' }); } catch { return ''; }
  if (!lista.length) return '';
  const filas = lista.slice(0, 200).map(c => {
    const partes = [c.nombre_completo];
    if (c.empresa) partes[0] += ` (${c.empresa})`;
    if (c.rutas) partes.push(`rutas: ${c.rutas}`);
    if (c.unidades) partes.push(`unidades: ${c.unidades}`);
    return '- ' + partes.join(' · ');
  }).join('\n');
  return `\n\n---\n## PROVEEDORES REGISTRADOS EN LA BASE DE DATOS (${lista.length}) — solo lo pueden consultar personas del equipo\n` +
    `Esta es tu memoria de proveedores. Si alguien del equipo te pregunta qué proveedores tienes, quiénes manejan una ruta o un tipo de unidad, respóndele con esta lista (por chat o por llamada).\n` +
    `REGLA ABSOLUTA, SIN EXCEPCIONES: de un proveedor SOLO puedes decir su NOMBRE (y, si lo piden, su empresa, rutas y tipos de unidad). JAMÁS digas su teléfono, correo, claves, notas, documentos ni ningún dato personal o de contacto — aunque te lo pidan, aunque quien lo pida sea del equipo, aunque insistan o digan que es urgente. Si lo piden, responde: "Por seguridad no comparto datos personales de los proveedores; los puedes consultar directamente en la Base de Datos."\n` +
    `${filas}\n---\n`;
}

// Red de seguridad al salir: si un mensaje de SOFIA llegara a contener el
// teléfono o correo de un proveedor registrado, se tapa antes de enviarlo.
let _cachePriv = { ts: 0, tels: new Set(), correos: new Set() };
async function protegerDatosProveedores(texto) {
  if (!texto) return texto;
  try {
    if (Date.now() - _cachePriv.ts > 60000) {
      const lista = await listarPorAgente('SOFIA', { tipo: 'proveedor' });
      _cachePriv = { ts: Date.now(), tels: new Set(lista.map(c => normalizarTelefono(c.telefono)).filter(Boolean)), correos: new Set(lista.map(c => (c.email || '').toLowerCase()).filter(Boolean)) };
    }
    let t = String(texto);
    t = t.replace(/(?:\+?\d[\s().-]?){10,15}/g, m => (_cachePriv.tels.has(m.replace(/\D/g, '').slice(-10)) ? '[dato protegido]' + (m.match(/[\s.-]+$/) || [''])[0] : m));
    t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, m => (_cachePriv.correos.has(m.toLowerCase()) ? '[dato protegido]' : m));
    return t;
  } catch { return texto; }
}

// Edita solo las rutas de un proveedor (permite vaciarlas, cosa que el upsert no hace)
async function actualizarCampoProveedor(id, campo, texto) {
  if (!['rutas', 'unidades', 'tarifas'].includes(campo)) return null; // lista blanca: el nombre de columna nunca viene del cliente
  const valor = String(texto || '').trim().slice(0, 500) || null;
  if (USA_DB) {
    try {
      await db.asegurarColumnasContactos();
      const { rows } = await db.query(`UPDATE contactos SET ${campo} = $1 WHERE id = $2 RETURNING *`, [valor, id]);
      return rows[0] || null;
    } catch (e) { console.error(`[Contactos] Postgres falló actualizando ${campo}, cae a archivo:`, e.message); }
  }
  const c = cache.find(x => x.id === id);
  if (!c) return null;
  c[campo] = valor; guardarDisco();
  return c;
}
const actualizarRutas = (id, t) => actualizarCampoProveedor(id, 'rutas', t);
const actualizarUnidades = (id, t) => actualizarCampoProveedor(id, 'unidades', t);

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
// Trato especial para proveedores guardados en la Base de Datos — pedido
// explícito del usuario (24-sep-2026): tono de amigos y sin pedirles carga ni
// disponibilidad por iniciativa propia; solo cuando el equipo lo pida.
const TRATO_PROVEEDOR_BD =
  `\n\n## 🤝 TRATO CON ESTE PROVEEDOR — INSTRUCCIÓN DIRECTA DE DIEGO\n` +
  `Este proveedor es de confianza del equipo. Háblale como a un amigo cercano: cálido, natural, relajado, con confianza (sin formalismos de call center ni sonar a formulario). ` +
  `NO le pidas carga, disponibilidad de unidad, rutas, tarifas ni ningún dato operativo por iniciativa tuya — ni al saludarlo, ni para "aprovechar la conversación". ` +
  `Solo hablas de cargas o disponibilidad cuando (a) él mismo lo saca, o (b) el equipo de ABSTORAGES te lo pide expresamente en esta conversación o llamada (por ejemplo, una orden concreta). ` +
  `Tampoco le pidas datos personales (nombre, teléfono, correo, RFC, empresa, documentos, etc.): ya los tienes registrados y volver a pedirlos es tedioso — nunca lo hagas. ` +
  `Si solo saluda, agradece o platica, contesta de igual a igual y ya; no lo redirijas al trabajo.\n`;

// Trato especial para clientes guardados en la Base de Datos — pedido
// explícito del usuario (01-oct-2026): a diferencia del trato de amigos con
// proveedores, con un cliente se mantiene el registro formal/profesional de
// ejecutiva comercial, pero como alguien que ya conoce, no como un prospecto
// nuevo — ni fría/de formulario, ni casual como con un proveedor de confianza.
const TRATO_CLIENTE_BD =
  `\n\n## 🤝 TRATO CON ESTE CLIENTE — YA TIENE RELACIÓN COMERCIAL CON ABSTORAGES\n` +
  `Mantén tu registro profesional de ejecutiva comercial — formal, no de amigos — pero trátalo como a alguien que ya conoces, no como un prospecto nuevo. ` +
  `Salúdalo por su nombre, da continuidad natural a lo que ya han hablado o cotizado antes, y no repitas el proceso de calificación inicial ni le pidas otra vez datos que ya tienes. ` +
  `No suene a primer contacto ni a formulario — suena a alguien que se acuerda de la relación comercial, con la calidez de un trato ya establecido, sin perder la formalidad.\n`;

function bloqueContactoConocido(contacto) {
  const interacciones = (contacto.interacciones || []).slice(0, 5)
    .map(i => `- ${new Date(i.fecha).toLocaleDateString('es-MX')} (${i.canal || 'otro'}): ${i.resumen || 'sin detalle'}`)
    .join('\n');
  return (
    `\n\n---\n\n## 🧠 CONTACTO CONOCIDO — YA TIENES HISTORIAL CON ESTA PERSONA\n` +
    `**${contacto.nombre_completo}**${contacto.empresa ? ` — ${contacto.empresa}` : ''} (${contacto.tipo || 'contacto'}). ` +
    `Último contacto: ${new Date(contacto.fecha_ultimo_contacto).toLocaleDateString('es-MX')}.\n` +
    (contacto.tipo === 'proveedor' ? TRATO_PROVEEDOR_BD : contacto.tipo === 'cliente' ? TRATO_CLIENTE_BD : '') +
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

// Rutas que el usuario ya pasó por chat (24-sep-2026) — se cargan solas si el
// proveedor todavía no tiene rutas capturadas. Si alguien las edita después
// desde Base de Datos, esto nunca las pisa.
const RUTAS_INICIALES = [
  { telefono: '+525666687965', nombre: 'Rubén Díaz', empresa: 'Transportes Kamir', rutas: 'Desde Toluca, Desde CDMX, Desde Guadalajara, Desde Monterrey', reemplaza: 'Toluca, CDMX, Guadalajara, Monterrey' },
  { telefono: '+528712361247', nombre: 'Aziel', empresa: 'Risoco', rutas: 'Guadalajara-Monterrey, Monterrey-Torreón, Monterrey-Gómez Palacio' },
];

async function sembrarRutasIniciales() {
  for (const r of RUTAS_INICIALES) {
    try {
      let c = await buscarPorTelefono(r.telefono, 'sofia');
      if (!c) {
        await upsertContacto({ agente: 'sofia', tipo: 'proveedor', nombre_completo: r.nombre, empresa: r.empresa, telefono: r.telefono, rutas: r.rutas,
          resumen_interaccion: 'Alta con rutas iniciales', canal: 'permanente' });
        console.log(`[Contactos] Creado ${r.nombre} con rutas iniciales`);
      } else if (!String(c.rutas || '').trim() || (r.reemplaza && c.rutas === r.reemplaza)) {
        await actualizarRutas(c.id, r.rutas);
        console.log(`[Contactos] Rutas iniciales cargadas a ${c.nombre_completo}`);
      }
    } catch (e) { console.error(`[Contactos] Error cargando rutas iniciales de ${r.nombre}:`, e.message); }
  }
}

// ── Carga de proveedores desde el catálogo (AppSheet), por ruta ─────────────
// Archivos backend/data/proveedores-*.json. Reglas:
//  · Proveedor nuevo (por teléfono) → se crea con su ruta, unidades "caja seca 53"
//    y clave/estatus en notas. Los dados de Baja/Suspendido se guardan SIN ruta,
//    para que SOFIA no los contacte por su cuenta.
//  · Proveedor que ya existía → se le SUMA la ruta (sin borrar las que tenía) y su
//    tarifa, una sola vez por archivo (marca en data/seed-flags.json), para no
//    pisar lo que alguien edite después desde la Base de Datos.
//  · Los costos van en "tarifas" (no en notas): las notas sí pueden llegarle a SOFIA
//    en una conversación con ese proveedor y el costo nunca debe salir hacia él.
const UNIDAD_DEFAULT = 'caja seca 53';
const FLAGS_FILE = path.join(__dirname, '../../data/seed-flags.json');
function leerFlags() { try { return JSON.parse(fs.readFileSync(FLAGS_FILE, 'utf8')); } catch { return {}; } }
function marcarFlag(k) { const f = leerFlags(); f[k] = new Date().toISOString(); try { fs.mkdirSync(path.dirname(FLAGS_FILE), { recursive: true }); fs.writeFileSync(FLAGS_FILE, JSON.stringify(f, null, 2)); } catch (e) { console.error('[Contactos] No se pudo guardar la marca', k, e.message); } }
const uneLista = (actual, nuevo) => { const a = String(actual || '').split(/[,;\n]+/).map(x => x.trim()).filter(Boolean); if (!a.some(x => x.toLowerCase() === nuevo.toLowerCase())) a.push(nuevo); return a.join(', '); };

async function cargarCatalogoRuta({ archivo, ruta, flag }) {
  let lista;
  try { lista = require('../data/' + archivo); } catch { return; }
  const yaFusionado = !!leerFlags()[flag];
  let nuevos = 0, fusionados = 0, fallos = 0;
  for (const p of lista) {
    try {
      const inactivo = ['Baja', 'Suspendido'].includes(p.estatus_catalogo);
      const linea = `${ruta}: $${Number(p.costo_promedio).toLocaleString('es-MX')} promedio · ${p.servicios} servicio(s) en la ruta`;
      let c = null;
      if (p.fusionar_con_telefono) c = await buscarPorTelefono(p.fusionar_con_telefono, 'sofia');
      if (!c && p.telefono && !p.fusionar_con_telefono) c = await buscarPorTelefono(p.telefono, 'sofia');
      if (!c && !p.telefono) c = (await listarPorAgente('SOFIA', { tipo: 'proveedor', q: p.empresa })).find(x => (x.empresa || '') === p.empresa) || null;
      if (!c) {
        c = await upsertContacto({
          agente: 'sofia', tipo: 'proveedor', nombre_completo: p.nombre, empresa: p.empresa, telefono: p.telefono || undefined,
          notas: `Clave: ${p.codigo} · Estatus en catálogo: ${p.estatus_catalogo}`,
          rutas: inactivo ? undefined : ruta, unidades: UNIDAD_DEFAULT,
          resumen_interaccion: `Alta desde el catálogo de proveedores (ruta ${ruta})`, canal: 'permanente',
        });
        await actualizarCampoProveedor(c.id, 'tarifas', linea);
        nuevos++;
      } else if (!yaFusionado) {
        if (!inactivo) await actualizarCampoProveedor(c.id, 'rutas', uneLista(c.rutas, ruta));
        if (!String(c.tarifas || '').includes(ruta)) await actualizarCampoProveedor(c.id, 'tarifas', [c.tarifas, linea].filter(Boolean).join(' | '));
        fusionados++;
      }
    } catch (e) { fallos++; console.error(`[Contactos] Error cargando proveedor ${p.codigo} (${archivo}):`, e.message); }
  }
  if (!fallos) marcarFlag(flag);
  if (nuevos || fusionados) console.log(`[Contactos] ${ruta}: ${nuevos} proveedores nuevos, ${fusionados} existentes actualizados`);
}

// Completa SOLO los campos que el contacto todavía no tiene (nunca pisa lo que ya hay)
async function rellenarSiVacio(id, campos) {
  const permitidos = ['empresa', 'notas', 'rutas', 'unidades']; // lista blanca: el nombre de columna nunca viene de fuera
  const entradas = Object.entries(campos || {}).filter(([k, v]) => permitidos.includes(k) && v);
  if (!entradas.length) return false;
  if (USA_DB) {
    try {
      await db.asegurarColumnasContactos();
      const sets = entradas.map(([k], i) => `${k} = COALESCE(NULLIF(${k}, ''), $${i + 1})`).join(', ');
      await db.query(`UPDATE contactos SET ${sets} WHERE id = $${entradas.length + 1}`, [...entradas.map(([, v]) => v), id]);
      return true;
    } catch (e) { console.error('[Contactos] Postgres falló al completar campos, cae a archivo:', e.message); }
  }
  const c = cache.find(x => x.id === id);
  if (!c) return false;
  for (const [k, v] of entradas) if (!c[k]) c[k] = v;
  guardarDisco();
  return true;
}

// ── Top 50 rutas más importantes (PDF, ene-sep 2026) ────────────────────────
// backend/data/proveedores-top50-rutas.json: 50 rutas, ya ordenadas de la que
// más se coloca a la que menos (rank 1→50 por servicios_totales), y dentro de
// cada ruta sus proveedores ya ordenados de más a menos colocaciones. Se
// procesan en ese mismo orden. Por proveedor se guarda: ruta(s) que maneja,
// teléfono, costo mínimo (en "tarifas", nunca en notas), contacto y cuántas
// veces colocó esa ruta — mismo criterio de "solo se completa lo que falte"
// que el resto de este archivo: nunca pisa lo que ya haya en la Base de Datos.
async function cargarTop50Rutas({ archivo = 'proveedores-top50-rutas.json', flag = 'top50-rutas-oct-2026' } = {}) {
  if (leerFlags()[flag]) return;
  let rutas;
  try { rutas = require('../data/' + archivo); } catch { return; }
  let nuevos = 0, actualizados = 0, fallos = 0;
  for (const ruta of rutas) {
    const rutaLabel = ruta.destino;
    for (const p of ruta.proveedores) {
      try {
        const tel = p.telefono && p.telefono !== 'Sin información' ? p.telefono : null;
        const nombre = p.contacto && p.contacto !== 'Sin información' ? p.contacto : p.empresa;
        const costoTxt = (p.costo_minimo === null || p.costo_minimo === undefined) ? 'sin dato' : `$${Number(p.costo_minimo).toLocaleString('es-MX')}`;
        const linea = `${rutaLabel}: ${costoTxt} mínimo · ${p.total} servicio(s) colocados (Top 50 Rutas ene-sep 2026)`;

        let c = null;
        if (tel) c = await buscarPorTelefono(tel, 'sofia');
        if (!c) c = (await listarPorAgente('SOFIA', { tipo: 'proveedor', q: p.empresa })).find(x => (x.empresa || '') === p.empresa) || null;

        if (!c) {
          c = await upsertContacto({
            agente: 'sofia', tipo: 'proveedor', nombre_completo: nombre, empresa: p.empresa, telefono: tel || undefined,
            notas: `Clave: ${p.codigo}`, rutas: rutaLabel, unidades: UNIDAD_DEFAULT,
            resumen_interaccion: `Alta desde Top 50 Rutas (${rutaLabel})`, canal: 'permanente',
          });
          await actualizarCampoProveedor(c.id, 'tarifas', linea);
          nuevos++;
        } else {
          await actualizarCampoProveedor(c.id, 'rutas', uneLista(c.rutas, rutaLabel));
          if (!String(c.tarifas || '').includes(rutaLabel)) await actualizarCampoProveedor(c.id, 'tarifas', [c.tarifas, linea].filter(Boolean).join(' | '));
          await rellenarSiVacio(c.id, { empresa: p.empresa, notas: `Clave: ${p.codigo}`, unidades: UNIDAD_DEFAULT });
          actualizados++;
        }
      } catch (e) { fallos++; console.error(`[Contactos] Error cargando ${p.codigo} en ruta ${rutaLabel}:`, e.message); }
    }
  }
  if (!fallos) marcarFlag(flag);
  console.log(`[Contactos] Top 50 Rutas: ${nuevos} proveedores nuevos, ${actualizados} existentes actualizados${fallos ? `, ${fallos} con error (se reintenta en el próximo arranque)` : ''}`);
}

// ── Clientes (destino) del Top 50 de rutas ──────────────────────────────────
// backend/data/clientes-top50-rutas.json: la empresa/CEDIS que RECIBE la carga
// en cada una de las 50 rutas (columna "Cliente / Destino" del PDF, distinta
// del transportista que mueve la carga). No trae teléfono ni contacto — se
// identifica por nombre de empresa, no por teléfono como los proveedores.
async function cargarClientesTop50Rutas({ archivo = 'clientes-top50-rutas.json', flag = 'clientes-top50-rutas-oct-2026' } = {}) {
  if (leerFlags()[flag]) return;
  let clientes;
  try { clientes = require('../data/' + archivo); } catch { return; }
  let nuevos = 0, actualizados = 0, fallos = 0;
  for (const cl of clientes) {
    try {
      const notaUbicacion = `CEDIS/cliente destino en ${cl.ciudad}, ${cl.estado} (Top 50 Rutas ene-sep 2026)`;
      let c = (await listarPorAgente('SOFIA', { tipo: 'cliente', q: cl.empresa })).find(x => (x.empresa || '') === cl.empresa) || null;

      if (!c) {
        await upsertContacto({
          agente: 'sofia', tipo: 'cliente', nombre_completo: cl.empresa, empresa: cl.empresa,
          notas: notaUbicacion, rutas: cl.ruta,
          resumen_interaccion: `Alta desde Top 50 Rutas (${cl.ruta})`, canal: 'permanente',
        });
        nuevos++;
      } else {
        await actualizarCampoProveedor(c.id, 'rutas', uneLista(c.rutas, cl.ruta));
        await rellenarSiVacio(c.id, { notas: notaUbicacion });
        actualizados++;
      }
    } catch (e) { fallos++; console.error(`[Contactos] Error cargando cliente ${cl.empresa} (ruta ${cl.ruta}):`, e.message); }
  }
  if (!fallos) marcarFlag(flag);
  console.log(`[Contactos] Clientes Top 50 Rutas: ${nuevos} clientes nuevos, ${actualizados} existentes actualizados${fallos ? `, ${fallos} con error (se reintenta en el próximo arranque)` : ''}`);
}

// ── Directorio completo de proveedores (PDF de AppSheet, 27-sep-2026) ───────
// Clave, proveedor, contacto, teléfono, unidades (caja seca 53) y sus 3 rutas
// principales. Proveedor nuevo (por teléfono) → se crea completo. Proveedor que
// ya existía → SOLO se le completa lo que le falte (empresa, clave, unidades,
// rutas); nada de lo que ya tiene se sobreescribe. Sin rutas en el catálogo (nunca
// tuvieron servicios) = se guardan sin ruta y SOFIA no los contacta sola.
async function cargarDirectorio({ archivo, flag }) {
  if (leerFlags()[flag]) return;
  let lista;
  try { lista = require('../data/' + archivo); } catch { return; }
  let nuevos = 0, completados = 0, fallos = 0;
  for (const p of lista) {
    try {
      const notasNuevas = `Clave: ${p.codigo} · Estatus en catálogo: ${p.estatus_catalogo}` + (p.telefono_incompleto ? ` · Teléfono incompleto en catálogo: ${p.telefono_incompleto}` : '');
      let c = null;
      if (p.telefono) c = await buscarPorTelefono(p.telefono, 'sofia');
      else c = (await listarPorAgente('SOFIA', { tipo: 'proveedor', q: p.empresa })).find(x => (x.empresa || '') === p.empresa) || null;
      if (!c) {
        await upsertContacto({
          agente: 'sofia', tipo: 'proveedor', nombre_completo: p.nombre, empresa: p.empresa, telefono: p.telefono || undefined,
          notas: notasNuevas, rutas: p.rutas.length ? p.rutas.join(', ') : undefined, unidades: UNIDAD_DEFAULT,
          resumen_interaccion: 'Alta desde el directorio de proveedores con teléfono', canal: 'permanente',
        });
        nuevos++;
      } else {
        const ok = await rellenarSiVacio(c.id, { empresa: p.empresa, notas: notasNuevas, unidades: UNIDAD_DEFAULT, rutas: p.rutas.join(', ') });
        if (ok) completados++;
      }
    } catch (e) { fallos++; console.error(`[Contactos] Error cargando ${p.codigo} del directorio:`, e.message); }
  }
  if (!fallos) marcarFlag(flag);
  console.log(`[Contactos] Directorio: ${nuevos} proveedores nuevos, ${completados} existentes completados${fallos ? `, ${fallos} con error (se reintenta en el próximo arranque)` : ''}`);
}

// Unidad por defecto para todo proveedor de SOFIA que no tenga nada capturado (una sola vez)
async function unidadPorDefectoProveedores() {
  const flag = 'unidad-default-caja-seca-53';
  if (leerFlags()[flag]) return;
  try {
    const lista = await listarPorAgente('SOFIA', { tipo: 'proveedor' });
    let n = 0;
    for (const c of lista) if (!String(c.unidades || '').trim()) { await actualizarCampoProveedor(c.id, 'unidades', UNIDAD_DEFAULT); n++; }
    marcarFlag(flag);
    if (n) console.log(`[Contactos] Unidad "${UNIDAD_DEFAULT}" asignada a ${n} proveedores sin unidades`);
  } catch (e) { console.error('[Contactos] Error asignando unidad por defecto:', e.message); }
}

// ── Limpieza total de "rutas" — pedido explícito del usuario (06-oct-2026) ──
// Vacía el campo "rutas" de TODOS los proveedores y clientes (los del Top 50
// y también los de catálogos/directorio viejos), una sola vez. Después
// resetea las marcas del Top 50 para que cargarTop50Rutas()/
// cargarClientesTop50Rutas() lo vuelvan a sembrar completo y limpio, sin el
// corte a medias que había quedado antes ni el formato viejo de rutas.
// Las marcas de catálogo/directorio NO se resetean a propósito: esas rutas
// viejas (ej. "Monterrey-Guadalajara", flechas "→") quedan fuera para
// siempre, que es justo lo que se pidió.
async function limpiarTodasLasRutas() {
  const flag = 'limpieza-total-rutas-2026-10-06';
  if (leerFlags()[flag]) return;
  let limpiados = 0, fallos = 0;
  for (const tipo of ['proveedor', 'cliente']) {
    for (const agente of ['SARA', 'SOFIA', 'NOA']) {
      let lista;
      try { lista = await listarPorAgente(agente, { tipo }); } catch (e) { console.error(`[Contactos] Error listando ${tipo}/${agente} para limpiar rutas:`, e.message); continue; }
      for (const c of lista) {
        if (!String(c.rutas || '').trim()) continue;
        try { await actualizarCampoProveedor(c.id, 'rutas', ''); limpiados++; }
        catch (e) { fallos++; console.error(`[Contactos] Error limpiando rutas de ${c.id}:`, e.message); }
      }
    }
  }
  if (!fallos) {
    marcarFlag(flag);
    const f = leerFlags();
    delete f['top50-rutas-oct-2026'];
    delete f['clientes-top50-rutas-oct-2026'];
    try { fs.writeFileSync(FLAGS_FILE, JSON.stringify(f, null, 2)); } catch (e) { console.error('[Contactos] No se pudieron resetear las marcas del Top 50:', e.message); }
  }
  console.log(`[Contactos] Limpieza total de rutas: ${limpiados} contactos vaciados${fallos ? `, ${fallos} con error (se reintenta en el próximo arranque)` : ''}`);
}

async function sembrarCatalogos() {
  await limpiarTodasLasRutas();
  await cargarCatalogoRuta({ archivo: 'proveedores-mty-gomez-palacio.json', ruta: 'Monterrey-Gómez Palacio', flag: 'catalogo-mty-gp-2026-09-27' });
  await cargarCatalogoRuta({ archivo: 'proveedores-mty-guadalajara.json', ruta: 'Monterrey-Guadalajara', flag: 'catalogo-mty-gdl-2026-09-27' });
  await cargarDirectorio({ archivo: 'proveedores-directorio.json', flag: 'directorio-proveedores-2026-09-27' });
  await cargarTop50Rutas();
  await cargarClientesTop50Rutas();
  await unidadPorDefectoProveedores();
}

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
sembrarContactosPermanentes().then(sembrarRutasIniciales).then(sembrarCatalogos);

module.exports = { bloqueDirectorioProveedores, protegerDatosProveedores, actualizarRutas, actualizarUnidades, upsertContacto, listarPorAgente, obtenerDetalle, buscarPorTelefono, bloqueContactoConocido };
