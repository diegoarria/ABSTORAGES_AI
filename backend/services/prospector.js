// ── Prospector — Motor de búsqueda y enriquecimiento de leads B2B ─────────────
// Fuentes: Apollo.io (primaria), Lusha (enriquecimiento telefónico)
// Uso: prospector.buscar(filtros) → array de prospectos enriquecidos

require('dotenv').config();

const APOLLO_KEY = process.env.APOLLO_API_KEY;
const LUSHA_KEY  = process.env.LUSHA_API_KEY;
const APOLLO_BASE = 'https://api.apollo.io/v1';
const LUSHA_BASE  = 'https://api.lusha.com/v2';
const LUSHA_ROOT  = 'https://api.lusha.com';

// Headers estándar Apollo (key en header, no en body)
const apolloHeaders = () => ({
  'Content-Type': 'application/json',
  'Cache-Control': 'no-cache',
  'x-api-key': APOLLO_KEY,
});

// ── Apollo: buscar personas ───────────────────────────────────────────────────
async function apolloBuscarPersonas(filtros = {}) {
  if (!APOLLO_KEY) throw new Error('APOLLO_API_KEY no configurada');

  const body = {
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
    headers: apolloHeaders(),
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
      headers: apolloHeaders(),
      body: JSON.stringify({
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

// ── Lusha: buscar personas (fallback cuando Apollo no está disponible) ───────
async function lushaBuscarPersonas(filtros = {}) {
  if (!LUSHA_KEY) throw new Error('LUSHA_API_KEY no configurada');

  const size = Math.max(filtros.limite || 25, 10); // Lusha exige size >= 10
  const body = {
    pages: { page: 0, size },
    filters: {
      contacts: {
        include: {
          jobTitles: filtros.cargos || ['Director de Logística', 'Gerente de Operaciones', 'Director de Supply Chain', 'VP Logistics', 'Gerente de Compras', 'Director Comercial'],
          locations: (filtros.ubicaciones || ['Mexico']).map(country => ({ country })),
        },
      },
    },
  };

  const r = await fetch(`${LUSHA_ROOT}/prospecting/contact/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api_key': LUSHA_KEY },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Lusha error ${r.status}: ${err.slice(0, 200)}`);
  }

  const data = await r.json();
  return {
    requestId: data.requestId,
    personas: (data.data || []).map(normalizarPersonaLusha),
  };
}

// ── Lusha: revelar email/teléfono de contactos ya encontrados (gasta créditos) ─
async function lushaEnriquecerContactos(requestId, contactIds) {
  if (!LUSHA_KEY || !contactIds.length) return {};
  try {
    const r = await fetch(`${LUSHA_ROOT}/prospecting/contact/enrich`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api_key': LUSHA_KEY },
      body: JSON.stringify({ requestId, contactIds }),
    });
    if (!r.ok) return {};
    const data = await r.json();
    const porId = {};
    (data.contacts || []).forEach(c => {
      if (c.isSuccess && c.data) porId[c.id] = c.data;
    });
    return porId;
  } catch { return {}; }
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

// ── Normalizar persona de Lusha (formato de búsqueda, sin email/teléfono aún) ─
function normalizarPersonaLusha(p) {
  return {
    id:          p.contactId,
    contactId:   p.contactId,
    nombre:      p.name || '',
    cargo:       p.jobTitle || '',
    empresa:     p.companyName || '',
    dominio:     (p.fqdn || '').replace(/https?:\/\//, ''),
    email:       null,
    linkedin:    null,
    ciudad:      '',
    pais:        'Mexico',
    industria:   '',
    empleados:   null,
    telefono:    null,
    score:       puntuarProspecto({ title: p.jobTitle }),
    fuente:      'lusha',
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
  let personas, requestId = null, fuentePrimaria = 'apollo';

  try {
    personas = await apolloBuscarPersonas(filtros);
  } catch (e) {
    console.warn(`[prospector] Apollo no disponible (${e.message}), usando Lusha como fuente primaria`);
    const lusha = await lushaBuscarPersonas(filtros);
    personas = lusha.personas;
    requestId = lusha.requestId;
    fuentePrimaria = 'lusha';
  }

  // Enriquecer top 5 con datos de contacto (email/teléfono) para no agotar créditos
  const top = personas.sort((a, b) => b.score - a.score).slice(0, filtros.limite || 25);
  const paraEnriquecer = top.slice(0, 5);

  if (fuentePrimaria === 'apollo' && LUSHA_KEY) {
    const enriq = await Promise.allSettled(
      paraEnriquecer.map(p => lushaEnriquecer(p.nombre, p.empresa))
    );
    enriq.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        if (r.value.telefono && !top[i].telefono) top[i].telefono = r.value.telefono;
        if (!top[i].email && r.value.emails?.[0]) top[i].email = r.value.emails[0];
        top[i].fuente = 'apollo+lusha';
      }
    });
  } else if (fuentePrimaria === 'lusha' && requestId) {
    const porId = await lushaEnriquecerContactos(requestId, paraEnriquecer.map(p => p.contactId));
    paraEnriquecer.forEach(p => {
      const d = porId[p.contactId];
      if (!d) return;
      p.email = d.emailAddresses?.[0]?.email || null;
      p.telefono = d.phoneNumbers?.[0]?.number || null;
      p.linkedin = d.socialLinks?.linkedin || null;
      p.industria = d.company?.mainIndustry || '';
      p.ciudad = d.company?.location?.city || '';
      p.pais = d.location?.country || p.pais;
      p.fuente = 'lusha';
    });
  }

  return top;
}

// ── Estadísticas de créditos Apollo ──────────────────────────────────────────
async function creditosApollo() {
  if (!APOLLO_KEY) return null;
  try {
    const r = await fetch(`${APOLLO_BASE}/auth/health`, { headers: apolloHeaders() });
    if (!r.ok) return null;
    const data = await r.json();
    return data;
  } catch { return null; }
}

module.exports = { buscar, apolloEnriquecer, lushaEnriquecer, lushaBuscarPersonas, creditosApollo, puntuarProspecto };
