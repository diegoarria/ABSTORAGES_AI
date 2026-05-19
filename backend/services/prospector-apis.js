// ─── PROSPECTOR APIS — Apollo, Lusha, ZoomInfo, LinkedIn ──────────────────────
// Cada función retorna un array de prospectos normalizados.
// Si la clave no está configurada, retorna array vacío (el caller hace fallback a Claude).

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
  return {
    empresa:   raw.empresa   || raw.name            || raw.organization_name || raw.company_name || 'Empresa',
    giro:      raw.giro      || raw.industry        || raw.keywords          || '',
    website:   raw.website   || raw.website_url     || raw.primary_domain    || '',
    email:     raw.email     || raw.value           || '',
    telefono:  raw.telefono  || raw.phone           || raw.sanitized_phone   || '',
    linkedin:  raw.linkedin  || raw.linkedin_url    || '',
    empleados: raw.employees || raw.num_employees   || raw.employee_count    || '',
    ciudad:    raw.ciudad    || raw.city            || raw.locality          || '',
    pais:      raw.pais      || raw.country         || 'México',
    por_que:   raw.por_que   || '',
    mensaje:   raw.mensaje   || '',
    fuente:    source,
  };
}

// ── APOLLO.IO ─────────────────────────────────────────────────────────────────
// Docs: https://apolloio.github.io/apollo-api-docs/
// Free tier: 50 export credits/month; organization search available
const APOLLO_KEY = process.env.APOLLO_API_KEY;

async function searchApollo(sector, zona, limit = 8) {
  if (!APOLLO_KEY || APOLLO_KEY.startsWith('xxxx')) return [];

  const body = {
    api_key: APOLLO_KEY,
    q_organization_keyword_tags: [sector],
    // Omit location filter for national searches (zona === null)
    ...(zona ? { organization_locations: [zona] } : { organization_locations: ['Mexico'] }),
    per_page: limit,
    page: 1,
  };

  try {
    const res = await httpsRequest(
      {
        hostname: 'api.apollo.io',
        path: '/v1/mixed_companies/search',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      },
      body
    );
    if (res.status !== 200 || !res.body?.organizations) return [];
    return res.body.organizations.slice(0, limit).map(org =>
      normalize({
        empresa:   org.name,
        giro:      (org.keywords || []).slice(0, 3).join(', ') || org.industry,
        website:   org.website_url || org.primary_domain,
        empleados: org.estimated_num_employees,
        ciudad:    org.city || org.state,
        linkedin:  org.linkedin_url,
        por_que:   `Empresa de ${org.industry || sector} con ${org.estimated_num_employees || '?'} empleados — alta probabilidad de necesitar logística y flete regular.`,
      }, 'Apollo.io')
    );
  } catch (_) { return []; }
}

// ── LUSHA ─────────────────────────────────────────────────────────────────────
// Docs: https://www.lusha.com/docs/
// Plan básico incluye company search; contactos requieren créditos
const LUSHA_KEY = process.env.LUSHA_API_KEY;

async function searchLusha(sector, zona, limit = 8) {
  if (!LUSHA_KEY || LUSHA_KEY.startsWith('xxxx')) return [];

  const params = new URLSearchParams({ company_industry: sector, company_country: 'Mexico', limit: String(limit) });
  if (zona) params.set('company_city', zona);

  try {
    const res = await httpsRequest(
      {
        hostname: 'api.lusha.com',
        path: `/companies?${params}`,
        method: 'GET',
        headers: { api_key: LUSHA_KEY, 'Content-Type': 'application/json' },
      }
    );
    if (res.status !== 200 || !res.body?.data) return [];
    return res.body.data.slice(0, limit).map(c =>
      normalize({
        empresa:  c.name,
        giro:     c.industry,
        website:  c.website,
        empleados:c.employees,
        ciudad:   c.city || zona,
        telefono: c.phone,
        por_que:  `Empresa de ${c.industry || sector} en ${c.city || zona} con ${c.employees || '?'} empleados — candidata para servicios de flete.`,
      }, 'Lusha')
    );
  } catch (_) { return []; }
}

