// Crea en Twilio la plantilla de WhatsApp "sofia_reclamo_pago" y la manda a
// aprobación de Meta. Uso (con las credenciales en el entorno, nunca en el código):
//   TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... node scripts/twilio-crear-plantilla-reclamo-pago.js
// Imprime el ContentSid: ese valor va en Railway como TWILIO_CONTENT_SID_RECLAMO_PAGO.
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOKEN) { console.error('Faltan TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN en el entorno.'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');

const NOMBRE = 'sofia_reclamo_pago';
const CUERPO = 'Reclamo de pago de proveedor. Proveedor: {{1}}. Detalle: {{2}}. Por favor revísalo con Administración y dale seguimiento. — SOFIA, ABSTORAGES Logistics Solutions';

(async () => {
  const r = await fetch('https://content.twilio.com/v1/Content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({
      friendly_name: NOMBRE,
      language: 'es',
      variables: { 1: 'Francisco Favio', 2: 'dice que no le han pagado el folio OP-ABS-26-4821' },
      types: { 'twilio/text': { body: CUERPO } },
    }),
  });
  const c = await r.json();
  if (!r.ok) { console.error('Error creando la plantilla:', JSON.stringify(c)); process.exit(1); }
  console.log('Plantilla creada:', c.sid);

  const a = await fetch(`https://content.twilio.com/v1/Content/${c.sid}/ApprovalRequests/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: auth },
    body: JSON.stringify({ name: NOMBRE, category: 'UTILITY' }),
  });
  const ap = await a.json();
  if (!a.ok) { console.error('Creada, pero falló el envío a aprobación:', JSON.stringify(ap)); process.exit(1); }
  console.log('Enviada a aprobación de Meta. Estado:', ap.status || JSON.stringify(ap));
  console.log('\nSiguiente paso: cuando Meta la apruebe, poner en Railway  TWILIO_CONTENT_SID_RECLAMO_PAGO=' + c.sid);
})();
