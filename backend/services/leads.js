// ─── LEADS — Captura, estadísticas y persistencia (PostgreSQL + disco) ────────
const fs   = require('fs');
const path = require('path');
const { pool } = require('./db');

const LEADS_FILE = path.join(__dirname, '../../data/leads.json');

function loadFromDisk() {
  try {
    if (fs.existsSync(LEADS_FILE)) return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
  } catch {}
  return [];
}

// Cache en memoria (siempre activo, sirve de fallback y acelera lecturas)
const cache = loadFromDisk();

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(LEADS_FILE, JSON.stringify(cache, null, 2)); }
    catch (e) { console.error('[leads] Error guardando en disco:', e.message); }
  }, 1000);
}

async function saveToDb(entry) {
  if (!pool) return;
  try {
    await pool.query(`
      INSERT INTO leads (
        id, created_at, nombre, empresa, rfc, telefono, email,
        origen, destino, tipo_carga, tipo_unidad, peso_toneladas,
        precio_cotizado, folio, intent, sara_nota, primer_mensaje,
        resumen, session_id, webhook_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (session_id) DO UPDATE SET
        nombre          = COALESCE(NULLIF(EXCLUDED.nombre,'—'),          leads.nombre),
        empresa         = COALESCE(NULLIF(EXCLUDED.empresa,'—'),         leads.empresa),
        rfc             = COALESCE(NULLIF(EXCLUDED.rfc,'—'),             leads.rfc),
        telefono        = COALESCE(NULLIF(EXCLUDED.telefono,'—'),        leads.telefono),
        email           = COALESCE(NULLIF(EXCLUDED.email,'—'),           leads.email),
        origen          = COALESCE(NULLIF(EXCLUDED.origen,'—'),          leads.origen),
        destino         = COALESCE(NULLIF(EXCLUDED.destino,'—'),         leads.destino),
        tipo_carga      = COALESCE(NULLIF(EXCLUDED.tipo_carga,'—'),      leads.tipo_carga),
        tipo_unidad     = COALESCE(NULLIF(EXCLUDED.tipo_unidad,'—'),     leads.tipo_unidad),
        peso_toneladas  = COALESCE(NULLIF(EXCLUDED.peso_toneladas,'—'),  leads.peso_toneladas),
        precio_cotizado = COALESCE(NULLIF(EXCLUDED.precio_cotizado,'—'), leads.precio_cotizado),
        folio           = COALESCE(NULLIF(EXCLUDED.folio,'—'),           leads.folio),
        intent          = COALESCE(EXCLUDED.intent,                      leads.intent),
        sara_nota       = COALESCE(EXCLUDED.sara_nota,                   leads.sara_nota),
        resumen         = COALESCE(NULLIF(EXCLUDED.resumen,''),          leads.resumen)
    `, [
      entry.id, entry.created_at,
      entry.nombre, entry.empresa, entry.rfc, entry.telefono, entry.email,
      entry.origen, entry.destino, entry.tipo_carga, entry.tipo_unidad, entry.peso_toneladas,
      entry.precio_cotizado, entry.folio, entry.intent, entry.sara_nota, entry.primer_mensaje,
      entry.resumen, entry.sessionId, entry.webhook_status,
    ]);
  } catch (e) {
    console.error('[leads] Error guardando en DB:', e.message);
  }
}

function add(lead) {
  const entry = {
    id:              `LEAD-${Date.now().toString(36).toUpperCase()}`,
    created_at:      new Date().toISOString(),
    webhook_status:  'sent',
    nombre:          lead.nombre          || '—',
    empresa:         lead.empresa         || '—',
    rfc:             lead.rfc             || '—',
    telefono:        lead.telefono        || '—',
    email:           lead.email           || '—',
    origen:          lead.origen          || '—',
    destino:         lead.destino         || '—',
    tipo_carga:      lead.tipo_carga      || '—',
    tipo_unidad:     lead.tipo_unidad     || '—',
    peso_toneladas:  lead.peso_toneladas  || '—',
    precio_cotizado: lead.precio_cotizado || '—',
    folio:           lead.folio           || '—',
    intent:          lead.intent          || 'otro',
    sara_nota:       lead.sara_nota       || null,
    primer_mensaje:  lead.primer_mensaje  || null,
    resumen:         lead.resumen         || '',
    sessionId:       lead.sessionId       || '',
    ...lead,
  };
  cache.push(entry);
  scheduleSave();
  saveToDb(entry);
  return entry;
}

