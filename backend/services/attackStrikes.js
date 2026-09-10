// ─── ATTACK STRIKES — bloqueo a la 3ra coincidencia de attackWordlist.js ─────
// Punto 2 del checklist de Rafael: "crear la acción de bloqueo personal a una
// IP o persona a una cantidad de 3 intentos de hackeo". A diferencia de
// promptLeakGuard.js (zero-tolerance, banea desde el 1er intento por orden
// directa de Diego), esta lista es más ruidosa/propensa a falsos positivos —
// por eso acumula strikes y solo banea (vía ipBanlist/phoneBanlist) al llegar
// al límite. Memoria + disco — mismo patrón que ipBanlist.js.
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/attack-strikes.json');
const LIMITE = 3;

function loadFromDisk() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return {};
}

// { [identificador]: { count, intentos: [{ palabra, ts }] } }
const cache = loadFromDisk();

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(cache, null, 2)); }
    catch (e) { console.error('[attackStrikes] Error guardando en disco:', e.message); }
  }, 1000);
}

// Registra un intento para el identificador (IP o teléfono normalizado).
// Devuelve { count, alcanzoLimite } — el llamador decide si banea al llegar
// a LIMITE (así queda en manos de server-lite.js invocar ipBanlist/phoneBanlist).
function registrar(identificador, palabra) {
  if (!identificador) return { count: 0, alcanzoLimite: false };
  const entry = cache[identificador] || { count: 0, intentos: [] };
  entry.count += 1;
  entry.intentos.push({ palabra, ts: new Date().toISOString() });
  if (entry.intentos.length > 10) entry.intentos = entry.intentos.slice(-10);
  cache[identificador] = entry;
  scheduleSave();
  return { count: entry.count, alcanzoLimite: entry.count >= LIMITE };
}

function contar(identificador) {
  return cache[identificador]?.count || 0;
}

function listar() {
  return Object.entries(cache).map(([identificador, datos]) => ({ identificador, ...datos }));
}

module.exports = { registrar, contar, listar, LIMITE };
