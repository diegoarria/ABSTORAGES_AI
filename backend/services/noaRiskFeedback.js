// ── Calibración del risk score de noaMonitoreo.js ───────────────────────────
// Separado a propósito de incidentesNOA.js: ese archivo alimenta lo que NOA
// dice en llamadas de voz (solo incidentes CRÍTICOS reales) — mezclar ahí
// cada anomalía MEDIUM/HIGH del motor de risk score inflaría ese contexto
// con ruido y cambiaría el comportamiento de las llamadas sin que nadie lo
// haya pedido. Esto es solo para responder una pregunta distinta: "¿los
// umbrales del risk score están bien puestos, o generan puro ruido?"
//
// Un "episodio" = un tramo continuo en el que un folio estuvo en MEDIUM+
// (ver noaMonitoreo.js) — se cierra y se registra aquí cuando el folio
// vuelve a NORMAL. El equipo marca después si fue 'real' o 'ruido' desde
// el dashboard (ver /api/noa/riesgo-feedback en server-lite.js).
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/noa-risk-episodios.json');
const MAX_REGISTROS = 500;

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
    catch (e) { console.error('[noaRiskFeedback] Error guardando:', e.message); }
  }, 500);
}

function registrarEpisodio({ folio, desde, maxSeveridad, maxScore, tipos }) {
  const registro = {
    id: `EP-${Date.now().toString(36).toUpperCase()}`,
    folio: folio || null, desde: desde || null, cerradoEn: new Date().toISOString(),
    maxSeveridad: maxSeveridad || null, maxScore: maxScore ?? null, tipos: tipos || [],
    feedback: null, feedbackEn: null,
  };
  cache.push(registro);
  if (cache.length > MAX_REGISTROS) cache = cache.slice(-MAX_REGISTROS);
  guardarDisco();
  return registro;
}

// feedback: 'real' | 'ruido'
function marcarFeedback(id, feedback) {
  const ep = cache.find(e => e.id === id);
  if (!ep) return null;
  ep.feedback = feedback;
  ep.feedbackEn = new Date().toISOString();
  guardarDisco();
  return ep;
}

function listar({ limit = 50, folio } = {}) {
  let lista = [...cache].reverse();
  if (folio) lista = lista.filter(e => e.folio === folio);
  return lista.slice(0, limit);
}

// Precisión por tipo de anomalía — de los episodios ya marcados, cuántos
// donde ese tipo apareció fueron 'real' vs 'ruido'. Para ajustar umbrales
// con datos reales en vez de a ojo.
function resumenPorTipo() {
  const porTipo = {};
  for (const ep of cache) {
    if (!ep.feedback) continue;
    for (const t of ep.tipos) {
      porTipo[t] = porTipo[t] || { real: 0, ruido: 0 };
      porTipo[t][ep.feedback === 'real' ? 'real' : 'ruido']++;
    }
  }
  return porTipo;
}

module.exports = { registrarEpisodio, marcarFeedback, listar, resumenPorTipo };
