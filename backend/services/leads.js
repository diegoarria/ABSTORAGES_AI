// ─── LEADS — Captura, estadísticas y persistencia en disco ───────────────────
const fs   = require('fs');
const path = require('path');

const LEADS_FILE = path.join(__dirname, '../../data/leads.json');

function loadFromDisk() {
  try {
    if (fs.existsSync(LEADS_FILE)) return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  } catch {}
  return [];
}

const leads = loadFromDisk();

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2)); }
    catch (e) { console.error('[leads] Error guardando en disco:', e.message); }
  }, 1000);
}

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
  scheduleSave();
  return entry;
}

function getById(id) {
  return leads.find(l => l.id === id) || null;
}

function list(limit = 100) {
  return leads.slice(-limit).reverse();
}

function stats() {
  const now     = Date.now();
  const DAY_MS  = 86400000;
  const WEEK_MS = DAY_MS * 7;
  return {
    leads: {
      today:        leads.filter(l => now - new Date(l.created_at).getTime() < DAY_MS).length,
      last_7_days:  leads.filter(l => now - new Date(l.created_at).getTime() < WEEK_MS).length,
      total:        leads.length,
      webhook_sent: leads.filter(l => l.webhook_status === 'sent').length,
    },
    generated_at: new Date().toISOString(),
  };
}

function extractFromText(text, sessionId) {
  const nombre   = text.match(/(?:nombre|cliente)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?: [A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+)/i)?.[1];
  const telefono = text.match(/(?:\+?52\s*)?(\d{2,3}[\s\-]?\d{3,4}[\s\-]?\d{4})/)?.[1];
  const email    = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
  const origen   = text.match(/(?:origen|de)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i)?.[1];
  const destino  = text.match(/(?:destino|hacia|a)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i)?.[1];
  const empresa  = text.match(/(?:empresa|compañía|negocio)[:\s]+([A-ZÁÉÍÓÚÑa-záéíóúñ ]+?)(?:\n|,|\.)/i)?.[1];
  const folio    = text.match(/ABST-\d+/)?.[0];
  const precio   = text.match(/\$\s*([\d,]+)/)?.[0];
  const unidad   = text.match(/caja seca \d{2}|torton|rabe?on|plataforma|full/i)?.[0];

  const partes = [];
  if (empresa && empresa !== '—') partes.push(empresa);
  else if (nombre) partes.push(nombre);
  if (origen && destino) partes.push(`${origen} → ${destino}`);
  if (unidad)  partes.push(unidad);
  if (precio)  partes.push(precio);
  const resumen = partes.join(' · ');

  if ((nombre || telefono) && (origen || destino || folio)) {
    return add({ nombre, telefono, email, origen, destino, empresa, folio,
                 tipo_unidad: unidad, precio_cotizado: precio, resumen, sessionId });
  }
  return null;
}

module.exports = { add, getById, list, stats, extractFromText };
