// TMS — cliente API sobre Google Sheets (Google Apps Script)
// Solo lectura. Maneja el redirect 302 que Google Apps Script hace siempre.
const https = require('https');

const TMS_URL   = process.env.TMS_API_URL  || 'https://script.google.com/macros/s/AKfycbwcL5IyR3sTohDhihoxPSsg7bPxeR3J4gt7mIJ_aieZ3Pn7ouFqgNPfR322iIRT7r3n/exec';
const TMS_TOKEN = process.env.TMS_API_KEY  || 'b4914e954d7e43cd8830b4855f7d9e110b13400cb88d4353b4e4e0306a0bf4ee';
const ENABLED   = !!TMS_URL;

// ── HTTP util ────────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'ABSTORAGES-AI/1.0' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const b = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), 'User-Agent': 'ABSTORAGES-AI/1.0' },
    }, res => {
      if (res.statusCode === 302) return resolve({ redirect: res.headers.location });
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ data: d }));
    });
    req.on('error', reject);
    req.write(b); req.end();
  });
}

// ── Core query ───────────────────────────────────────────────────────────────
async function query(recurso, opts = {}) {
  if (!ENABLED) return null;
  try {
    const r1 = await httpPost(TMS_URL, { token: TMS_TOKEN, recurso, ...opts });
    const raw = r1.redirect ? await httpGet(r1.redirect) : r1.data;
    const parsed = JSON.parse(raw);
    if (!parsed.ok) throw new Error(parsed.error || 'TMS error');
    return parsed;
  } catch (e) {
    console.error('[TMS]', e.message);
    return null;
  }
}

// ── Funciones específicas para SARA ──────────────────────────────────────────

// Buscar cliente por nombre o RFC (devuelve hasta 5 coincidencias)
async function buscarCliente(texto) {
  const r = await query('clientes', {
    pagina: 1, limite: 5,
    filtros: { 'Razon Social': { contiene: texto } },
    campos: ['RFC','Razon Social','Ejecutivo Comercial','Estatus','Dias de crédito',
             'Comentario','Bloqueo de Cliente','Tipo de Servicio',
             'Usuario Principal','Correo principal','Telefono principal','Móvil principal'],
  });
  if (!r) return null;
  // Si no encontró por nombre, intenta por RFC
  if (r.datos.length === 0 && texto.length >= 6) {
    const r2 = await query('clientes', {
      pagina: 1, limite: 5,
      filtros: { 'RFC': { contiene: texto.toUpperCase() } },
      campos: ['RFC','Razon Social','Ejecutivo Comercial','Estatus','Dias de crédito',
               'Comentario','Bloqueo de Cliente','Tipo de Servicio',
               'Usuario Principal','Correo principal','Telefono principal','Móvil principal'],
    });
    return r2?.datos || [];
  }
  return r.datos || [];
}

// Historial de servicios de un cliente (últimos 20)
async function historialCliente(nombreCliente) {
  const r = await query('servicios', {
    pagina: 1, limite: 20,
    filtros: { 'Cliente': { contiene: nombreCliente } },
    campos: ['Folio de servicio','Fecha','Cliente','Cuidad Origen','Estado Origen',
             'Cuidad Destino','Estado Destino','Estatus Operativo','Estatus Administrativo',
             'Costo','Venta total','Margen $','Margen %','Pagada'],
  });
  return r?.datos || [];
}

