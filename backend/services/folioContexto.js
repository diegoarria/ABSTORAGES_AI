// ── Contexto de un folio: notas del equipo + imágenes ───────────────────────
// Al capturar una orden manual, el equipo puede dejar indicaciones en texto y
// fotos/imágenes (orden de compra, packing list, foto de la carga, etc.). Cada
// imagen se describe una sola vez con visión, y esa descripción —junto con las
// notas— pasa a la memoria de SARA, SOFIA y NOA, por WhatsApp y por llamada.
//
// Privacidad: con el equipo interno se comparte el panorama de los folios
// recientes. Con un proveedor o cliente, SOLO el folio en el que participa, y el
// bloque le indica a la IA qué no puede repetir (precio del cliente, datos del
// cliente, etc.). Las imágenes se guardan en data/folio-adjuntos/ (volumen).
const fs = require('fs');
const path = require('path');
const claude = require('./claude');

const DATA_DIR = path.join(__dirname, '../../data');
const FILE = path.join(DATA_DIR, 'folio-contexto.json');
const DIR_ADJ = path.join(DATA_DIR, 'folio-adjuntos');
const MAX_BYTES = 8 * 1024 * 1024;
const VIGENCIA_DIAS = 21;

let db = {};
try { if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { console.error('[folioContexto] No se pudo leer:', e.message); }
let timer = null;
function guardar() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2)); fs.renameSync(FILE + '.tmp', FILE); }
    catch (e) { console.error('[folioContexto] Error guardando:', e.message); }
  }, 300);
}

const claveFolio = f => String(f || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
const tel10 = t => String(t || '').replace(/\D/g, '').slice(-10);
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function registrar(folio, { notas, resumen, por } = {}) {
  const k = claveFolio(folio); if (!k) return null;
  const e = db[k] || { folio: k, adjuntos: [], notas: '', creado: new Date().toISOString() };
  if (notas && String(notas).trim()) e.notas = String(notas).trim().slice(0, 4000);
  if (resumen) e.resumen = { ...(e.resumen || {}), ...resumen, telefono10: tel10(resumen.telefono) };
  if (por) e.por = por;
  db[k] = e; guardar(); return e;
}

function agregarNota(folio, texto, por) {
  const k = claveFolio(folio); const e = db[k]; if (!e) return null;
  const linea = `[${new Date().toLocaleDateString('es-MX')} ${por || 'equipo'}] ${String(texto).trim().slice(0, 1500)}`;
  e.notas = (e.notas ? e.notas + '\n' : '') + linea; guardar(); return e;
}

async function describirImagen(buffer, mime) {
  try {
    const t = await claude.chat(
      'Eres el asistente de operaciones de una empresa de transporte de carga en México. Describe en español, en máximo 4 frases, lo que muestra la imagen y que sea útil para operar un flete: si es un documento (orden de compra, packing list, carta porte, factura), resume sus datos clave (cantidades, fechas, direcciones, referencias); si es una foto de mercancía, unidad o instalación, describe qué se ve, condiciones y cualquier detalle relevante. No inventes nada que no se vea. No repitas números de teléfono ni correos.',
      [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data: buffer.toString('base64') } }, { type: 'text', text: 'Describe esta imagen para el equipo de operaciones.' }] }],
      { maxTokens: 350 }
    );
    return String(t || '').trim().slice(0, 900);
  } catch (e) { console.error('[folioContexto] No se pudo describir la imagen:', e.message); return null; }
}

async function agregarAdjunto(folio, buffer, mime, nombre) {
  const k = claveFolio(folio); const e = db[k];
  if (!e) throw new Error('Folio sin contexto registrado');
  if (!EXT[mime]) throw new Error('Formato no soportado (usa JPG, PNG, WEBP o GIF)');
  if (buffer.length > MAX_BYTES) throw new Error('La imagen pesa más de 8 MB');
  if (e.adjuntos.length >= 12) throw new Error('Máximo 12 imágenes por folio');
  const id = 'IMG' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
  const archivo = `${id}.${EXT[mime]}`;
  const dir = path.join(DIR_ADJ, k);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, archivo), buffer);
  const adj = { id, archivo, mime, nombre: String(nombre || archivo).slice(0, 80), descripcion: null, en: new Date().toISOString() };
  e.adjuntos.push(adj); guardar();
  // La descripción tarda unos segundos — no bloquea la subida
  describirImagen(buffer, mime).then(d => { adj.descripcion = d; guardar(); });
  return { id, archivo, nombre: adj.nombre };
}

