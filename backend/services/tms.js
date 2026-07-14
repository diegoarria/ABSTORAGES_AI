// TMS — cliente API sobre Google Sheets (Google Apps Script)
// Solo lectura. Maneja el redirect 302 que Google Apps Script hace siempre.
const https = require('https');

const TMS_URL   = process.env.TMS_API_URL  || 'https://script.google.com/macros/s/AKfycbwcL5IyR3sTohDhihoxPSsg7bPxeR3J4gt7mIJ_aieZ3Pn7ouFqgNPfR322iIRT7r3n/exec';
const TMS_TOKEN = process.env.TMS_API_KEY  || 'b4914e954d7e43cd8830b4855f7d9e110b13400cb88d4353b4e4e0306a0bf4ee';
const ENABLED   = !!TMS_URL;

// ── HTTP util ────────────────────────────────────────────────────────────────
const TMS_TIMEOUT_MS = 25000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TMS timeout')), ms)),
  ]);
}

function httpGet(url) {
  return withTimeout(new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'ABSTORAGES-AI/1.0' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
  }), TMS_TIMEOUT_MS);
}

function httpPost(url, body) {
  return withTimeout(new Promise((resolve, reject) => {
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
  }), TMS_TIMEOUT_MS);
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
    console.error('[TMS]', recurso, e.message);
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

// ── Funciones específicas para SOFIA ─────────────────────────────────────────

// Buscar proveedor/transportista por nombre o RFC
async function buscarProveedor(texto) {
  const por_nombre = await query('proveedores', {
    pagina: 1, limite: 5,
    filtros: { 'Razon Social': { contiene: texto } },
    campos: ['Folio','RFC','Razon Social','Contacto','Correo','Telefono','Movil','Estatus','Comentarios','Emergencia'],
  });
  if (por_nombre?.datos?.length) return por_nombre.datos;

  // Intentar por RFC si el texto parece un RFC
  if (texto.length >= 6) {
    const por_rfc = await query('proveedores', {
      pagina: 1, limite: 5,
      filtros: { 'RFC': { contiene: texto.toUpperCase() } },
      campos: ['Folio','RFC','Razon Social','Contacto','Correo','Telefono','Movil','Estatus','Comentarios','Emergencia'],
    });
    if (por_rfc?.datos?.length) return por_rfc.datos;
  }
  return [];
}

// Rutas que ha manejado un proveedor + costos históricos (desde detalle_servicios)
async function rutasProveedor(nombreProveedor) {
  const r = await query('detalle_servicios', {
    pagina: 1, limite: 200,
    filtros: { 'Proveedor': { contiene: nombreProveedor } },
    campos: ['Folio de servicio','Fecha de Servicio','Proveedor','Cliente',
             'Cuidad Origen','Estado Origen','Cuidad destino','Estado destino',
             'Costo','Estatus Operaciones'],
  });
  if (!r?.datos?.length) return [];

  // Agrupar por ruta
  const mapa = {};
  for (const s of r.datos) {
    const origen  = s['Cuidad Origen']  || s['Estado Origen']  || '?';
    const destino = s['Cuidad destino'] || s['Estado destino'] || '?';
    const ruta    = `${origen} → ${destino}`;
    if (!mapa[ruta]) mapa[ruta] = { ruta, count: 0, costos: [], ultimoFolio: '', ultimaFecha: '' };
    mapa[ruta].count++;
    if (s['Costo']) mapa[ruta].costos.push(Number(s['Costo']));
    if (s['Folio de servicio']) mapa[ruta].ultimoFolio = s['Folio de servicio'];
    if (s['Fecha de Servicio']) mapa[ruta].ultimaFecha = s['Fecha de Servicio'].slice(0,10);
  }

  return Object.values(mapa)
    .sort((a, b) => b.count - a.count)
    .map(r => ({
      ruta: r.ruta,
      servicios: r.count,
      costoPromedio: r.costos.length ? Math.round(r.costos.reduce((a,b)=>a+b,0)/r.costos.length) : null,
      costoMin: r.costos.length ? Math.min(...r.costos) : null,
      costoMax: r.costos.length ? Math.max(...r.costos) : null,
      ultimaFecha: r.ultimaFecha,
    }));
}

// Proveedores que han manejado una ruta específica (por ciudad origen → destino)
async function proveedoresPorRuta(origen, destino) {
  const filtros = {};
  if (origen)  filtros['Cuidad Origen']  = { contiene: origen };
  if (destino) filtros['Cuidad destino'] = { contiene: destino };

  const r = await query('detalle_servicios', {
    pagina: 1, limite: 200,
    filtros,
    campos: ['Proveedor','Cuidad Origen','Cuidad destino','Costo','Fecha de Servicio','Estatus Operaciones'],
  });
  if (!r?.datos?.length) return [];

  const mapa = {};
  for (const s of r.datos) {
    const prov = s['Proveedor']?.trim();
    if (!prov) continue;
    if (!mapa[prov]) mapa[prov] = { proveedor: prov, count: 0, costos: [], ultimaFecha: '' };
    mapa[prov].count++;
    if (s['Costo']) mapa[prov].costos.push(Number(s['Costo']));
    if (s['Fecha de Servicio'] > mapa[prov].ultimaFecha) mapa[prov].ultimaFecha = s['Fecha de Servicio'].slice(0,10);
  }

  return Object.values(mapa)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map(p => ({
      proveedor: p.proveedor,
      servicios: p.count,
      costoPromedio: p.costos.length ? Math.round(p.costos.reduce((a,b)=>a+b,0)/p.costos.length) : null,
      ultimaFecha: p.ultimaFecha,
    }));
}

// Context builder para SOFIA
async function getContextoSOFIA(mensajeUsuario) {
  if (!ENABLED) return '';

  const msg = mensajeUsuario.toLowerCase();
  const stopwords = new Set(['para','como','que','con','cuando','donde','cuanto','cuantos',
    'tiene','tienen','tengo','quiero','busco','necesito','dame','dime','cual','cuales',
    'este','esta','estos','estas','todo','todos','alguna','alguno','proveedor','transportista']);

  const palabrasClave = msg.split(/\s+/)
    .filter(w => w.length > 4 && !stopwords.has(w))
    .slice(0, 3);

  const esProveedor  = /proveedor|transportista|flete|camión|unidad|operador|carrier/.test(msg);
  const esRuta       = /ruta|rutas|origen|destino|maneja|cubre|atiende/.test(msg);
  const esContacto   = /teléfono|telefono|contacto|correo|email|número|llamar/.test(msg);
  const esCosto      = /costo|costos|precio|precios|tarifa|tarifas|cuánto|cobra/.test(msg);

  const bloques = [];
  let proveedorEncontrado = null;

  // Buscar proveedor mencionado por nombre
  for (const palabra of palabrasClave) {
    if (palabra.length < 4) continue;
    const resultados = await buscarProveedor(palabra);
    if (resultados.length > 0) {
      proveedorEncontrado = resultados[0]['Razon Social'];
      bloques.push(formatearProveedor(resultados));
      break;
    }
  }

  // Rutas y costos históricos del proveedor
  if (proveedorEncontrado && (esRuta || esCosto || esProveedor)) {
    const rutas = await rutasProveedor(proveedorEncontrado);
    if (rutas.length) bloques.push(formatearRutasProveedor(proveedorEncontrado, rutas));
  }

  // Proveedores disponibles para una ruta mencionada
  if (esRuta && !proveedorEncontrado) {
    // Detectar ciudades en el mensaje (palabras capitalizadas o en contexto de ruta)
    const ciudades = mensajeUsuario.match(/[A-ZÁÉÍÓÚ][a-záéíóú]+(?:\s+[A-ZÁÉÍÓÚ][a-záéíóú]+)*/g) || [];
    if (ciudades.length >= 2) {
      const provs = await proveedoresPorRuta(ciudades[0], ciudades[1]);
      if (provs.length) bloques.push(formatearProveedoresPorRuta(ciudades[0], ciudades[1], provs));
    }
  }

  if (!bloques.length) return '';
  return '\n\n---\n[DATOS TMS PROVEEDORES — uso interno SOFIA]\n' + bloques.join('\n\n') + '\n---\n';
}

// ── Formateadores SOFIA ───────────────────────────────────────────────────────
function formatearProveedor(datos) {
  const lines = datos.map(p => {
    const tel = p['Telefono_limpio']?.[0] || p['Telefono'] || '—';
    const mov = p['Movil_limpio']?.[0]    || p['Movil']    || '—';
    return `• ${p['Razon Social']} | Folio: ${p['Folio']} | RFC: ${p['RFC'] || '—'} | Estatus: ${p['Estatus']} | Contacto: ${p['Contacto'] || '—'} | Tel: ${tel} | Móvil: ${mov} | Correo: ${p['Correo'] || '—'}${p['Emergencia'] ? ' | ⚡ Emergencia: '+p['Emergencia'] : ''}${p['Comentarios'] ? ' | Nota: '+p['Comentarios'] : ''}`;
  });
  return 'PROVEEDORES ENCONTRADOS EN TMS:\n' + lines.join('\n');
}

function formatearRutasProveedor(nombre, rutas) {
  const lines = rutas.map(r =>
    `• ${r.ruta} — ${r.servicios} servicio(s) | Costo prom: $${r.costoPromedio?.toLocaleString('es-MX') || '—'} | Rango: $${r.costoMin?.toLocaleString('es-MX') || '—'}–$${r.costoMax?.toLocaleString('es-MX') || '—'} | Último: ${r.ultimaFecha || '—'}`
  );
  return `RUTAS MANEJADAS POR ${nombre.toUpperCase()}:\n` + lines.join('\n');
}

function formatearProveedoresPorRuta(origen, destino, provs) {
  const lines = provs.map(p =>
    `• ${p.proveedor} — ${p.servicios} servicio(s) | Costo prom: $${p.costoPromedio?.toLocaleString('es-MX') || '—'} | Último servicio: ${p.ultimaFecha || '—'}`
  );
  return `PROVEEDORES QUE HAN CUBIERTO ${origen.toUpperCase()} → ${destino.toUpperCase()}:\n` + lines.join('\n');
}

// ── Funciones específicas para NOA ───────────────────────────────────────────

// Buscar folio completo (P-MON-01/02/03/04/06)
// Paso 1: servicios → ID_Servicio. Paso 2: detalle_servicios → todo el detalle operativo.
async function buscarFolioNOA(folio) {
  const ref = await query('servicios', {
    pagina: 1, limite: 1,
    filtros: { 'Folio de servicio': { contiene: folio } },
    campos: ['ID_Servicio','Folio de servicio'],
  });
  const id = ref?.datos?.[0]?.['ID_Servicio'];
  if (!id) return [];

  const r = await query('detalle_servicios', {
    pagina: 1, limite: 3,
    filtros: { 'ID_Servicio': { contiene: id } },
    campos: [
      'Folio de servicio','Fecha de Servicio','Cliente',
      // Origen
      'Nombre Remitente','Contacto Remitente','Telefono Remitente',
      'Cita de carga','Llegada a carga','Hora de salida carga',
      'Estado Origen','Cuidad Origen','Colonia Origen','Calle Origen',
      // Destino
      'Nombre Destinatario','Contacto Destinatario','Telefono Destinatario',
      'Cita de Descarga','Llegada a descarga','Hora de salida descarga','Hora estimada de llegada a destino',
      'Estado destino','Cuidad destino','Colonia destino','Calle destino',
      // Carga
      'Mercancias','Presentacion','Cantidad','Peso',
      // Unidad/Operador
      'Proveedor','Tractor','Tipo de tractor','Tipo de Permiso','Permiso SCT',
      'NIV Tractor','Remolque','Tipo remolque','NIV Remolque',
      'Operador','RFC','Licencia',
      // GPS
      'GPS','Usuario GPS','GPSOrigen','GPSdestino',
      // Planner
      'Planner','Telefono','Correo',
      // Instrucciones cliente
      'Comentarios CI','Carta de Instruccion',
      // Estatus monitoreo
      'Estatus Operaciones','EstatusMonitoreoDetalle','Comentarios Estatus Monitoreo',
      // Incidencias
      'Siniestro',
    ],
  });
  return r?.datos || [];
}

// Folios activos para el dashboard de NOA
// Valores reales de EstatusMonitoreoDetalle: "En tránsito", "En origen",
// "Unidad detenida", "Unidad en resguardo", "En destino", "Sin Información", "Servicio concluido"
const EXCLUIR_DETALLE = ['servicio concluido', 'cancelado'];

async function foliosActivosNOA() {
  const campos = [
    'Folio de servicio','Fecha de Servicio','Cliente',
    'Cuidad Origen','Estado Origen','Cuidad destino','Estado destino',
    'Cita de carga','Llegada a carga','Hora de salida carga',
    'Cita de Descarga','Llegada a descarga',
    'Proveedor','Operador','Tractor',
    'GPS','Usuario GPS',
    'EstatusMonitoreoDetalle','Comentarios Estatus Monitoreo',
    'Planner','Telefono','Correo',
  ];

  const r = await query('detalle_servicios', {
    pagina: 1, limite: 100,
    filtros: { 'Estatus Operaciones': { contiene: 'Proceso' } },
    campos,
  });

  const todos = r?.datos || [];

  // Excluir "Servicio concluido" — están en "4.En Proceso" en el TMS pero ya terminaron
  const activos = todos.filter(s => {
    const det = (s['EstatusMonitoreoDetalle'] || '').toLowerCase();
    return !EXCLUIR_DETALLE.some(ex => det.includes(ex));
  });

  // Deduplicar por folio — ante duplicados, priorizar el registro con info más específica
  const PRIORIDAD = ['en tránsito','unidad detenida','unidad en resguardo','en destino','en origen'];
  const unicos = {};
  for (const s of activos) {
    const f = s['Folio de servicio'];
    if (!f) continue;
    if (!unicos[f]) { unicos[f] = s; continue; }
    const detActual = (unicos[f]['EstatusMonitoreoDetalle'] || '').toLowerCase();
    const detNuevo  = (s['EstatusMonitoreoDetalle'] || '').toLowerCase();
    const priActual = PRIORIDAD.findIndex(p => detActual.includes(p));
    const priNuevo  = PRIORIDAD.findIndex(p => detNuevo.includes(p));
    if (priNuevo !== -1 && (priActual === -1 || priNuevo < priActual)) unicos[f] = s;
  }

  return Object.values(unicos).sort((a, b) =>
    (b['Fecha de Servicio'] || '').localeCompare(a['Fecha de Servicio'] || ''));
}

// Context builder para NOA
async function getContextoNOA(mensajeUsuario) {
  if (!ENABLED) return '';

  const msg = mensajeUsuario.toLowerCase();

  // Detectar folio explícito: patrón OP-ABS-YY-NNNN
  const folioMatch = mensajeUsuario.match(/OP-ABS-\d{2}-\d+/i);
  if (folioMatch) {
    const datos = await buscarFolioNOA(folioMatch[0].toUpperCase());
    if (datos.length) return '\n\n---\n[DATOS TMS MONITOREO — uso interno NOA]\n' + formatearFolioNOA(datos[0]) + '\n---\n';
  }

  // Detectar intención de entrega de turno o vista de todos los activos
  const esTurno   = /turno|activos|briefing|todos los folios|folios activos|resumen|arranque/.test(msg);
  if (esTurno) {
    const activos = await foliosActivosNOA();
    if (activos.length) return '\n\n---\n[DATOS TMS MONITOREO — uso interno NOA]\n' + formatearListaActivosNOA(activos) + '\n---\n';
  }

  // Detectar búsqueda de proveedor/transportista
  const esProveedor = /proveedor|transportista|operador|carrier/.test(msg);
  if (esProveedor) {
    const stopwords = new Set(['proveedor','transportista','operador','carrier','para','como','que','con','cual','cuales','este','esta']);
    const palabras = msg.split(/\s+/).filter(w => w.length > 4 && !stopwords.has(w)).slice(0, 2);
    for (const palabra of palabras) {
      const provs = await buscarProveedor(palabra);
      if (provs.length) {
        return '\n\n---\n[DATOS TMS MONITOREO — uso interno NOA]\n' + formatearProveedor(provs) + '\n---\n';
      }
    }
  }

  return '';
}

// ── Formateadores NOA ──────────────────────────────────────────────────────────
function fmt(v) { return v && String(v).trim() ? String(v).trim() : '—'; }
function fmtFecha(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toLocaleDateString('es-MX', { day:'2-digit', month:'2-digit', year:'numeric' })
    + ' ' + d.toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit', hour12: false });
}

function formatearFolioNOA(s) {
  const lineas = [
    `📋 FOLIO: ${fmt(s['Folio de servicio'])} | Fecha: ${fmtFecha(s['Fecha de Servicio'])} | Cliente: ${fmt(s['Cliente'])}`,
    '',
    `🗺️  RUTA: ${fmt(s['Cuidad Origen'])}, ${fmt(s['Estado Origen'])} → ${fmt(s['Cuidad destino'])}, ${fmt(s['Estado destino'])}`,
    `   Origen: ${fmt(s['Calle Origen'])} ${fmt(s['Colonia Origen'])} | Destino: ${fmt(s['Calle destino'])} ${fmt(s['Colonia destino'])}`,
    `   📍 Mapa Origen: ${fmt(s['GPSOrigen'])} | Mapa Destino: ${fmt(s['GPSdestino'])}`,
    '',
    `⏱️  TIEMPOS DE CARGA:`,
    `   Cita carga: ${fmtFecha(s['Cita de carga'])} | Llegada: ${fmt(s['Llegada a carga'])} | Salida: ${fmt(s['Hora de salida carga'])}`,
    `⏱️  TIEMPOS DE DESCARGA:`,
    `   Cita descarga: ${fmtFecha(s['Cita de Descarga'])} | ETA: ${fmtFecha(s['Hora estimada de llegada a destino'])} | Llegada: ${fmt(s['Llegada a descarga'])} | Salida: ${fmt(s['Hora de salida descarga'])}`,
    '',
    `📦 MERCANCÍA: ${fmt(s['Mercancias'])} | ${fmt(s['Presentacion'])} x ${fmt(s['Cantidad'])} | Peso: ${fmt(s['Peso'])}`,
    '',
    `🚛 UNIDAD:`,
    `   Proveedor: ${fmt(s['Proveedor'])}`,
    `   Tractor: ${fmt(s['Tractor'])} (${fmt(s['Tipo de tractor'])}) | NIV: ${fmt(s['NIV Tractor'])}`,
    `   Remolque: ${fmt(s['Remolque'])} (${fmt(s['Tipo remolque'])}) | NIV: ${fmt(s['NIV Remolque'])}`,
    `   Permiso SCT: ${fmt(s['Permiso SCT'])} | Tipo: ${fmt(s['Tipo de Permiso'])}`,
    `   GPS: ${fmt(s['GPS'])} | Usuario GPS: ${fmt(s['Usuario GPS'])}`,
    '',
    `👤 OPERADOR: ${fmt(s['Operador'])} | RFC: ${fmt(s['RFC'])} | Licencia: ${fmt(s['Licencia'])}`,
    '',
    `📞 CONTACTOS:`,
    `   Remitente: ${fmt(s['Nombre Remitente'])} — ${fmt(s['Contacto Remitente'])} — ${fmt(s['Telefono Remitente'])}`,
    `   Destinatario: ${fmt(s['Nombre Destinatario'])} — ${fmt(s['Contacto Destinatario'])} — ${fmt(s['Telefono Destinatario'])}`,
    `   Planner: ${fmt(s['Planner'])} — ${fmt(s['Correo'])} — Tel: ${fmt(s['Telefono'])}`,
    '',
    `📊 ESTATUS MONITOREO: ${fmt(s['EstatusMonitoreoDetalle'])} | ${fmt(s['Comentarios Estatus Monitoreo'])}`,
    s['Siniestro'] ? `🚨 SINIESTRO: ${fmt(s['Siniestro'])}` : '',
    s['Estatus Acuses'] === false ? '⚠️  Acuse: pendiente de recibir' : '',
    '',
    `📝 INSTRUCCIONES DEL CLIENTE (Carta de Instrucción):`,
    `${fmt(s['Comentarios CI'])}`,
  ];
  return lineas.filter(l => l !== null).join('\n');
}

function formatearListaActivosNOA(activos) {
  const lineas = [`FOLIOS ACTIVOS (${activos.length} en total) — ENTREGA DE TURNO:\n`];
  for (const s of activos) {
    const ruta = `${fmt(s['Cuidad Origen'])} → ${fmt(s['Cuidad destino'])}`;
    const citaDes = s['Cita de Descarga'] ? fmtFecha(s['Cita de Descarga']) : '—';
    const salio   = s['Hora de salida carga'] ? '✅ En tránsito' : (s['Llegada a carga'] ? '🔄 En carga' : '🕐 Sin arrancar');
    const llego   = s['Llegada a descarga'] ? '✅ Entregado' : '';
    lineas.push(
      `• ${fmt(s['Folio de servicio'])} | ${fmt(s['Cliente'])} | ${ruta}`,
      `  Estatus: ${fmt(s['EstatusMonitoreoDetalle'])} ${salio} ${llego}`,
      `  Cita descarga: ${citaDes} | Operador: ${fmt(s['Operador'])} | Unidad: ${fmt(s['Tractor'])}`,
      `  GPS: ${fmt(s['GPS'])} (${fmt(s['Usuario GPS'])})`,
      s['Comentarios Estatus Monitoreo'] ? `  Nota: ${fmt(s['Comentarios Estatus Monitoreo'])}` : '',
      '',
    );
  }
  return lineas.join('\n');
}

module.exports = {
  // SARA
  buscarCliente, historialCliente, rutasPrincipales, tarifasCliente, directorio, getContextoSARA,
  // SOFIA
  buscarProveedor, rutasProveedor, proveedoresPorRuta, getContextoSOFIA,
  // NOA
  buscarFolioNOA, foliosActivosNOA, getContextoNOA,
  // Core
  query, ENABLED,
};