// Rutas principales (top 15 por volumen) en el periodo dado o último año
async function rutasPrincipales(desde, hasta) {
  const opts = { pagina: 1, limite: 500,
    campos: ['Cuidad Origen','Estado Origen','Cuidad Destino','Estado Destino','Costo','Venta total','Margen %'] };
  if (desde) opts.desde = desde;
  if (hasta) opts.hasta = hasta;

  const r = await query('servicios', opts);
  if (!r) return [];

  // Agrupa por ruta
  const mapa = {};
  for (const s of r.datos) {
    const ruta = `${s['Cuidad Origen']} → ${s['Cuidad Destino']}`;
    if (!mapa[ruta]) mapa[ruta] = { ruta, origen: s['Cuidad Origen'], destino: s['Cuidad Destino'],
      count: 0, costoTotal: 0, ventaTotal: 0, margenes: [] };
    mapa[ruta].count++;
    mapa[ruta].costoTotal += s['Costo'] || 0;
    mapa[ruta].ventaTotal += s['Venta total'] || 0;
    if (s['Margen %']) mapa[ruta].margenes.push(s['Margen %']);
  }

  return Object.values(mapa)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)
    .map(r => ({
      ruta: r.ruta,
      servicios: r.count,
      costoPromedio: Math.round(r.costoTotal / r.count),
      ventaPromedio: Math.round(r.ventaTotal / r.count),
      margenPromedio: r.margenes.length ? (r.margenes.reduce((a,b)=>a+b,0)/r.margenes.length*100).toFixed(1)+'%' : 'N/D',
    }));
}

// Tarifas históricas de un cliente en sus rutas
async function tarifasCliente(nombreCliente) {
  const servicios = await historialCliente(nombreCliente);
  if (!servicios.length) return [];

  const mapa = {};
  for (const s of servicios) {
    const ruta = `${s['Cuidad Origen']} → ${s['Cuidad Destino']}`;
    if (!mapa[ruta]) mapa[ruta] = { ruta, count: 0, costos: [], ventas: [] };
    mapa[ruta].count++;
    if (s['Costo']) mapa[ruta].costos.push(s['Costo']);
    if (s['Venta total']) mapa[ruta].ventas.push(s['Venta total']);
  }

  return Object.values(mapa)
    .sort((a, b) => b.count - a.count)
    .map(r => ({
      ruta: r.ruta,
      servicios: r.count,
      costoPromedio: r.costos.length ? Math.round(r.costos.reduce((a,b)=>a+b,0)/r.costos.length) : null,
      ventaPromedio: r.ventas.length ? Math.round(r.ventas.reduce((a,b)=>a+b,0)/r.ventas.length) : null,
    }));
}

// Directorio de contactos (búsqueda por nombre)
async function directorio(texto) {
  const r = await query('clientes', {
    pagina: 1, limite: 10,
    filtros: { 'Razon Social': { contiene: texto } },
    campos: ['Razon Social','RFC','Estatus','Usuario Principal',
             'Correo principal','Telefono principal','Móvil principal',
             'Recepción de Facturas','Correo RF','Telefono RF',
             'Pagos','Correo Pagos','Telefono pagos'],
  });
  return r?.datos || [];
}

// ── Context builder para SARA ─────────────────────────────────────────────────
// Detecta intención en el mensaje del usuario y pre-fetcha datos del TMS
// Devuelve un bloque de texto para inyectar en el contexto de SARA
async function getContextoSARA(mensajeUsuario) {
  if (!ENABLED) return '';

  const msg = mensajeUsuario.toLowerCase();

  // Detectar si menciona un cliente específico
  // Busca palabras con más de 4 letras que no sean stopwords comunes
  const stopwords = new Set(['para','como','que','con','cuando','donde','cuanto','cuantos',
    'tiene','tienen','tengo','quiero','busco','necesito','dame','dime','cual','cuales',
    'este','esta','estos','estas','todo','todos','alguna','alguno']);
  const palabrasClave = msg.split(/\s+/)
    .filter(w => w.length > 4 && !stopwords.has(w))
    .slice(0, 3);

  const bloques = [];

  // ── Consultas de rutas o tarifas generales ──
  const esRutas   = /rutas|ruta|principales|frecuentes|más movidas|más servicios/.test(msg);
  const esTarifas = /tarifa|tarifas|precio|precios|costo|costos|cuánto cobr|historial de precio/.test(msg);
  const esContacto= /teléfono|telefono|contacto|contactos|correo|email|directorio|número/.test(msg);
  const esCliente = /cliente|clientes|empresa|empresas|historial|cartera/.test(msg);

  // Buscar cliente mencionado por nombre
  let clienteEncontrado = null;
  for (const palabra of palabrasClave) {
    if (palabra.length < 4) continue;
    const resultados = await buscarCliente(palabra);
    if (resultados && resultados.length > 0) {
      clienteEncontrado = resultados[0]['Razon Social'];
      bloques.push(formatearCliente(resultados));
      break;
    }
  }

  // Si mencionan tarifas y hay un cliente → tarifas de ese cliente
  if ((esTarifas || esRutas) && clienteEncontrado) {
    const tarifas = await tarifasCliente(clienteEncontrado);
    if (tarifas.length) bloques.push(formatearTarifasCliente(clienteEncontrado, tarifas));
  }

  // Rutas principales generales
  if (esRutas && !clienteEncontrado) {
    const rutas = await rutasPrincipales();
    if (rutas.length) bloques.push(formatearRutas(rutas));
  }

  // Contactos
  if (esContacto && clienteEncontrado) {
    const contactos = await directorio(clienteEncontrado);
    if (contactos.length) bloques.push(formatearContactos(contactos));
  }

  if (!bloques.length) return '';

  return '\n\n---\n[DATOS TMS — solo para tu uso interno, no compartas datos financieros con el cliente]\n' + bloques.join('\n\n') + '\n---\n';
}

