// Crea en Twilio la plantilla "sofia_seguimiento_revision" (tono amable, para
// cuando el proveedor dijo "déjame lo reviso") y la manda a aprobación de Meta.
//   TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... node scripts/twilio-crear-plantilla-seguimiento-revision.js
// Imprime el ContentSid → va en Railway como TWILIO_CONTENT_SID_SEGUIMIENTO_REVISION.
const SID = process.env.TWILIO_ACCOUNT_SID, TOKEN = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOKEN) { console.error('Faltan TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN en el entorno.'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
const NOMBRE = 'sofia_seguimiento_revision';
const CUERPO = 'Hola {{1}}, ¿cómo vas? Nomás para ver si ya pudiste checar si tienes unidad para {{2}}. Cualquier cosa me avisas por aquí, no hay bronca. — SOFIA, ABSTORAGES Logistics Solutions';
(async () => {
  const r = await fetch('https://content.twilio.com/v1/Content', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ friendly_name: NOMBRE, language: 'es', variables: { 1: 'Francisco', 2: 'Monterrey → Guadalajara' }, types: { 'twilio/text': { body: CUERPO } } }) });
  const c = await r.json();
  if (!r.ok) { console.error('Error creando la plantilla:', JSON.stringify(c)); process.exit(1); }
  console.log('Plantilla creada:', c.sid);
  const a = await fetch(`https://content.twilio.com/v1/Content/${c.sid}/ApprovalRequests/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify({ name: NOMBRE, category: 'UTILITY' }) });
  const ap = await a.json();
  if (!a.ok) { console.error('Creada, pero falló el envío a aprobación:', JSON.stringify(ap)); process.exit(1); }
  console.log('Enviada a aprobación de Meta. Estado:', ap.status || JSON.stringify(ap));
  console.log('\nCuando Meta la apruebe, en Railway:  TWILIO_CONTENT_SID_SEGUIMIENTO_REVISION=' + c.sid);
})();
