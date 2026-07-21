// Notificaciones al equipo cuando SARA captura un lead
// Canal principal: Gmail SMTP (nodemailer) — nunca va a spam, sin dominio propio
// Fallback: Resend (requiere dominio verificado para salir de spam)
require('dotenv').config();
const nodemailer = require('nodemailer');

const GMAIL_USER   = process.env.GMAIL_USER;   // tu Gmail: ej. diego@gmail.com
const GMAIL_PASS   = process.env.GMAIL_PASS;   // App Password de 16 chars (sin espacios)
const GMAIL_LIVE   = GMAIL_USER && GMAIL_PASS && !GMAIL_PASS.startsWith('xxxx');

const RESEND_KEY   = process.env.RESEND_API_KEY;
const TEAM_EMAIL   = (process.env.NOTIF_EMAIL || '').split(',').map(e => e.trim()).filter(Boolean);
const FROM_EMAIL   = process.env.NOTIF_FROM_EMAIL || 'SARA <onboarding@resend.dev>';
const TEAM_WA      = process.env.NOTIF_WA_NUMBER;
const WEBHOOK_URL  = process.env.LEAD_WEBHOOK_URL;

const WA_KEY  = process.env.WHATSAPP_API_KEY;
const WA_BASE = (process.env.WHATSAPP_BASE_URL || 'https://waba-v2.360dialog.io').replace(/\/+$/, '');
const WA_URL  = WA_BASE.endsWith('/v1') ? WA_BASE : `${WA_BASE}/v1`;
const WA_LIVE = WA_KEY && !WA_KEY.startsWith('xxxx');

// Transporte Gmail reutilizable
const gmailTransport = GMAIL_LIVE ? nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
}) : null;

async function sendEmailGmail(asunto, html) {
  if (!gmailTransport || !TEAM_EMAIL.length) return false;
  try {
    await gmailTransport.sendMail({
      from: `SARA ABSTORAGES <${GMAIL_USER}>`,
      to: TEAM_EMAIL.join(', '),
      subject: asunto,
      html,
    });
    console.log(`[Gmail] ✅ Enviado a ${TEAM_EMAIL.join(', ')} — "${asunto}"`);
    return true;
  } catch (e) {
    console.error('[Gmail] ❌ Error:', e.message);
    return false;
  }
}

// ── Email via Resend ───────────────────────────────────────────────────────────
async function sendEmail(lead) {
  if (!RESEND_KEY || RESEND_KEY.startsWith('re_xxxx') || !TEAM_EMAIL.length) {
    console.log(`[Email STUB] Nuevo lead: ${lead.nombre} — ${lead.empresa}`);
    return;
  }

  const row = (label, val) =>
    val && val !== '—' && val !== ''
      ? `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;">${label}</td><td style="padding:6px 0;font-size:13px;font-weight:500;color:#111;">${val}</td></tr>`
      : '';

  const ruta = (lead.origen && lead.origen !== '—' && lead.destino && lead.destino !== '—')
    ? `${lead.origen} → ${lead.destino}` : null;

  const fecha = new Date(lead.created_at || Date.now()).toLocaleString('es-MX', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Monterrey'
  });

  const primerMsj = lead.primer_mensaje || lead.resumen || '';

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
      <div style="background:#0f1d4a;padding:20px 24px;">
        <div style="color:#fff;font-weight:700;font-size:16px;">SARA · ABSTORAGES</div>
        <div style="color:#93c5fd;font-size:12px;margin-top:2px;">Nuevo lead capturado · ${fecha}</div>
      </div>

      ${primerMsj ? `
      <div style="padding:16px 24px 0;">
        <div style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px;">Lo que dijo el cliente</div>
        <div style="background:#f0f9ff;border-left:3px solid #0ea5e9;padding:12px 16px;border-radius:6px;font-size:14px;color:#0c4a6e;line-height:1.6;font-style:italic;">"${primerMsj}"</div>
      </div>` : ''}

      <div style="padding:20px 24px;">
        <div style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:.05em;text-transform:uppercase;margin-bottom:12px;">Datos capturados</div>
        <table style="width:100%;border-collapse:collapse;">
          ${row('Nombre',          lead.nombre)}
          ${row('Empresa',         lead.empresa)}
          ${row('Teléfono',        lead.telefono)}
          ${row('Email',           lead.email)}
          ${row('RFC',             lead.rfc)}
          ${row('Ruta',            ruta)}
          ${row('Tipo de carga',   lead.tipo_carga)}
          ${row('Unidad',          lead.tipo_unidad)}
          ${row('Peso (ton)',       lead.peso_toneladas)}
          ${row('Precio cotizado', lead.precio_cotizado ? `<span style="color:#16a34a;font-weight:700;">${lead.precio_cotizado}</span>` : null)}
          ${row('Folio ABST',      lead.folio)}
          ${row('Folio sistema',   lead.id)}
          ${row('Sesión',          lead.sessionId)}
        </table>
      </div>
    </div>`;

  const asunto = `🔔 Lead SARA: ${[lead.nombre, lead.empresa, ruta].filter(v => v && v !== '—').join(' · ') || lead.id}`;

  // Gmail primero (nunca va a spam), Resend como fallback
  const enviado = await sendEmailGmail(asunto, html);
  if (!enviado) {
    if (!RESEND_KEY || RESEND_KEY.startsWith('re_xxxx') || !TEAM_EMAIL.length) {
      console.log(`[Email STUB] ${asunto}`); return;
    }
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({ from: FROM_EMAIL, to: TEAM_EMAIL, subject: asunto, html }),
      });
      if (!r.ok) console.error('[Resend] Error:', await r.text());
      else console.log(`[Resend] Enviado — ${asunto}`);
    } catch (e) { console.error('[Resend] Error:', e.message); }
  }
}

// ── WhatsApp al número del equipo ──────────────────────────────────────────────
async function sendWATeam(lead) {
  if (!WA_LIVE || !TEAM_WA) {
    console.log(`[WA-Team STUB] Lead: ${lead.nombre} (${lead.empresa})`);
    return;
  }

  const partes = [`🔔 *Nuevo lead SARA*`, `👤 *${lead.nombre}* — ${lead.empresa}`];
  if (lead.telefono !== '—') partes.push(`📱 ${lead.telefono}`);
  if (lead.email    !== '—') partes.push(`✉️ ${lead.email}`);
  if (lead.origen   !== '—' && lead.destino !== '—') partes.push(`🗺️ ${lead.origen} → ${lead.destino}`);
  if (lead.precio_cotizado !== '—') partes.push(`💰 ${lead.precio_cotizado}`);
  if (lead.resumen) partes.push(`📝 ${lead.resumen}`);

  try {
    const r = await fetch(`${WA_URL}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'D360-API-KEY': WA_KEY },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: TEAM_WA, type: 'text', text: { body: partes.join('\n') } }),
    });
    if (!r.ok) console.error('[WA-Team] Error:', await r.text());
    else console.log(`[WA-Team] Notificación enviada a ${TEAM_WA}`);
  } catch (e) {
    console.error('[WA-Team] Error:', e.message);
  }
}

