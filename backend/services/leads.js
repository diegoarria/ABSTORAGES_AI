// ─── LEADS — Captura y estadísticas de leads de SARA ─────────────────────────

const leads = [];

function add(lead) {
  const entry = {
    id:              `LEAD-${Date.now().toString(36).toUpperCase()}`,
    created_at:      new Date().toISOString(),
    webhook_status:  'sent',
    nombre:          lead.nombre          || '—',
    empresa:         lead.empresa         || '—',
    telefono:        lead.telefono        || '—',
    email:           lead.email           || '—',
    origen:          lead.origen          || '—',
    destino:         lead.destino         || '—',
    tipo_carga:      lead.tipo_carga      || '—',
    tipo_unidad:     lead.tipo_unidad     || '—',
    peso_toneladas:  lead.peso_toneladas  || '—',
    precio_cotizado: lead.precio_cotizado || '—',
    resumen:         lead.resumen         || '',
    sessionId:       lead.sessionId       || '',
    ...lead,
  };
  leads.push(entry);
  return entry;
}

function getById(id) {
  return leads.find(l => l.id === id) || null;
}

function list(limit = 50) {
  return leads.slice(-limit).reverse();
}

function stats() {
  const now     = Date.now();
  const DAY_MS  = 86400000;
  const WEEK_MS = DAY_MS * 7;

  const today = leads.filter(l => now - new Date(l.created_at).getTime() < DAY_MS).length;
  const week  = leads.filter(l => now - new Date(l.created_at).getTime() < WEEK_MS).length;
  const total = leads.length;
  const sent  = leads.filter(l => l.webhook_status === 'sent').length;

  return {
    leads: { today, last_7_days: week, total, webhook_sent: sent },
    generated_at: new Date().toISOString(),
  };
}

// Extrae lead del texto de SARA al cerrar una venta (NUEVA_ORDEN signal)
function extractFromText(text, sessionId) {
  const nombre   = text.match(/(?:nombre|cliente)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?: [A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+)/i)?.[1];
  const telefono = text.match(/(?:\+?52\s*)?(\d{2,3}[\s\-]?\d{3,4}[\s\-]?\d{4})/)?.[1];
  const email    = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
  const origen   = text.match(/(?:origen|de)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i)?.[1];
  const destino  = text.match(/(?:destino|hacia|a)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i)?.[1];
  const empresa  = text.match(/(?:empresa|compañía|negocio)[:\s]+([A-ZÁÉÍÓÚÑa-záéíóúñ ]+?)(?:\n|,|\.)/i)?.[1];
  const folio    = text.match(/ABST-\d+/)?.[0];
  const precio   = text.match(/\$\s*([\d,]+)/)?.[0];
  const unidad   = text.match(/caja seca \d{2}|torton|rabon|plataforma|full/i)?.[0];
  const resumen  = buildResumen({ nombre, empresa, origen, destino, unidad, precio, text });

  if ((nombre || telefono) && (origen || destino || folio)) {
    return add({ nombre, telefono, email, origen, destino, empresa, folio,
                 tipo_unidad: unidad, precio_cotizado: precio, resumen, sessionId });
  }
  return null;
}

function buildResumen({ nombre, empresa, origen, destino, unidad, precio, text }) {
  const partes = [];
  if (empresa && empresa !== '—') partes.push(empresa);
  else if (nombre && nombre !== '—') partes.push(nombre);
  if (origen && destino) partes.push(`${origen} → ${destino}`);
  if (unidad) partes.push(unidad);
  if (precio) partes.push(precio);

  if (partes.length > 0) return partes.join(' · ');

  // Fallback: primera oración relevante del texto
  const lineas = text.split('\n').map(l => l.trim()).filter(l => l.length > 20 && !l.startsWith('NUEVA_ORDEN'));
  return lineas[0]?.slice(0, 120) || '';
}

module.exports = { add, getById, list, stats, extractFromText };