async function getById(id) {
  if (pool) {
    try {
      const { rows } = await pool.query('SELECT * FROM leads WHERE id = $1', [id]);
      if (rows[0]) return rows[0];
    } catch (e) { console.error('[leads] getById DB error:', e.message); }
  }
  return cache.find(l => l.id === id) || null;
}

async function list(limit = 100) {
  if (pool) {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM leads ORDER BY created_at DESC LIMIT $1', [limit]
      );
      return rows;
    } catch (e) { console.error('[leads] list DB error:', e.message); }
  }
  return cache.slice(-limit).reverse();
}

async function stats() {
  if (pool) {
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')  AS today,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS last_7_days,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE webhook_status = 'sent')                AS webhook_sent
        FROM leads
      `);
      return { leads: rows[0], generated_at: new Date().toISOString() };
    } catch (e) { console.error('[leads] stats DB error:', e.message); }
  }
  const now = Date.now(), DAY = 86400000;
  return {
    leads: {
      today:        cache.filter(l => now - new Date(l.created_at).getTime() < DAY).length,
      last_7_days:  cache.filter(l => now - new Date(l.created_at).getTime() < DAY * 7).length,
      total:        cache.length,
      webhook_sent: cache.filter(l => l.webhook_status === 'sent').length,
    },
    generated_at: new Date().toISOString(),
  };
}

async function exportCsv() {
  const rows = await list(10000);
  const cols = ['id','created_at','nombre','empresa','rfc','telefono','email',
                 'origen','destino','tipo_carga','tipo_unidad','peso_toneladas',
                 'precio_cotizado','folio','intent','sara_nota','primer_mensaje','resumen'];
  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = cols.join(',');
  const body   = rows.map(r => cols.map(c => escape(r[c] ?? r[c.replace('_','Id')] ?? '')).join(',')).join('\n');
  return `${header}\n${body}`;
}

function detectIntent(text) {
  if (/\b(trabajo|empleo|vacante|chofer|conductor|operador|plaza)\b/i.test(text)) return 'trabajo';
  if (/\b(mudanza|muebles|mudarse|casa|departamento)\b/i.test(text))              return 'mudanzas';
  if (/\b(flete|carga|transporte|ruta|cotiz|envío|traslado|camión|unidad)\b/i.test(text)) return 'fletes_nacionales';
  return 'otro';
}

function extractFromText(text, sessionId, extras = {}) {
  const nombre   = text.match(/(?:nombre|cliente)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?: [A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+)/i)?.[1];
  const telefono = text.match(/(?:\+?52\s*)?(\d{2,3}[\s\-]?\d{3,4}[\s\-]?\d{4})/)?.[1];
  const email    = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
  const origen   = text.match(/(?:origen|de)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i)?.[1];
  const destino  = text.match(/(?:destino|hacia|a)[:\s]+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i)?.[1];
  const empresa  = text.match(/(?:empresa|compañía|negocio)[:\s]+([A-ZÁÉÍÓÚÑa-záéíóúñ ]+?)(?:\n|,|\.)/i)?.[1];
  const folio    = text.match(/ABST-\d+/)?.[0];
  const precio   = text.match(/\$\s*([\d,]+)/)?.[0];
  const unidad   = text.match(/caja seca \d{2}|torton|rabe?on|plataforma|full/i)?.[0];
  const rfc      = text.match(/\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/i)?.[1]?.toUpperCase();
  const tipo_carga     = text.match(/(?:tipo de carga|carga)[:\s]+([^\n,.]+)/i)?.[1]?.trim();
  const peso_toneladas = text.match(/(\d+(?:\.\d+)?)\s*(?:ton(?:eladas?)?|t\b)/i)?.[1];
  const intent = detectIntent(text);

  const partes = [];
  if (empresa && empresa !== '—') partes.push(empresa);
  else if (nombre) partes.push(nombre);
  if (origen && destino) partes.push(`${origen} → ${destino}`);
  if (unidad)  partes.push(unidad);
  if (precio)  partes.push(precio);
  const resumen = partes.join(' · ');

  // Registrar toda conversación — aunque sea solo el primer mensaje
  if (extras.primer_mensaje || nombre || telefono || email) {
    return add({ nombre, telefono, email, origen, destino, empresa, rfc, folio,
                 tipo_carga, tipo_unidad: unidad, peso_toneladas, intent,
                 precio_cotizado: precio, resumen, sessionId, ...extras });
  }
  return null;
}

module.exports = { add, getById, list, stats, exportCsv, extractFromText };