// ── Formateadores ─────────────────────────────────────────────────────────────
function formatearCliente(datos) {
  if (!datos.length) return '';
  const lines = datos.map(c => {
    const tel = c['Telefono principal'] || c['Móvil principal'] || '—';
    return `• ${c['Razon Social']} | RFC: ${c['RFC']} | Estatus: ${c['Estatus']} | Contacto: ${c['Usuario Principal'] || '—'} | Tel: ${tel} | Días crédito: ${c['Dias de crédito']} | ${c['Comentario'] ? 'Nota: ' + c['Comentario'] : ''}${c['Bloqueo de Cliente'] ? ' ⚠ BLOQUEADO' : ''}`;
  });
  return 'CLIENTES ENCONTRADOS EN TMS:\n' + lines.join('\n');
}

function formatearTarifasCliente(nombre, tarifas) {
  const lines = tarifas.map(t =>
    `• ${t.ruta} — ${t.servicios} servicio(s) | Costo prom: $${t.costoPromedio?.toLocaleString('es-MX') || '—'} | Venta prom: $${t.ventaPromedio?.toLocaleString('es-MX') || '—'}`
  );
  return `TARIFAS HISTÓRICAS DE ${nombre.toUpperCase()}:\n` + lines.join('\n');
}

function formatearRutas(rutas) {
  const lines = rutas.map((r, i) =>
    `${i+1}. ${r.ruta} — ${r.servicios} servicios | Costo prom: $${r.costoPromedio?.toLocaleString('es-MX')} | Venta prom: $${r.ventaPromedio?.toLocaleString('es-MX')} | Margen prom: ${r.margenPromedio}`
  );
  return 'RUTAS PRINCIPALES (último año):\n' + lines.join('\n');
}

function formatearContactos(datos) {
  const lines = datos.map(c => {
    const contactos = [];
    if (c['Usuario Principal']) contactos.push(`Contacto principal: ${c['Usuario Principal']} — ${c['Correo principal']} — ${c['Telefono principal'] || c['Móvil principal'] || '—'}`);
    if (c['Recepción de Facturas']) contactos.push(`Facturas: ${c['Recepción de Facturas']} — ${c['Correo RF']} — ${c['Telefono RF'] || '—'}`);
    if (c['Pagos']) contactos.push(`Pagos: ${c['Pagos']} — ${c['Correo Pagos']} — ${c['Telefono pagos'] || '—'}`);
    return `• ${c['Razon Social']}:\n  ` + (contactos.join('\n  ') || 'Sin contactos registrados');
  });
  return 'DIRECTORIO DE CONTACTOS:\n' + lines.join('\n');
}

module.exports = { buscarCliente, historialCliente, rutasPrincipales, tarifasCliente, directorio, getContextoSARA, query, ENABLED };
