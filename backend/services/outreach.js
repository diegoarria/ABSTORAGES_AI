// ── Outreach — Secuenciador multi-canal para prospectos ───────────────────────
// Flujo: LinkedIn DM → Email → WhatsApp → Llamada Vapi
// Cada prospecto tiene su estado y próxima acción programada

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const SECUENCIA = [
  { dia: 0,  canal: 'linkedin', asunto: 'Conexión inicial' },
  { dia: 1,  canal: 'email',    asunto: 'Presentación ABSTORAGES' },
  { dia: 3,  canal: 'whatsapp', asunto: 'Seguimiento WhatsApp' },
  { dia: 5,  canal: 'vapi',     asunto: 'Llamada SARA' },
  { dia: 8,  canal: 'email',    asunto: 'Seguimiento final' },
];

const ARCHIVO = path.join(__dirname, '../../data/prospectos.json');
let _store = [];

function cargar() {
  try { _store = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch { _store = []; }
}
function guardar() {
  fs.writeFileSync(ARCHIVO, JSON.stringify(_store, null, 2));
}
cargar();

// ── Agregar prospectos a la cola ──────────────────────────────────────────────
function agregarProspectos(lista) {
  const nuevos = [];
  for (const p of lista) {
    const existe = _store.find(s => s.email === p.email || s.linkedin === p.linkedin);
    if (!existe) {
      const prospecto = {
        ...p,
        estado:         'en_secuencia',
        pasoActual:     0,
        proximaAccion:  new Date().toISOString(),
        historial:      [],
        respuesta:      null,
        citaAgendada:   false,
      };
      _store.push(prospecto);
      nuevos.push(prospecto);
    }
  }
  guardar();
  return nuevos;
}

// ── Obtener prospectos con acción pendiente ahora ─────────────────────────────
function pendientes() {
  const ahora = new Date();
  return _store.filter(p =>
    p.estado === 'en_secuencia' &&
    p.pasoActual < SECUENCIA.length &&
    new Date(p.proximaAccion) <= ahora
  );
}

// ── Registrar resultado de una acción ─────────────────────────────────────────
function registrarAccion(id, canal, resultado, respuesta = null) {
  const p = _store.find(s => s.id === id);
  if (!p) return null;

  p.historial.push({
    canal,
    resultado,      // 'enviado' | 'error' | 'respondio' | 'no_interesado'
    respuesta,
    ts: new Date().toISOString(),
  });

  if (resultado === 'respondio') {
    p.estado   = 'respondio';
    p.respuesta = respuesta;
  } else if (resultado === 'no_interesado') {
    p.estado = 'descartado';
  } else if (resultado === 'enviado') {
    // Avanzar al siguiente paso
    p.pasoActual++;
    if (p.pasoActual >= SECUENCIA.length) {
      p.estado = 'secuencia_completa';
    } else {
      const sigPaso = SECUENCIA[p.pasoActual];
      const sig = new Date();
      sig.setDate(sig.getDate() + sigPaso.dia);
      p.proximaAccion = sig.toISOString();
    }
  }

  guardar();
  return p;
}

function marcarCita(id) {
  const p = _store.find(s => s.id === id);
  if (p) { p.citaAgendada = true; p.estado = 'cita_agendada'; guardar(); }
  return p;
}

// ── Queries ───────────────────────────────────────────────────────────────────
function listar(filtros = {}) {
  let res = [..._store];
  if (filtros.estado) res = res.filter(p => p.estado === filtros.estado);
  return res.sort((a, b) => (b.score || 0) - (a.score || 0));
}

function stats() {
  return {
    total:          _store.length,
    en_secuencia:   _store.filter(p => p.estado === 'en_secuencia').length,
    respondieron:   _store.filter(p => p.estado === 'respondio').length,
    citas:          _store.filter(p => p.citaAgendada).length,
    descartados:    _store.filter(p => p.estado === 'descartado').length,
    pendientes:     pendientes().length,
  };
}

module.exports = { agregarProspectos, pendientes, registrarAccion, marcarCita, listar, stats, SECUENCIA };
