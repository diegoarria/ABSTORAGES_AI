// ─── LEADS — Captura y estadísticas de leads de SARA ─────────────────────────

const leads = [];

function add(lead) {
  const entry = {
    id:           `LEAD-${Date.now().toString(36).toUpperCase()}`,
    created_at:   new Date().toISOString(),
    webhook_status: 'sent',
    nombre:       lead.nombre       || '—',
    empresa:      lead.empresa      || '—',
    telefono:     lead.telefono     || '—',
    origen:       lead.origen       || '—',
    destino:      lead.destino      || '—',
    tipo_carga:   lead.tipo_carga   || '—',
    peso_toneladas: lead.peso_toneladas || '—',
    sessionId:    lead.sessionId    || '',
    ...lead,
  };
  leads.push(entry);
  return entry;
}

function list(limit = 50) {
  return leads.slice(-limit).reverse();
}

function stats() {
  const now     = Date.now();
  const DAY_MS  = 86400000;
  const WEEK_MS = DAY_MS * 7;

  const today    = leads.filter(l => now - new Date(l.created_at).getTime() < DAY_MS).length;
  const week     = leads.filter(l => now - new Date(l.created_at).getTime() < WEEK_MS).length;
  const total    = leads.length;
  const sent     = leads.filter(l => l.webhook_status === 'sent').length;

  return {
    leads: { today, last_7_days: week, total, webhook_sent: sent },
    generated_at: new Date().toISOString(),
  };
}

// Extrae lead de texto de SARA usando regex simple
function extractFromText(text, sessionId) {
  const nombre   = text.match(/(?:nombre|cliente)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+ [A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/)?.[1];
  const telefono = text.match(/(?:\+52|52)?[:\s]?((?:55|33|81|664|477)\d{7,8})/)?.[1];
  const origen   = text.match(/(?:origen|de)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i)?.[1];
  const destino  = text.match(/(?:destino|hacia|a)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i)?.[1];
  const empresa  = text.match(/(?:empresa|compañía|negocio)[:\s]+([A-ZÁÉÍÓÚÑa-záéíóúñ ]+?)(?:\n|,|\.)/i)?.[1];
  const folio    = text.match(/ABST-\d+/)?.[0];

  if ((nombre || telefono) && (origen || destino || folio)) {
    return add({ nombre, telefono, origen, destino, empresa, sessionId });
  }
  return null;
}

module.exports = { add, list, stats, extractFromText };