// ── ZOOMINFO ──────────────────────────────────────────────────────────────────
// Docs: https://api-docs.zoominfo.com/
// Requires OAuth2: CLIENT_ID + CLIENT_SECRET → access token
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

async function searchZoomInfo(sector, zona, limit = 8) {
  if (!ZI_CLIENT || ZI_CLIENT.startsWith('xxxx') || !ZI_SECRET) return [];

  try {
    const token = await getZoomInfoToken();
    if (!token) return [];

    const locationFilter = zona
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
    return res.body.data.result.slice(0, limit).map(c =>
      normalize({
        empresa:  c.name,
        giro:     c.industry,
        website:  c.website,
        telefono: c.phone,
        empleados:c.employeeCount,
        ciudad:   c.city || zona,
        linkedin: c.linkedInUrl,
        por_que:  `${c.industry || sector} con ${c.employeeCount || '?'} empleados en ${c.city || zona} — perfil ideal para transporte de carga.`,
      }, 'ZoomInfo')
    );
  } catch (_) { return []; }
}

// ── LINKEDIN / SALES NAVIGATOR ────────────────────────────────────────────────
// Usa LinkedIn Marketing API (Company Search) — requiere app OAuth aprobada
// ADVERTENCIA: LinkedIn restringe scraping; usar solo con tokens OAuth oficiales
const LI_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;

async function searchLinkedIn(sector, zona, limit = 8) {
  if (!LI_TOKEN || LI_TOKEN.startsWith('xxxx')) return [];

  const params = new URLSearchParams({
    q: 'companiesV2',
    facetGeoRegion: zona,
    facetIndustry: sector,
    count: String(limit),
    start: '0',
  });

  try {
    const res = await httpsRequest(
      {
        hostname: 'api.linkedin.com',
        path: `/v2/companiesV2?${params}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${LI_TOKEN}`,
          'X-Restli-Protocol-Version': '2.0.0',
        },
      }
    );
    if (res.status !== 200 || !res.body?.elements) return [];
    return res.body.elements.slice(0, limit).map(c =>
      normalize({
        empresa:  c.localizedName || c.name?.localized?.es_ES || c.name?.localized?.en_US || 'Empresa',
        giro:     c.companyIndustries?.[0] || sector,
        website:  c.companyPageUrl,
        empleados:c.staffCountRange?.start,
        ciudad:   zona,
        linkedin: `https://www.linkedin.com/company/${c.id}`,
        por_que:  `Empresa de ${sector} en LinkedIn con presencia activa — candidata para servicios logísticos.`,
      }, 'LinkedIn')
    );
  } catch (_) { return []; }
}

// ── Función principal: busca en todas las fuentes disponibles ─────────────────
async function searchAll(sector, zona, limit = 8) {
  const results = await Promise.allSettled([
    searchApollo(sector, zona, limit),
    searchLusha(sector, zona, limit),
    searchZoomInfo(sector, zona, limit),
    searchLinkedIn(sector, zona, limit),
  ]);

  const combined = [];
  const sources = [];

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      combined.push(...r.value);
      if (r.value[0]?.fuente) sources.push(r.value[0].fuente);
    }
  }

  // Deduplication por nombre
  const seen = new Set();
  const deduped = combined.filter(p => {
    const key = (p.empresa || '').toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { prospectos: deduped.slice(0, limit), sources };
}

// ── Estado de API Keys configuradas ─────────────────────────────────────────
function apiStatus() {
  return {
    apollo:    !!(APOLLO_KEY && !APOLLO_KEY.startsWith('xxxx')),
    lusha:     !!(LUSHA_KEY  && !LUSHA_KEY.startsWith('xxxx')),
    zoominfo:  !!(ZI_CLIENT  && !ZI_CLIENT.startsWith('xxxx') && ZI_SECRET),
    linkedin:  !!(LI_TOKEN   && !LI_TOKEN.startsWith('xxxx')),
  };
}

module.exports = { searchAll, searchApollo, searchLusha, searchZoomInfo, searchLinkedIn, apiStatus };
