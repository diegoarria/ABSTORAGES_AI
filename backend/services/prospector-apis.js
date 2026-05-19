// ─── PROSPECTOR APIS — Apollo, Lusha, ZoomInfo, LinkedIn ──────────────────────
// Retorna prospectos normalizados con: empresa, nombre, cargo, email, telefono.
// Si la clave no está configurada, retorna [].

const https = require('https');

// ── Utilidad HTTP ──────────────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Normalización ──────────────────────────────────────────────────────────────
function normalize(raw, source) {
  const nombre = raw.nombre || raw.first_name
    ? [raw.first_name || '', raw.last_name || ''].join(' ').trim()
    : raw.contact_name || raw.owner_name || '';

  return {
    empresa:  raw.empresa  || raw.name           || raw.organization_name || raw.company_name || '',
    giro:     raw.giro     || raw.industry        || raw.keywords          || '',
    ciudad:   raw.ciudad   || raw.city            || raw.locality          || '',
    pais:     raw.pais     || raw.country         || 'México',
    website:  raw.website  || raw.website_url     || raw.primary_domain    || '',
    linkedin: raw.linkedin || raw.linkedin_url    || '',
    empleados:raw.empleados|| raw.num_employees   || raw.employee_count    || '',
    // Datos de contacto — el objetivo principal
    nombre:   nombre,
    cargo:    raw.cargo    || raw.title           || raw.job_title         || '',
    email:    raw.email    || raw.value           || '',
    telefono: raw.telefono || raw.phone           || raw.sanitized_phone   || '',
    fuente:   source,
  };
}

// ── APOLLO.IO ─────────────────────────────────────────────────────────────────
// Usamos people search (no company search) para obtener nombre, cargo, email, teléfono reales.
// Docs: https://apolloio.github.io/apollo-api-docs/#mixed-people-search
const APOLLO_KEY = process.env.APOLLO_API_KEY;

async function searchApollo(sector, zona, limit = 10) {
  if (!APOLLO_KEY || APOLLO_KEY.startsWith('xxxx')) return [];

  // Títulos de decisores logísticos más comunes en México
  const titulos = [
    'Director de Logística', 'Director de Compras', 'Director de Supply Chain',
    'Gerente de Logística', 'Gerente de Compras', 'Gerente de Operaciones',
    'Director General', 'CEO', 'Director Comercial',
  ];

  const body = {
    q_organization_keyword_tags: [sector],
    person_titles: titulos,
    organization_locations: zona && zona !== 'todo-mexico'
      ? [`${zona}, Mexico`]
      : ['Mexico'],
    contact_email_status_v2: ['verified', 'likely_to_engage'],
    per_page: limit,
    page: 1,
  };

  try {
    const res = await httpsRequest(
      {
        hostname: 'api.apollo.io',
        path: '/v1/mixed_people/search',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'X-Api-Key': APOLLO_KEY,
        },
      },
      body
    );

    if (res.status !== 200 || !res.body?.people) return [];

    return res.body.people.slice(0, limit).map(p => {
      const org = p.organization || {};
      const phone = (p.phone_numbers || [])[0]?.sanitized_number || org.phone || '';
      return normalize({
        nombre:    p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim(),
        cargo:     p.title || '',
        email:     p.email || '',
        telefono:  phone,
        empresa:   org.name || p.organization_name || '',
        giro:      org.industry || (org.keywords || []).slice(0, 2).join(', ') || sector,
        website:   org.website_url || org.primary_domain || '',
        linkedin:  org.linkedin_url || p.linkedin_url || '',
        empleados: org.estimated_num_employees || '',
        ciudad:    org.city || org.state || zona || '',
      }, 'Apollo.io');
    });
  } catch (err) {
    console.error('[Apollo] Error:', err.message);
    return [];
  }
}

// ── LUSHA ─────────────────────────────────────────────────────────────────────
// Lusha es enrichment (no búsqueda masiva): dado un dominio devuelve datos de empresa.
// Se usa para enriquecer resultados de Apollo cuando éste no trae teléfono/email.
// Docs: https://www.lusha.com/docs/
const LUSHA_KEY = process.env.LUSHA_API_KEY;

async function enrichLusha(domain) {
  if (!LUSHA_KEY || LUSHA_KEY.startsWith('xxxx') || !domain) return null;

  try {
    const res = await httpsRequest({
      hostname: 'api.lusha.com',
      path: `/company?domain=${encodeURIComponent(domain)}`,
      method: 'GET',
      headers: { api_key: LUSHA_KEY },
    });

    if (res.status !== 200 || !res.body?.data) return null;
    const d = res.body.data;
    return {
      telefono: d.phone || '',
      empleados: d.employees || d.employeesInLinkedin || '',
      descripcion: d.description || '',
      industria: d.mainIndustry || '',
    };
  } catch (_) { return null; }
}

// searchLusha: no disponible en el plan actual — Lusha es enrichment, no búsqueda.
async function searchLusha(sector, zona, limit = 10) {
  return [];
}

