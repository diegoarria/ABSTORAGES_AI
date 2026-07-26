// ── Registro persistente de llamadas de Vapi (SOFIA / SARA / NOA) ────────────
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/llamadas.json');
const MAX_REGISTROS = 2000;

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
    catch (e) { console.error('[callLog] Error guardando:', e.message); }
  }, 500);
}

function registrar(entrada) {
  const registro = {
    id: `CALL-${Date.now().toString(36).toUpperCase()}`,
    timestamp: new Date().toISOString(),
    ...entrada,
  };
  cache.push(registro);
  if (cache.length > MAX_REGISTROS) cache = cache.slice(-MAX_REGISTROS);
  guardarDisco();
  return registro;
}

function listar({ agente, limit = 200 } = {}) {
  let rows = [...cache].reverse();
  if (agente) rows = rows.filter(r => r.agente === agente);
  return rows.slice(0, limit);
}

module.exports = { registrar, listar };