const obtener = folio => db[claveFolio(folio)] || null;
function rutaArchivo(folio, id) {
  const e = obtener(folio); const a = e?.adjuntos.find(x => x.id === id); if (!a) return null;
  return { ruta: path.join(DIR_ADJ, claveFolio(folio), a.archivo), mime: a.mime };
}
function publico(e) { return e && { folio: e.folio, notas: e.notas, resumen: e.resumen, creado: e.creado, adjuntos: e.adjuntos.map(a => ({ id: a.id, nombre: a.nombre, descripcion: a.descripcion, en: a.en })) }; }

// Bloque de texto para la instrucción de un agente.
//  alcance 'equipo'  → todos los folios recientes
//  alcance 'folios'  → solo los folios indicados (proveedor/cliente involucrado)
function bloque({ alcance = 'equipo', folios = [], max = 12 } = {}) {
  const limite = Date.now() - VIGENCIA_DIAS * 86400000;
  let lista = Object.values(db).filter(e => (e.notas || e.adjuntos.length) && new Date(e.creado).getTime() > limite);
  if (alcance === 'folios') { const set = new Set(folios.map(claveFolio)); lista = lista.filter(e => set.has(e.folio)); }
  lista = lista.sort((a, b) => new Date(b.creado) - new Date(a.creado)).slice(0, max);
  if (!lista.length) return '';
  const filas = lista.map(e => {
    const r = e.resumen || {};
    const cab = [r.empresa, [r.origen, r.destino].filter(Boolean).join(' → '), r.tipo_unidad].filter(Boolean).join(' · ');
    const imgs = e.adjuntos.filter(a => a.descripcion).map((a, i) => `   · Imagen ${i + 1} (${a.nombre}): ${a.descripcion}`).join('\n');
    const sinDesc = e.adjuntos.filter(a => !a.descripcion).length;
    return `- Folio ${e.folio}${cab ? ' — ' + cab : ''}\n` +
      (e.notas ? `   Indicaciones del equipo: ${e.notas.replace(/\n/g, ' / ')}\n` : '') + (imgs ? imgs + '\n' : '') + (sinDesc ? `   (${sinDesc} imagen(es) más sin describir aún)\n` : '');
  }).join('');
  const reglas = alcance === 'folios'
    ? 'Es información interna de ESTE servicio para que sepas qué se está pidiendo. Úsala para atender bien, pero NO compartas precios pactados con el cliente, datos personales, ni información que no le corresponda a la persona con la que hablas.'
    : 'Es información interna que el equipo dejó al capturar cada orden, para que estés al tanto de lo que se está pidiendo. Úsala para responderle al equipo y para atender bien cada servicio. Nunca la compartas con clientes o proveedores más allá de lo que a ellos les corresponde (ruta, unidad, fecha y requisitos de la carga); jamás precios del cliente ni datos personales.';
  return `\n\n---\n## CONTEXTO DE FOLIOS CAPTURADOS POR EL EQUIPO\n${reglas}\n${filas}---\n`;
}

// Folios de un proveedor/cliente por su teléfono (para acotar el bloque)
function foliosPorTelefono(telefono) {
  const t = tel10(telefono); if (!t) return [];
  return Object.values(db).filter(e => e.resumen?.telefono10 === t).map(e => e.folio);
}

module.exports = { registrar, agregarNota, agregarAdjunto, obtener, publico, rutaArchivo, bloque, foliosPorTelefono, claveFolio, MAX_BYTES };
