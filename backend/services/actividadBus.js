// Bus mínimo hacia el feed "En vivo" — permite que los servicios (vapi,
// whatsappProactivo, monitoringControl…) publiquen actividad sin importar
// server-lite.js (donde vive pushActividad). server-lite lo conecta al arrancar.
let listener = null;
function conectar(fn) { listener = fn; }
function emitir(evento) {
  try { if (listener) listener(evento); } catch (e) { console.error('[actividadBus]', e.message); }
}
module.exports = { conectar, emitir };
