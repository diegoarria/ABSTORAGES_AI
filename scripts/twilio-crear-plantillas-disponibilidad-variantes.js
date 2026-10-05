// Crea en Twilio las 4 variaciones de texto de la difusión general de
// disponibilidad (mismo propósito, distinta redacción cada una) y las manda a
// aprobación de Meta. Pedido explícito del usuario (05-oct-2026): si siempre
// es el mismo mensaje se nota que es un bot — con 4 variantes, el sistema las
// rota una por proveedor (ver difusionGeneral.js).
//   TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... node scripts/twilio-crear-plantillas-disponibilidad-variantes.js
// Imprime los 4 ContentSid → van en Railway como
// TWILIO_CONTENT_SID_DISPONIBILIDAD_GENERAL_1 .. _4
const SID = process.env.TWILIO_ACCOUNT_SID, TOKEN = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOKEN) { console.error('Faltan TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN en el entorno.'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');

const VARIANTES = [
  { n: 1, nombre: 'sofia_disponibilidad_general_1', cuerpo: 'Hola {{1}}, buenos días. Soy SOFIA de ABSTORAGES. ¿Qué unidad tienes disponible hoy? Cuéntame la ruta y el tipo, para tenerte en cuenta en cuanto tengamos carga que te acomode.' },
  { n: 2, nombre: 'sofia_disponibilidad_general_2', cuerpo: 'Buenos días {{1}}, soy SOFIA de ABSTORAGES. ¿Tendrás unidad disponible hoy? Si tienes algo libre, cuéntame en qué ruta y qué tipo de caja, para avisarte en cuanto tengamos algo para ti.' },
  { n: 3, nombre: 'sofia_disponibilidad_general_3', cuerpo: '{{1}}, buen día — habla SOFIA de ABSTORAGES. ¿Hoy cuentas con unidad disponible? Si es así, dime la ruta y el tipo de caja para tenerte en mente.' },
  { n: 4, nombre: 'sofia_disponibilidad_general_4', cuerpo: 'Hola {{1}}, ¿qué tal? Soy SOFIA de ABSTORAGES Logistics. Te escribo para ver si tienes unidad libre hoy — compárteme ruta y tipo de caja para tomarte en cuenta en lo que tengamos disponible.' },
];

async function crearYAprobar(v) {
  const r = await fetch('https://content.twilio.com/v1/Content', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ friendly_name: v.nombre, language: 'es', variables: { 1: 'Francisco' }, types: { 'twilio/text': { body: v.cuerpo } } }) });
  const c = await r.json();
  if (!r.ok) { console.error(`[${v.nombre}] Error creando:`, JSON.stringify(c)); return null; }
  const a = await fetch(`https://content.twilio.com/v1/Content/${c.sid}/ApprovalRequests/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ name: v.nombre, category: 'UTILITY' }) });
  const ap = await a.json();
  if (!a.ok) { console.error(`[${v.nombre}] Creada (${c.sid}) pero falló el envío a aprobación:`, JSON.stringify(ap)); return { sid: c.sid, aprobacion: 'fallo' }; }
  console.log(`[${v.nombre}] Creada y enviada a aprobación — ContentSid: ${c.sid} — estado: ${ap.status || JSON.stringify(ap)}`);
  return { sid: c.sid, aprobacion: ap.status || 'enviada' };
}

(async () => {
  const resultados = [];
  for (const v of VARIANTES) {
    const r = await crearYAprobar(v);
    resultados.push({ ...v, resultado: r });
  }
  console.log('\n— Variables para Railway (cuando Meta las apruebe) —');
  for (const r of resultados) {
    if (r.resultado?.sid) console.log(`TWILIO_CONTENT_SID_DISPONIBILIDAD_GENERAL_${r.n}=${r.resultado.sid}`);
  }
})();