// ── Webhook externo (n8n / Zapier / CRM) ──────────────────────────────────────
async function fireWebhook(lead) {
  if (!WEBHOOK_URL || WEBHOOK_URL.startsWith('https://your-')) {
    console.log(`[Webhook STUB] Payload lead ${lead.id}`);
    return;
  }
  try {
    const r = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'lead_captured', lead, timestamp: new Date().toISOString() }),
    });
    if (!r.ok) console.error('[Webhook] Error:', r.status, await r.text());
    else console.log(`[Webhook] Disparado → ${WEBHOOK_URL}`);
  } catch (e) {
    console.error('[Webhook] Error:', e.message);
  }
}

// ── Email de resumen al cierre de conversación ────────────────────────────────
async function sendEmailResumen(lead, motivo, historial = []) {
  if (!RESEND_KEY || RESEND_KEY.startsWith('re_xxxx') || !TEAM_EMAIL.length) {
    console.log(`[Email STUB] Fin conversación: ${motivo} — ${lead.nombre}`);
    return;
  }

  const MOTIVOS = {
    cierre_de_venta:        { label: 'Venta cerrada ✅',           color: '#16a34a', bg: '#f0fdf4' },
    escalado_a_operaciones: { label: 'Escalado a operaciones 🔁',  color: '#d97706', bg: '#fffbeb' },
    chat_cerrado:           { label: 'Chat cerrado',               color: '#6b7280', bg: '#f9fafb' },
    cotizacion_en_proceso:  { label: 'Solicitud recibida 📋',      color: '#0ea5e9', bg: '#f0f9ff' },
  };

  const estado = MOTIVOS[motivo] || MOTIVOS.cotizacion_en_proceso;
  const row = (label, val) =>
    val && val !== '—' && val !== ''
      ? `<tr><td style="padding:5px 16px 5px 0;color:#6b7280;font-size:13px;white-space:nowrap;">${label}</td><td style="padding:5px 0;font-size:13px;font-weight:500;color:#111;">${val}</td></tr>`
      : '';

  const ruta = (lead.origen && lead.origen !== '—' && lead.destino && lead.destino !== '—')
    ? `${lead.origen} → ${lead.destino}` : null;

  const fecha = new Date(lead.created_at || Date.now()).toLocaleString('es-MX', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Monterrey',
  });

  const mensajesHtml = historial.slice(-6).map(m => {
    const isUser = m.role === 'user';
    const limpio = (m.content || '').replace(/NUEVA_ORDEN[\s\S]*?}/g,'').replace(/CERRAR_CHAT|ESCALAR_HUMANO/g,'').trim();
    if (!limpio) return '';
    return `<div style="margin-bottom:8px;display:flex;justify-content:${isUser?'flex-start':'flex-end'};">
      <div style="max-width:85%;background:${isUser?'#f3f4f6':'#eff6ff'};border-radius:8px;padding:8px 12px;font-size:12px;line-height:1.5;color:#111;">
        <span style="font-size:10px;color:#9ca3af;display:block;margin-bottom:2px;">${isUser?'Cliente':'SARA'}</span>
        ${limpio.replace(/</g,'&lt;').replace(/\n/g,'<br>')}
      </div>
    </div>`;
  }).filter(Boolean).join('');

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:580px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:#0f1d4a;padding:20px 24px;display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="color:#fff;font-weight:700;font-size:16px;">SARA · ABSTORAGES</div>
        <div style="color:#93c5fd;font-size:12px;margin-top:2px;">Conversación finalizada · ${fecha}</div>
      </div>
    </div>

    <div style="padding:16px 24px;background:${estado.bg};border-bottom:1px solid #e5e7eb;">
      <span style="font-size:13px;font-weight:700;color:${estado.color};">${estado.label}</span>
    </div>

    ${lead.primer_mensaje ? `
    <div style="padding:16px 24px 0;">
      <div style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:.05em;text-transform:uppercase;margin-bottom:6px;">Primer mensaje</div>
      <div style="background:#f0f9ff;border-left:3px solid #0ea5e9;padding:10px 14px;border-radius:6px;font-size:13px;color:#0c4a6e;font-style:italic;">"${lead.primer_mensaje}"</div>
    </div>` : ''}

    <div style="padding:16px 24px;">
      <div style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:.05em;text-transform:uppercase;margin-bottom:10px;">Datos del contacto</div>
      <table style="width:100%;border-collapse:collapse;">
        ${row('Nombre',    lead.nombre)}
        ${row('Empresa',   lead.empresa)}
        ${row('Teléfono',  lead.telefono)}
        ${row('Email',     lead.email)}
        ${row('RFC',       lead.rfc)}
        ${row('Ruta',      ruta)}
        ${row('Carga',     lead.tipo_carga)}
        ${row('Unidad',    lead.tipo_unidad)}
        ${row('Peso',      lead.peso_toneladas ? lead.peso_toneladas + ' ton' : null)}
        ${row('Folio',     lead.folio)}
      </table>
    </div>

    ${mensajesHtml ? `
    <div style="padding:0 24px 16px;">
      <div style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:.05em;text-transform:uppercase;margin-bottom:10px;">Últimos mensajes</div>
      <div style="background:#f9fafb;border-radius:8px;padding:12px;">${mensajesHtml}</div>
    </div>` : ''}

    <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;text-align:center;">
      <a href="https://abstoragesai-production.up.railway.app" style="background:#0f1d4a;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;">Ver en portal →</a>
    </div>
  </div>`;

  const asunto = `SARA: ${estado.label.replace(/[✅🔁📋]/g,'').trim()} — ${[lead.nombre, lead.empresa, ruta].filter(v=>v&&v!=='—').join(' · ') || 'Nuevo contacto'}`;

  const enviado = await sendEmailGmail(asunto, html);
  if (!enviado) {
    if (!RESEND_KEY || RESEND_KEY.startsWith('re_xxxx') || !TEAM_EMAIL.length) {
      console.log(`[Email STUB] ${asunto}`); return;
    }
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({ from: FROM_EMAIL, to: TEAM_EMAIL, subject: asunto, html }),
      });
      if (!r.ok) console.error('[Resend] Error:', await r.text());
      else console.log(`[Resend] Resumen enviado → ${motivo} — ${lead.nombre}`);
    } catch (e) { console.error('[Resend] Error:', e.message); }
  }
}

// ── Orquestador principal ──────────────────────────────────────────────────────
async function notificarLead(lead) {
  await Promise.allSettled([
    sendEmail(lead),
    sendWATeam(lead),
    fireWebhook(lead),
  ]);
}

async function notificarResumen(lead, motivo, historial = []) {
  await Promise.allSettled([
    sendEmailResumen(lead, motivo, historial),
    sendWATeam(lead),
    fireWebhook(lead),
  ]);
}

async function notificarAsignacion(folio, proveedor, precio) {
  const asunto = `🚛 Carrier asignado — Folio ${folio}`;
  const precioStr = precio || 'por confirmar';
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:#0f1d4a;padding:20px 24px;">
      <div style="color:#fff;font-weight:700;font-size:16px;">SOFÍA · ABSTORAGES</div>
      <div style="color:#93c5fd;font-size:12px;margin-top:2px;">Carrier asignado · ${new Date().toLocaleString('es-MX',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Monterrey'})}</div>
    </div>
    <div style="padding:20px 24px;">
      <p style="margin:0 0 16px;font-size:14px;color:#111;">El carrier <strong>${proveedor}</strong> aceptó el folio <strong>${folio}</strong> a <strong style="color:#16a34a;">${precioStr}</strong>.</p>
      <p style="margin:0;font-size:13px;color:#6b7280;">SOFÍA está coordinando confirmación de condiciones y protocolo de precarga.</p>
    </div>
  </div>`;
  const enviado = await sendEmailGmail(asunto, html);
  if (!enviado) console.log(`[Notifier STUB] Carrier asignado — ${folio} → ${proveedor} @ ${precioStr}`);
}

module.exports = { notificarLead, notificarResumen, notificarAsignacion };
