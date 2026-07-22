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
  const sid = lead.sessionId || '';
  const existing = sid ? cache.find(l => l.sessionId === sid) : null;

  if (existing) {
    // Upsert en memoria: actualizar solo campos que mejoran lo que ya hay
    const merge = (oldVal, newVal) =>
      (newVal && newVal !== '—' && newVal !== null && newVal !== undefined) ? newVal : oldVal;
    existing.nombre          = merge(existing.nombre,          lead.nombre);
    existing.empresa         = merge(existing.empresa,         lead.empresa);
    existing.rfc             = merge(existing.rfc,             lead.rfc);
    existing.telefono        = merge(existing.telefono,        lead.telefono);
    existing.email           = merge(existing.email,           lead.email);
    existing.origen          = merge(existing.origen,          lead.origen);
    existing.destino         = merge(existing.destino,         lead.destino);
    existing.tipo_carga      = merge(existing.tipo_carga,      lead.tipo_carga);
    existing.tipo_unidad     = merge(existing.tipo_unidad,     lead.tipo_unidad);
    existing.peso_toneladas  = merge(existing.peso_toneladas,  lead.peso_toneladas);
    existing.precio_cotizado = merge(existing.precio_cotizado, lead.precio_cotizado);
    existing.folio           = merge(existing.folio,           lead.folio);
    if (lead.intent && lead.intent !== 'otro') existing.intent = lead.intent;
    if (lead.sara_nota)     existing.sara_nota    = lead.sara_nota;
    if (lead.primer_mensaje) existing.primer_mensaje = lead.primer_mensaje;
    if (lead.resumen)       existing.resumen      = lead.resumen;
    if (lead.ip)            existing.ip           = lead.ip;
    scheduleSave();
    saveToDb(existing);
    return existing;
  }

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
    sessionId:       sid,
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

async function list({ limit = 500, desde = null, hasta = null } = {}) {
  if (pool) {
    try {
      const conds = [], vals = [];
      if (desde) { conds.push(`created_at >= $${vals.length+1}`); vals.push(desde); }
      if (hasta) { conds.push(`created_at <= $${vals.length+1}`); vals.push(hasta); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      vals.push(limit);
      const { rows } = await pool.query(
        `SELECT * FROM leads ${where} ORDER BY created_at DESC LIMIT $${vals.length}`, vals
      );
      return rows;
    } catch (e) { console.error('[leads] list DB error:', e.message); }
  }
  let rows = [...cache].reverse();
  if (desde) rows = rows.filter(l => new Date(l.created_at) >= new Date(desde));
  if (hasta) rows = rows.filter(l => new Date(l.created_at) <= new Date(hasta));
  return rows.slice(0, limit);
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
  // Nombre — "me llamo X", "soy X", "mi nombre es X", "nombre: X"
  const nombre =
    text.match(/(?:me llamo|mi nombre es|nombre[:\s]+)\s*([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?: [A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+)/i)?.[1] ||
    text.match(/^soy\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?: [A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+)/im)?.[1];

  // Teléfono — 10 dígitos con o sin prefijo 52
  const telefono = text.match(/(?:\+?52\s*)?(\d{2,3}[\s\-]?\d{3,4}[\s\-]?\d{4})/)?.[1];

  // Email
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];

  // Empresa — "empresa X", "trabajo en X", "mi empresa es X"
  const empresa =
    text.match(/(?:empresa[:\s]+|mi empresa(?:\s+es)?\s+|trabajo (?:en|para)\s+)([^\n,.(]{2,50})/i)?.[1]?.trim();

  // RFC
  const rfc = text.match(/\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/i)?.[1]?.toUpperCase();

  // Folio ABST
  const folio = text.match(/ABST-\d+/)?.[0];

  // Precio — "$15,000", "15000 pesos"
  const precio = text.match(/\$\s*([\d,]+)/)?.[0];

  // Tipo unidad
  const unidad = text.match(/caja\s+(?:seca\s+)?(?:de\s+)?\d{2}(?:\s+pies)?|caja\s+(?:seca|refrigerada)|torton|rabe?on|plataforma|full\b/i)?.[0];

  // Peso
  const peso_toneladas = text.match(/(\d+(?:\.\d+)?)\s*(?:ton(?:eladas?)?)\b/i)?.[1];

  // Ruta — "de MTY a GDL", "Monterrey a Guadalajara", "MTY → GDL"
  const rutaMatch =
    text.match(/(?:de|desde)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ]{3,}(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+)?)\s+(?:a|hacia)\s+([A-ZÁÉÍÓÚÑa-záéíóúñ]{3,}(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+)?)/i) ||
    text.match(/([A-ZÁÉÍÓÚÑa-záéíóúñ]{3,})\s*(?:→|->)\s*([A-ZÁÉÍÓÚÑa-záéíóúñ]{3,})/i);
  const origen  = rutaMatch?.[1]?.trim() || null;
  const destino = rutaMatch?.[2]?.trim() || null;

  // Tipo de carga — "carga de X", "llevo X", "transportar X", "son X botellas/cajas/etc."
  const tipo_carga =
    text.match(/(?:carga\s+de|llevo|transportar|mercancía[:\s]+|producto[:\s]+)\s*([^\n,.(\d]{3,50})/i)?.[1]?.trim() ||
    text.match(/(?:son|es)\s+([a-záéíóúñA-ZÁÉÍÓÚÑ][^\n,.(]{3,40})/i)?.[1]?.trim();

  const intent = detectIntent(text);

  const partes = [];
  if (empresa && empresa !== '—') partes.push(empresa);
  else if (nombre) partes.push(nombre);
  if (origen && destino) partes.push(`${origen} → ${destino}`);
  if (tipo_carga) partes.push(tipo_carga);
  if (unidad)  partes.push(unidad);
  if (precio)  partes.push(precio);
  const resumen = partes.join(' · ');

  // SIEMPRE guardar — toda conversación con SARA se registra sin excepción
  return add({ nombre, telefono, email, origen, destino, empresa, rfc, folio,
               tipo_carga, tipo_unidad: unidad, peso_toneladas, intent,
               precio_cotizado: precio, resumen, sessionId, ...extras });
}

module.exports = { add, getById, list, stats, exportCsv, extractFromText };
