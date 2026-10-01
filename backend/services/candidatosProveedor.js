// ── Candidatos a proveedor — alta pendiente de revisión humana ─────────────
// Pedido explícito del usuario (01-oct-2026): va a poner el número de SOFIA
// como CTA de un anuncio de Meta para atraer proveedores nuevos. Un contacto
// nuevo que se presenta (sin que haya un trato cerrado) NO se da de alta solo
// — SOFIA junta sus datos básicos y los deja aquí, pendientes, para que una
// persona del equipo los revise y apruebe desde Base de Datos antes de que
// entren de verdad al directorio de proveedores.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/candidatos-proveedor.json');
let candidatos = [];
try { if (fs.existsSync(FILE)) candidatos = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { console.error('[candidatosProveedor] No se pudo leer el archivo:', e.message); }

function guardar() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(candidatos, null, 2)); }
  catch (e) { console.error('[candidatosProveedor] Error guardando:', e.message); }
}

const tel10 = t => String(t || '').replace(/\D/g, '').slice(-10);

// Si ya hay un candidato pendiente con ese teléfono, se actualiza con los
// datos nuevos (SOFIA puede ir completando la info en mensajes seguidos) en
// vez de crear una fila duplicada por cada mensaje.
function agregar({ nombre, telefono, empresa, unidades, rutas, resumen }) {
  if (!telefono) return null;
  const t10 = tel10(telefono);
  let c = candidatos.find(x => x.estado === 'pendiente' && tel10(x.telefono) === t10);
  if (c) {
    if (nombre) c.nombre = nombre;
    if (empresa) c.empresa = empresa;
    if (unidades) c.unidades = unidades;
    if (rutas) c.rutas = rutas;
    if (resumen) c.resumen = resumen;
    c.actualizadoEn = new Date().toISOString();
  } else {
    c = {
      id: 'CP-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase(),
      nombre: nombre || '', telefono, empresa: empresa || '', unidades: unidades || '', rutas: rutas || '', resumen: resumen || '',
      estado: 'pendiente', creadoEn: new Date().toISOString(), actualizadoEn: new Date().toISOString(),
    };
    candidatos.push(c);
  }
  guardar();
  return c;
}

const listar = (estado = 'pendiente') => candidatos.filter(c => !estado || c.estado === estado);
const obtener = id => candidatos.find(c => c.id === id) || null;

function resolver(id, estado) {
  const c = obtener(id);
  if (!c) return null;
  c.estado = estado;
  c.resueltoEn = new Date().toISOString();
  guardar();
  return c;
}

module.exports = { agregar, listar, obtener, resolver };
