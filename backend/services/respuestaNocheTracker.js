// ─── Rastreo de respuestas a la ronda de las 9PM ────────────────────────────
// Pedido explícito del usuario (10-nov-2026): si un proveedor ya contestó al
// mensaje de la difusión de la noche (9PM, pregunta disponibilidad de
// "mañana" = hoy), la ronda de las 6AM del día siguiente ya NO debe
// volverle a escribir — se espera hasta la ronda de las 9PM otra vez.
//
// Dos marcas por teléfono: cuándo se le mandó la plantilla de la noche
// (difusionAsignadosManana.js) y cuándo llegó su última respuesta real por
// WhatsApp (server-lite.js, cualquier mensaje entrante a SOFIA). Si la
// respuesta es más reciente que el envío de la noche, ya contestó esa
// ronda — se salta en la de las 6AM.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../../data/respuesta-noche-tracker.json');
let estado = { envios: {}, respuestas: {} };
try { estado = { envios: {}, respuestas: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}

function guardar() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(estado)); }
  catch (e) { console.error('[respuestaNocheTracker] no se pudo guardar:', e.message); }
}

const tel10 = t => String(t || '').replace(/\D/g, '').slice(-10);

function marcarEnvioNoche(telefono) {
  const t = tel10(telefono);
  if (!t) return;
  estado.envios[t] = Date.now();
  guardar();
}

function marcarRespuesta(telefono) {
  const t = tel10(telefono);
  if (!t) return;
  estado.respuestas[t] = Date.now();
  guardar();
}

// true solo si el envío de la ronda de la noche existe Y la respuesta más
// reciente de ese proveedor llegó DESPUÉS de ese envío.
function yaRespondioALaNoche(telefono) {
  const t = tel10(telefono);
  if (!t) return false;
  const envio = estado.envios[t];
  const respuesta = estado.respuestas[t];
  return !!envio && !!respuesta && respuesta > envio;
}

module.exports = { marcarEnvioNoche, marcarRespuesta, yaRespondioALaNoche };
