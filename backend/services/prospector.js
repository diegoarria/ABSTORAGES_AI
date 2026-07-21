// ── Prospector — Motor de búsqueda y enriquecimiento de leads B2B ─────────────
// Fuentes: Apollo.io (primaria), Lusha (enriquecimiento telefónico)
// Uso: prospector.buscar(filtros) → array de prospectos enriquecidos

require('dotenv').config();

const APOLLO_KEY = process.env.APOLLO_API_KEY;
const LUSHA_KEY  = process.env.LUSHA_API_KEY;
const APOLLO_BASE = 'https://api.apollo.io/v1';
const LUSHA_BASE  = 'https://api.lusha.com/v2';

// ── Apollo: buscar personas ───────────────────────────────────────────────────
async function apolloBuscarPersonas(filtros = {}) {
  if (!APOLLO_KEY) throw new Error('APOLLO_API_KEY no configurada');

  const body = {
    api_key: APOLLO_KEY,
    page: filtros.pagina || 1,
    per_page: filtros.limite || 25,
    person_titles: filtros.cargos || ['Director de Logística', 'Gerente de Operaciones', 'Director de Supply Chain', 'VP Logistics', 'Gerente de Compras', 'Director Comercial'],
    organization_industry_tag_ids: [],
    organization_locations: filtros.ubicaciones || ['Mexico'],
    organization_num_employees_ranges: filtros.tamano || ['1,200'],
    contact_email_status: ['verified', 'likely to engage'],
  };

  if (filtros.industrias?.length) body.organization_industry_tag_ids = filtros.industrias;
  if (filtros.palabrasClave?.length) body.q_keywords = filtros.palabrasClave.join(' ');

  const r = await fetch(`${APOLLO_BASE}/mixed_people/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Apollo error ${r.status}: ${err.slice(0, 200)}`);
  }

  const data = await r.json();
  return (data.people || []).map(normalizarPersona);
}

// ── Apollo: enriquecer un contacto con email ─────────────────────────────────
async function apolloEnriquecer(nombre, empresa, dominio) {
  if (!APOLLO_KEY) return null;
  try {
    const r = await fetch(`${APOLLO_BASE}/people/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: APOLLO_KEY,
        name: nombre,
        organization_name: empresa,
        domain: dominio,
        reveal_personal_emails: false,
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return normalizarPersona(data.person || {});
  } catch { return null; }
}

// ── Lusha: enriquecer con teléfono ───────────────────────────────────────────
async function lushaEnriquecer(nombre, empresa) {
  if (!LUSHA_KEY) return null;
  try {
    const params = new URLSearchParams({ fullName: nombre, company: empresa });
    const r = await fetch(`${LUSHA_BASE}/person?${params}`, {
      headers: { 'api_key': LUSHA_KEY },
    });
    if (!r.ok) return null;
    const data = await r.json();
    return {
      telefono: data.phoneNumbers?.[0]?.normalizedNumber || null,
      emails: data.emails?.map(e => e.email) || [],
    };
  } catch { return null; }
}

// ── Normalizar persona de Apollo ──────────────────────────────────────────────
function normalizarPersona(p) {
  return {
    id:          p.id || null,
    nombre:      p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
    cargo:       p.title || '',
    empresa:     p.organization?.name || p.organization_name || '',
    dominio:     p.organization?.website_url?.replace(/https?:\/\//,'').split('/')[0] || '',
    email:       p.email || null,
    linkedin:    p.linkedin_url || null,
    ciudad:      p.city || '',
    pais:        p.country || 'Mexico',
    industria:   p.organization?.industry || '',
    empleados:   p.organization?.estimated_num_employees || null,
    telefono:    p.phone_numbers?.[0]?.raw_number || null,
    score:       puntuarProspecto(p),
    fuente:      'apollo',
    estado:      'nuevo',
    creado:      new Date().toISOString(),
  };
}

// ── Scoring de prioridad ──────────────────────────────────────────────────────
function puntuarProspecto(p) {
  let score = 0;
  const titulo = (p.title || '').toLowerCase();
  const industria = (p.organization?.industry || '').toLowerCase();

  // Cargo de decisión
  if (/director|vp|ceo|coo|chief/.test(titulo))    score += 40;
  else if (/gerente|manager|head/.test(titulo))     score += 25;
  else if (/coordinador|supervisor/.test(titulo))   score += 10;

  // Industria relevante para ABSTORAGES
  if (/logística|logistic|transport|supply chain|manufactur|distribuci/.test(industria)) score += 30;
  else if (/retail|comercio|import|export/.test(industria)) score += 15;

  // Tiene email verificado
  if (p.email_status === 'verified') score += 15;
  if (p.email) score += 10;

  // Tamaño empresa (mediana → más probable que tercericen)
  const emp = p.organization?.estimated_num_employees || 0;
  if (emp >= 50 && emp <= 500) score += 10;

  return Math.min(score, 100);
}

// ── Buscar + enriquecer pipeline completo ────────────────────────────────────
async function buscar(filtros = {}) {
  const personas = await apolloBuscarPersonas(filtros);

  // Enriquecer con Lusha en paralelo (máx 5 para no agotar créditos)
  const top = personas.sort((a, b) => b.score - a.score).slice(0, filtros.limite || 25);

  if (LUSHA_KEY) {
    const enriq = await Promise.allSettled(
      top.slice(0, 5).map(p => lushaEnriquecer(p.nombre, p.empresa))
    );
    enriq.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        if (r.value.telefono && !top[i].telefono) top[i].telefono = r.value.telefono;
        if (!top[i].email && r.value.emails?.[0]) top[i].email = r.value.emails[0];
        top[i].fuente = 'apollo+lusha';
      }
    });
  }

  return top;
}

// ── Estadísticas de créditos Apollo ──────────────────────────────────────────
async function creditosApollo() {
  if (!APOLLO_KEY) return null;
  try {
    const r = await fetch(`${APOLLO_BASE}/auth/health?api_key=${APOLLO_KEY}`);
    if (!r.ok) return null;
    const data = await r.json();
    return data;
  } catch { return null; }
}

module.exports = { buscar, apolloEnriquecer, lushaEnriquecer, creditosApollo, puntuarProspecto };
