// ── Embeddings — memoria semántica entre conversaciones distintas ──────────
// Punto #7 de la lista de mejoras (30-oct-2026). Anthropic no ofrece API de
// embeddings, así que esto mete un proveedor externo nuevo: OpenAI
// (text-embedding-3-small). Apagado por default — requiere
// MEMORIA_SEMANTICA=true Y OPENAI_API_KEY en el entorno.
//
// Qué resuelve que memory.js/reflexionMemoria.js (punto #6) no resuelve: los
// "hechos" del #6 viven dentro de la sesión de UNA persona — si el proveedor
// X se quejó de algo hace 3 meses, esa info solo vuelve a aparecer si X
// vuelve a escribir. Esto indexa esos mismos hechos en un espacio semántico
// compartido, para que un patrón aprendido con una persona pueda informar
// (nunca atribuirse) una conversación con otra.
//
// Enfoque: fuerza bruta en archivo plano, sin base vectorial nueva — a la
// escala actual (cientos de hechos, no millones) comparar contra todos con
// similitud de coseno en cada consulta es rápido y no mete infraestructura
// nueva. Si el volumen crece mucho (miles de hechos), esto habría que
// migrarse a una base vectorial real — no antes.
//
// CONFIDENCIALIDAD: los hechos que indexa ya vienen redactados en forma
// impersonal por reflexionMemoria.js (ej. "solo revisa WhatsApp de noche",
// nunca "Luis solo revisa..."), y lo que se le inyecta a OTRA conversación
// se marca explícitamente como "contexto general, no es sobre esta persona"
// — ver server-lite.js, el bloque que arma con buscarHechosRelevantes().
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const HABILITADO = process.env.MEMORIA_SEMANTICA === 'true' && !!OPENAI_API_KEY;
const MODELO = 'text-embedding-3-small';
const DIMENSIONES = 256; // los hechos son oraciones cortas — no hace falta la dimensión completa (1536)
const SIMILITUD_MINIMA = 0.5; // por debajo de esto no es un match real, es ruido
const MAX_ENTRADAS = 3000; // tope de seguridad — a este volumen el archivo sigue chico y la búsqueda sigue siendo instantánea

const INDEX_FILE = path.join(__dirname, '../../data/memoria-semantica.json');
let indice = [];
try { if (fs.existsSync(INDEX_FILE)) indice = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
catch (e) { console.error('[embeddings] No se pudo leer el índice:', e.message); }

let guardarTimer = null;
function guardarIndice() {
  clearTimeout(guardarTimer);
  guardarTimer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(INDEX_FILE), { recursive: true }); fs.writeFileSync(INDEX_FILE, JSON.stringify(indice)); }
    catch (e) { console.error('[embeddings] Error guardando el índice:', e.message); }
  }, 500);
}

async function embeber(texto) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: MODELO, input: texto, dimensions: DIMENSIONES }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.data[0].embedding;
}

function coseno(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Guarda un hecho ya extraído por reflexionMemoria.js en el índice semántico.
async function indexarHecho({ session, agente, texto }) {
  if (!HABILITADO || !texto) return;
  try {
    const vector = await embeber(texto);
    indice.push({ session, agente, texto, vector, ts: Date.now() });
    if (indice.length > MAX_ENTRADAS) indice.shift(); // el más viejo se va primero
    guardarIndice();
  } catch (e) { console.error('[embeddings] Error indexando hecho:', e.message); }
}

// Busca hechos semánticamente parecidos a queryTexto, de CUALQUIER sesión —
// excluye la sesión actual (eso ya lo cubre memory.buildContext, no hace
// falta duplicarlo aquí) y opcionalmente filtra por agente.
async function buscarHechosRelevantes(queryTexto, { excluirSession, agente, topK = 3 } = {}) {
  if (!HABILITADO || !indice.length || !queryTexto) return [];
  let queryVector;
  try { queryVector = await embeber(queryTexto); }
  catch (e) { console.error('[embeddings] Error en query:', e.message); return []; }

  return indice
    .filter(e => e.session !== excluirSession && (!agente || e.agente === agente))
    .map(e => ({ texto: e.texto, score: coseno(queryVector, e.vector) }))
    .filter(e => e.score >= SIMILITUD_MINIMA)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(c => c.texto);
}

module.exports = { indexarHecho, buscarHechosRelevantes, HABILITADO };
