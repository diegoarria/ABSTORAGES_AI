// ── Registro de incidentes/alertas críticas de NOA — aprendizaje de resultados ─
// Cada vez que se dispara ALERTA_CRITICA se guarda aquí. El resultado (si se
// resolvió bien, mal, o fue falsa alarma) se marca después vía
// POST /api/admin/incidentes/:id/resolver — y ese historial se le inyecta a
// NOA como contexto, para que su criterio se calibre con resultados reales
// en vez de seguir el protocolo en automático sin memoria de qué pasó antes.
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/incidentes-noa.json');
const MAX_REGISTROS = 1000;

function cargar() {
  try { if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  return [];
}

let cache = cargar();
let saveTimer = null;
function guardarDisco() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(cache, null, 2)); }
    catch (e) { console.error('[incidentesNOA] Error guardando:', e.message); }
  }, 500);
}

function registrar({ folio, motivo, canal, duplicado_de }) {
  const registro = {
    id: `INC-${Date.now().toString(36).toUpperCase()}`,
    folio: folio || null, motivo: motivo || null, canal: canal || null,
    timestamp: new Date().toISOString(),
    resultado: null, notas: null, resuelto_en: null,
    duplicado_de: duplicado_de || null,
  };
  cache.push(registro);
  if (cache.length > MAX_REGISTROS) cache = cache.slice(-MAX_REGISTROS);
  guardarDisco();
  return registro;
}

// ¿Ya se reportó algo igual/muy parecido hace poco? — evita que NOA dispare
// una alerta masiva nueva sobre algo que el equipo ya está atendiendo (caso
// real: "lo de Peñafiel", donde la alerta llegó cuando el equipo ya lo tenía
// controlado). Match por folio exacto, o por overlap de palabras clave del
// motivo si no hay folio — no es perfecto, pero corta el caso obvio de
// "mismo evento, mismo minuto/hora, distinto disparador".
const VENTANA_DEDUP_MIN = 60;
// Vocabulario genérico de incidentes — se excluye del match por palabra
// clave para no confundir dos eventos DISTINTOS que solo comparten el tipo
// de incidente (ej. dos robos reales en rutas distintas el mismo día no
// deben deduplicarse solo por decir "robo" los dos).
const PALABRAS_GENERICAS_INCIDENTE = new Set([
  'robo', 'robos', 'accidente', 'accidentes', 'tránsito', 'transito',
  'situación', 'situacion', 'control', 'alerta', 'crítica', 'critica',
  'reporta', 'reportó', 'reporto', 'operador', 'unidad', 'ruta',
  'confirmado', 'inmediato', 'revisar', 'sobre', 'está', 'esta',
]);
function buscarRecienteSimilar({ folio, motivo }) {
  const limiteMs = VENTANA_DEDUP_MIN * 60 * 1000;
  const ahora = Date.now();
  return cache.find(i => {
    if (i.duplicado_de) return false; // no encadenar duplicados de duplicados
    if (ahora - new Date(i.timestamp).getTime() > limiteMs) return false;
    if (folio && i.folio && folio === i.folio) return true;
    if (motivo && i.motivo) {
      // Basta con 1 palabra DISTINTIVA en común (ej. nombre de cliente/lugar
      // como "Peñafiel") — se excluye el vocabulario genérico de incidentes
      // para no fusionar dos eventos reales distintos solo porque ambos
      // dicen "robo" o "accidente".
      const esDistintiva = w => w.length > 3 && !PALABRAS_GENERICAS_INCIDENTE.has(w);
      const palabrasNuevas = new Set(motivo.toLowerCase().split(/\s+/).filter(esDistintiva));
      const comunes = i.motivo.toLowerCase().split(/\s+/).filter(w => esDistintiva(w) && palabrasNuevas.has(w));
      if (comunes.length >= 1) return true;
    }
    return false;
  }) || null;
}

// resultado: 'bien' | 'mal' | 'falsa_alarma'
function marcarResultado(id, resultado, notas) {
  const inc = cache.find(i => i.id === id);
  if (!inc) return null;
  inc.resultado = resultado;
  inc.notas = notas || null;
  inc.resuelto_en = new Date().toISOString();
  guardarDisco();
  return inc;
}

function listar({ limit = 100 } = {}) {
  return [...cache].reverse().slice(0, limit);
}

// Bloque de contexto para inyectar en el prompt de NOA — patrones de
// incidentes pasados con resultado ya conocido (los pendientes de resolver
// no aportan lección todavía, se excluyen).
function bloqueAprendizaje(limit = 8) {
  const resueltos = cache.filter(i => i.resultado).slice(-limit).reverse();
  if (!resueltos.length) return '';
  const lineas = resueltos.map(i => {
    const etiqueta = i.resultado === 'bien' ? '✅ se resolvió bien'
      : i.resultado === 'falsa_alarma' ? '⚪ fue falsa alarma'
      : '❌ no se resolvió bien';
    return `- ${new Date(i.timestamp).toLocaleDateString('es-MX')} · ${i.motivo || 'sin detalle'}${i.folio ? ` (folio ${i.folio})` : ''} → ${etiqueta}${i.notas ? `: ${i.notas}` : ''}`;
  }).join('\n');
  return (
    `\n\n---\n\n## 📚 APRENDIZAJE DE INCIDENTES PASADOS\n` +
    `Últimos incidentes críticos reales con resultado conocido — úsalos para calibrar tu criterio, no los repitas textualmente ni los menciones a menos que sea relevante para la situación actual:\n${lineas}\n\n` +
    `Si la situación actual se parece a una donde algo NO salió bien, sé más cauteloso y rápido para escalar. Si se parece a una que sí funcionó, replica ese mismo criterio.`
  );
}

module.exports = { registrar, marcarResultado, listar, bloqueAprendizaje, buscarRecienteSimilar };