// ── ZOOMINFO ──────────────────────────────────────────────────────────────────
const ZI_CLIENT = process.env.ZOOMINFO_CLIENT_ID;
const ZI_SECRET = process.env.ZOOMINFO_CLIENT_SECRET;

async function getZoomInfoToken() {
  const res = await httpsRequest(
    {
      hostname: 'api.zoominfo.com',
      path: '/authenticate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    { client_id: ZI_CLIENT, private_key: ZI_SECRET }
  );
  return res.body?.jwt || null;
}

async function searchZoomInfo(sector, zona, limit = 10) {
  if (!ZI_CLIENT || ZI_CLIENT.startsWith('xxxx') || !ZI_SECRET) return [];

  try {
    const token = await getZoomInfoToken();
    if (!token) return [];

    const locationFilter = zona && zona !== 'todo-mexico'
      ? { locationSearchType: 'CITY', stateList: [zona] }
      : { locationSearchType: 'COUNTRY', countryList: ['Mexico'] };

    const body = {
      matchCompanyInput: [
        { industryList: [{ value: sector, matchType: 'FUZZY' }] },
        locationFilter,
      ],
      outputFields: ['id','name','website','phone','city','state','employeeCount','industry','linkedInUrl'],
      rpp: limit,
      page: 1,
    };

    const res = await httpsRequest(
      {
        hostname: 'api.zoominfo.com',
        path: '/enrich/search/company',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      },
      body
    );

    if (res.status !== 200 || !res.body?.data?.result) return [];

    return res.body.data.result.slice(0, limit).map(c => {
      const cp = (c.contacts || [])[0] || {};
      return normalize({
        empresa:  c.name || '',
        giro:     c.industry || sector,
        website:  c.website || '',
        telefono: cp.phone || c.phone || '',
        empleados:c.employeeCount || '',
        ciudad:   c.city || zona || '',
        linkedin: c.linkedInUrl || '',
        email:    cp.email || '',
        nombre:   [cp.firstName || '', cp.lastName || ''].join(' ').trim(),
        cargo:    cp.jobTitle || '',
      }, 'ZoomInfo');
    });
  } catch (err) {
    console.error('[ZoomInfo] Error:', err.message);
    return [];
  }
}

// ── Función principal ─────────────────────────────────────────────────────────
async function searchAll(sector, zona, limit = 10) {
  // Apollo es la única fuente de búsqueda activa; ZoomInfo requiere enterprise
  const [apolloR, zoomR] = await Promise.allSettled([
    searchApollo(sector, zona, limit),
    searchZoomInfo(sector, zona, limit),
  ]);

  const combined = [];
  const sources  = [];

  for (const r of [apolloR, zoomR]) {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      combined.push(...r.value);
      const src = r.value[0]?.fuente;
      if (src && !sources.includes(src)) sources.push(src);
    }
  }

  // Enriquecer con Lusha los que tienen dominio pero no teléfono
  if (LUSHA_KEY && !LUSHA_KEY.startsWith('xxxx')) {
    const toEnrich = combined.filter(p => p.website && !p.telefono).slice(0, 5);
    await Promise.all(toEnrich.map(async p => {
      const domain = (p.website || '').replace(/^https?:\/\//, '').split('/')[0];
      const extra = await enrichLusha(domain);
      if (extra) {
        if (extra.telefono)  p.telefono  = extra.telefono;
        if (extra.empleados) p.empleados = extra.empleados;
      }
    }));
    if (toEnrich.length > 0 && !sources.includes('Lusha')) sources.push('Lusha');
  }

  // Deduplicar por email primero, luego por nombre+empresa
  const seen = new Set();
  const deduped = combined.filter(p => {
    const key = p.email
      ? p.email.toLowerCase()
      : `${(p.nombre || '').toLowerCase()}|${(p.empresa || '').toLowerCase()}`;
    if (seen.has(key) || !key || key === '|') return false;
    seen.add(key);
    return true;
  });

  return { prospectos: deduped.slice(0, limit * 2), sources };
}

// ── Estado de API Keys ────────────────────────────────────────────────────────
function apiStatus() {
  return {
    // apollo: key válida pero requiere plan Basic ($49/mes) para búsqueda por API
    apollo:         !!(APOLLO_KEY && !APOLLO_KEY.startsWith('xxxx')),
    apollo_plan_ok: false, // se actualiza a true cuando el plan lo permite
    // lusha: key válida, funciona como enriquecimiento por dominio
    lusha:          !!(LUSHA_KEY  && !LUSHA_KEY.startsWith('xxxx')),
    lusha_mode:     'enrichment',
    zoominfo:       !!(ZI_CLIENT  && !ZI_CLIENT.startsWith('xxxx') && ZI_SECRET),
    linkedin:       false,
  };
}

module.exports = { searchAll, searchApollo, searchLusha, searchZoomInfo, apiStatus };
