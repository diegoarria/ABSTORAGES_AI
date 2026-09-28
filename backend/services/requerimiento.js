// ── Requerimiento de unidad por WhatsApp ─────────────────────────────────────
// El equipo le pasa a SOFIA un mensaje con este formato (el que sale del TMS):
//   FOLIO:OP-ABS-26-2623
//   Cliente: BONAFONT
//   DE :CUAUTITLAN IZCALLI,MÉXICO A :RAMOS ARIZPE,COAHUILA DE ZARAGOZA
//   Tipo de Tractor :Caja 53
//   Cita de carga: 09/29/2026 20:00:00
//   Cita de descarga: 10/01/2026 22:00:00
// Se lee con reglas fijas (no con IA): un dato mal leído por el modelo se
// convertiría en mensajes a proveedores con la ruta equivocada.
const titulo = s => String(s || '').toLowerCase().replace(/(^|[\s.-])(\S)/g, (m, a, b) => a + b.toUpperCase()).replace(/\bDe\b/g, 'de').replace(/\bDel\b/g, 'del').replace(/\bLa\b(?!\w)/g, 'la');
const ciudad = s => titulo(String(s || '').split(',')[0].trim());

// MM/DD/YYYY HH:MM[:SS] (formato del TMS). Si el primer número es > 12 es DD/MM.
function fecha(txt) {
  const m = String(txt || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  let [, a, b, y, hh, mm] = m; a = Number(a); b = Number(b);
  const mes = a > 12 ? b : a, dia = a > 12 ? a : b;
  const p2 = n => String(n).padStart(2, '0');
  return { iso: `${y}-${p2(mes)}-${p2(dia)}`, texto: `${p2(dia)}/${p2(mes)}/${y}`, hora: hh != null ? `${p2(hh)}:${mm}` : null };
}
const campo = (t, re) => { const m = t.match(re); return m ? m[1].trim() : ''; };

function parsear(texto) {
  const t = String(texto || '');
  const folio = campo(t, /FOLIO\s*:\s*([A-Za-z0-9-]+)/i).toUpperCase();
  const de = t.match(/\bDE\s*:\s*(.+?)\s+A\s*:\s*(.+)/i);
  if (!folio || !de) return null; // sin folio y ruta no es un requerimiento
  const carga = fecha(campo(t, /Cita\s+de\s+carga\s*:\s*(.+)/i));
  const descarga = fecha(campo(t, /Cita\s+de\s+descarga\s*:\s*(.+)/i));
  return {
    folio,
    cliente: titulo(campo(t, /Cliente\s*:\s*(.+)/i)),
    origen: ciudad(de[1]), destino: ciudad(de[2].split(/\r?\n/)[0]),
    origenCompleto: de[1].trim(), destinoCompleto: de[2].split(/\r?\n/)[0].trim(),
    tipo_unidad: campo(t, /Tipo\s+de\s+(?:Tractor|Unidad)\s*:\s*(.+)/i) || 'Caja 53',
    carga, descarga,
  };
}
const cuando = f => (f ? `${f.texto}${f.hora ? ' ' + f.hora : ''}` : 'por confirmar');

module.exports = { parsear, cuando };
