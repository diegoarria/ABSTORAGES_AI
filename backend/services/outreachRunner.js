// ── OutreachRunner — Ejecuta la secuencia automáticamente cada N minutos ──────
require('dotenv').config();
const outreach   = require('./outreach');
const notifier   = require('./notifier');

const WA_KEY  = process.env.WHATSAPP_API_KEY;
const WA_BASE = (process.env.WHATSAPP_BASE_URL || 'https://waba-v2.360dialog.io').replace(/\/+$/, '');
const WA_URL  = WA_BASE.endsWith('/v1') ? WA_BASE : `${WA_BASE}/v1`;

// ── Plantillas de mensajes por canal ─────────────────────────────────────────
function templateEmail(p) {
  return {
    asunto: `${p.nombre} — ¿Optimizamos tu logística en ${p.pais || 'México'}?`,
    html: `
<div style="font-family:-apple-system,sans-serif;max-width:560px;color:#111;">
  <p>Hola <strong>${p.nombre.split(' ')[0]}</strong>,</p>
  <p>Soy SARA, asistente comercial de <strong>ABSTORAGES</strong>. Vi tu perfil en LinkedIn y creo que podemos ayudarle a ${p.empresa} a reducir costos logísticos en sus rutas de carga.</p>
  <p>En ABSTORAGES manejamos carga seca, refrigerada y proyecto en toda la república. Nuestros clientes ahorran entre 15-25% frente a cotizaciones de mercado gracias a nuestra red de carriers verificados.</p>
  <p>¿Tienes 20 minutos esta semana para una llamada rápida?</p>
  <p style="margin-top:24px;">Saludos,<br><strong>SARA</strong> · ABSTORAGES<br><a href="https://abstorages.com">abstorages.com</a></p>
</div>`,
  };
}

function templateWhatsApp(p) {
  return `Hola ${p.nombre.split(' ')[0]} 👋

Soy SARA de *ABSTORAGES*. Te contacto porque creemos que podemos apoyar la logística de ${p.empresa} con nuestras rutas de carga en México.

¿Tienes unos minutos para una llamada rápida esta semana? 🚛`;
}

function templateLinkedIn(p) {
  return `Hola ${p.nombre.split(' ')[0]}, soy Sara de ABSTORAGES. Nos especializamos en logística de carga en México y creo que podemos ser un buen socio para ${p.empresa}. ¿Podríamos conectar?`;
}

// ── Ejecutores por canal ──────────────────────────────────────────────────────
async function enviarEmail(p) {
  const { asunto, html } = templateEmail(p);
  if (!p.email) throw new Error('Sin email');
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS },
  });
  await transport.sendMail({
    from: `SARA ABSTORAGES <${process.env.GMAIL_USER}>`,
    to: p.email,
    subject: asunto,
    html,
  });
}

// DESHABILITADO A PROPÓSITO — este paso mandaba texto libre (sin plantilla
// aprobada por Meta) a un prospecto en frío que nunca le escribió primero a
// ABSTORAGES. Es exactamente el patrón que restringe/bloquea un número de
// WhatsApp Business (encontrado en auditoría del 01-sep-2026, nunca llegó a
// dispararse en producción porque MENSAJES_MASIVOS sigue apagado — pero de
// activarse tal como estaba, este paso sí habría arriesgado el número).
// Para reactivar este canal hace falta una plantilla de prospección en frío
// diseñada y aprobada por Meta primero (como se hizo con las de seguimiento/
// cotización/venta), no basta con volver a habilitar esta función tal cual.
// No lanza error a propósito: si lanzara, la secuencia se quedaría
// atorada para siempre en este paso y el prospecto nunca llegaría al paso
// de llamada — mejor omitir y dejar que la secuencia avance.
async function enviarWhatsApp(p) {
  console.warn(`[Outreach] 🔇 Paso de WhatsApp OMITIDO (no enviado) para ${p.nombre} — canal deshabilitado hasta tener una plantilla de prospección en frío aprobada por Meta.`);
}

async function enviarLinkedIn(p) {
  // LinkedIn DM requiere OAuth token con permiso w_messages
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token || token.startsWith('xxxx') || !p.linkedin) throw new Error('LinkedIn no configurado');
  // LinkedIn no permite DMs sin Sales Navigator API — loguear como pendiente manual
  console.log(`[LinkedIn STUB] DM a ${p.nombre}: ${templateLinkedIn(p)}`);
}

async function lanzarLlamadaVapi(p) {
  const vapi = require('./vapi');
  if (!p.telefono) throw new Error('Sin teléfono para llamada Vapi');
  await vapi.llamarProspecto({
    nombre:   p.nombre,
    empresa:  p.empresa,
    telefono: p.telefono,
    cargo:    p.cargo,
  });
}

// ── Runner principal ──────────────────────────────────────────────────────────
async function run(pushActividad) {
  const lista = outreach.pendientes();
  if (lista.length === 0) return { procesados: 0 };

  let procesados = 0;
  const push = pushActividad || (() => {});

  for (const p of lista) {
    const paso = outreach.SECUENCIA[p.pasoActual];
    if (!paso) continue;

    console.log(`[Outreach] ${p.nombre} (${p.empresa}) → ${paso.canal}`);
    try {
      switch (paso.canal) {
        case 'email':    await enviarEmail(p);        break;
        case 'whatsapp': await enviarWhatsApp(p);     break;
        case 'linkedin': await enviarLinkedIn(p);     break;
        case 'vapi':     await lanzarLlamadaVapi(p);  break;
      }
      outreach.registrarAccion(p.id, paso.canal, 'enviado');
      push({ agente: 'SARA', tipo: 'OUTREACH', mensaje: `${paso.canal.toUpperCase()} → ${p.nombre} (${p.empresa})`, metadata: { id: p.id, canal: paso.canal } });
      procesados++;
    } catch (e) {
      console.error(`[Outreach] Error ${paso.canal} → ${p.nombre}:`, e.message);
      outreach.registrarAccion(p.id, paso.canal, 'error');
    }

    // Pausa entre envíos para no parecer spam
    await new Promise(r => setTimeout(r, 2000));
  }

  return { procesados };
}

module.exports = { run, templateEmail, templateWhatsApp };
