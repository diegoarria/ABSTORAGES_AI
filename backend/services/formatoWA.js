// ── Limpieza determinística de formato para WhatsApp ─────────────────────────
// Las instrucciones del system prompt (ver FORMATO_WHATSAPP en server-lite.js)
// le piden a la IA que no use markdown, pero un LLM no las sigue al 100% de
// las veces — se comprobó en vivo que aun con la instrucción puesta, un
// mensaje real siguió trayendo **negritas dobles**. Esta es la red de
// seguridad determinística: se aplica SIEMPRE, en el último paso antes de
// mandar el mensaje real por WhatsApp (Twilio y 2Chat), sin importar qué haya
// escrito la IA.
function limpiarFormatoWhatsApp(texto) {
  if (!texto) return texto;
  let t = texto;

  // Bloques de código ``` — se quita la cerca, se deja el contenido
  t = t.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  // Código inline `x` → x
  t = t.replace(/`([^`]+)`/g, '$1');
  // Negritas dobles **texto** → *texto* (así sí se ve en negritas en WhatsApp)
  t = t.replace(/\*\*(.+?)\*\*/g, '*$1*');
  // Encabezados markdown al inicio de línea (#, ##, ###...)
  t = t.replace(/^#{1,6}[ \t]*/gm, '');
  // Llaves sueltas de JSON/objetos que se hayan colado a la prosa
  t = t.replace(/[{}]/g, '');

  // Todo lo relacionado a tablas/separadores se procesa línea por línea —
  // usar \s en una regex global se come los saltos de línea entre filas y
  // termina fusionando toda la tabla en un solo renglón (bug real, detectado
  // en prueba: una tabla de varias filas quedó pegada en una sola línea).
  t = t.split('\n').map(linea => {
    // Línea separadora sola (---, ___, ***, ===) → se descarta
    if (/^[ \t]*[-_=*]{3,}[ \t]*$/.test(linea)) return '';
    // Fila separadora de tabla markdown (|---|---| o :---:|:---:) → se descarta
    if (/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*\|?[ \t]*$/.test(linea) && linea.includes('|')) return '';
    // Pipes restantes de una fila con contenido real → separador legible,
    // solo consumiendo espacios/tabs alrededor, nunca saltos de línea.
    return linea.replace(/[ \t]*\|[ \t]*/g, ' · ').replace(/^\s*·\s*|\s*·\s*$/g, '').trim();
  }).join('\n');

  // Colapsar saltos de línea excesivos que pudieran quedar tras la limpieza
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

module.exports = { limpiarFormatoWhatsApp };
