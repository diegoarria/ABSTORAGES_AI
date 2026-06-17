// Notificaciones al equipo cuando SARA captura un lead
// Email (Resend) + WhatsApp al equipo + webhook externo (n8n / Zapier / CRM)
require('dotenv').config();

const RESEND_KEY   = process.env.RESEND_API_KEY;
const TEAM_EMAIL   = process.env.NOTIF_EMAIL;
const FROM_EMAIL   = process.env.NOTIF_FROM_EMAIL || 'SARA <sara@abstorages.mx>';
const TEAM_WA      = process.env.NOTIF_WA_NUMBER;    // ej: 528181234567
const WEBHOOK_URL  = process.env.LEAD_WEBHOOK_URL;   // n8n / Zapier / HubSpot

const WA_KEY  = process.env.WHATSAPP_API_KEY;
const WA_URL  = process.env.WHATSAPP_BASE_URL || 'https://waba.360dialog.io/v1';
const WA_LIVE = WA_KEY && !WA_KEY.startsWith('xxxx');

// ── Email via Resend ───────────────────────────────────────────────────────────
async function sendEmail(lead) {
  if (!RESEND_KEY || RESEND_KEY.startsWith('re_xxxx') || !TEAM_EMAIL) {
    console.log(`[Email STUB] Nuevo lead: ${lead.nombre} — ${lead.empresa}`);
    return;
  }

  const row = (label, val) =>
    val && val !== '—'
      ? `<tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">${label}</td><td style="padding:4px 0;font-size:13px;">${val}</td></tr>`
      : '';

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
      <div style="background:#0f1d4a;padding:20px 24px;display:flex;align-items:center;gap:12px;">
        <div style="background:#1d4ed8;border-radius:50%;width:36px;height:36px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:15px;">S</div>
        <div>
          <div style="color:#fff;font-weight:600;font-size:15px;">SARA · ABSTORAGES</div>
          <div style="color:#93c5fd;font-size:12px;">Nuevo lead capturado</div>
        </div>
      </div>
      <div style="padding:24px;">
        <table style="width:100%;border-collapse:collapse;">
          ${row('Nombre',         lead.nombre)}
          ${row('Empresa',        lead.empresa)}
          ${row('Teléfono',       lead.telefono)}
          ${row('Email',          lead.email)}
          ${row('Ruta',           lead.origen !== '—' && lead.destino !== '—' ? `${lead.origen} → ${lead.destino}` : null)}
          ${row('Unidad',         lead.tipo_unidad)}
          ${row('Precio cotizado',lead.precio_cotizado)}
          ${row('Resumen',        lead.resumen)}
        </table>
        <div style="margin-top:20px;font-size:11px;color:#aaa;">Capturado el ${new Date().toLocaleString('es-MX')} · ID ${lead.id}</div>
      </div>
    </div>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: FROM_EMAIL, to: TEAM_EMAIL, subject: `Lead SARA: ${lead.nombre} — ${lead.empresa}`, html }),
    });
    if (!r.ok) console.error('[Email] Resend error:', await r.text());
    else console.log(`[Email] Enviado a ${TEAM_EMAIL} — lead ${lead.id}`);
  } catch (e) {
    console.error('[Email] Error:', e.message);
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

// ── Orquestador principal ──────────────────────────────────────────────────────
async function notificarLead(lead) {
  await Promise.allSettled([
    sendEmail(lead),
    sendWATeam(lead),
    fireWebhook(lead),
  ]);
}

module.exports = { notificarLead };
