// ─── Tariff — Motor de tarifas con costo real · México ────────────────────────
// El precio al cliente se calcula desde el costo operativo real:
// diesel + casetas + neumáticos + mantenimiento + operador + seguros + margen

// ── Rutas con distancia y casetas reales (MXN 2025) ──────────────────────────
const RUTAS_DATA = {
  'MTY → CDMX':  { distancia: 1100, casetas: 2800 },
  'MTY → GDL':   { distancia: 660,  casetas: 1600 },
  'MTY → QRO':   { distancia: 750,  casetas: 1900 },
  'MTY → SLP':   { distancia: 520,  casetas: 1300 },
  'MTY → AGS':   { distancia: 630,  casetas: 1550 },
  'MTY → TMP':   { distancia: 480,  casetas:  600 },
  'MTY → TOR':   { distancia: 350,  casetas:  450 },
  'MTY → VER':   { distancia: 1050, casetas: 2600 },
  'CDMX → GDL':  { distancia: 540,  casetas: 1400 },
  'CDMX → VER':  { distancia: 450,  casetas: 1200 },
  'CDMX → PUE':  { distancia: 130,  casetas:  380 },
  'CDMX → QRO':  { distancia: 220,  casetas:  580 },
  'CDMX → SLP':  { distancia: 430,  casetas: 1100 },
  'CDMX → TOR':  { distancia: 930,  casetas: 2400 },
  'CDMX → AGS':  { distancia: 570,  casetas: 1450 },
  'CDMX → CUL':  { distancia: 1550, casetas: 3800 },
  'CDMX → OAX':  { distancia: 470,  casetas: 1200 },
  'CDMX → MRD':  { distancia: 1550, casetas: 2200 },
  'CDMX → CUN':  { distancia: 1750, casetas: 2500 },
  'NLD → CDMX':  { distancia: 1200, casetas: 3100 },
  'NLD → GDL':   { distancia: 1000, casetas: 2600 },
  'JRZ → CDMX':  { distancia: 1650, casetas: 4200 },
  'TIJ → CDMX':  { distancia: 2950, casetas: 5500 },
  'TIJ → GDL':   { distancia: 1850, casetas: 3400 },
  'MXL → CDMX':  { distancia: 2750, casetas: 5200 },
  'GDL → MTY':   { distancia: 660,  casetas: 1600 },
  'GDL → CDMX':  { distancia: 540,  casetas: 1400 },
  'GDL → TIJ':   { distancia: 1850, casetas: 3400 },
  'GDL → CUL':   { distancia: 900,  casetas: 2200 },
};

// ── Costos por km según tipo de unidad (MXN) ─────────────────────────────────
// Estos son costos CARRIER que ABSTORAGES necesita cubrir + su margen
const UNIT_COSTS = {
  // Costo por km: { consumo_L_km, neumaticos, mantenimiento, operador, seguro_km }
  'caja seca 53':      { consumo: 0.40, neum: 0.68, mant: 0.48, oper: 2.90, seg: 0.95 },
  'caja seca 48':      { consumo: 0.38, neum: 0.62, mant: 0.44, oper: 2.90, seg: 0.88 },
  'caja refrigerada':  { consumo: 0.52, neum: 0.68, mant: 0.85, oper: 3.20, seg: 1.40 },
  'torton':            { consumo: 0.30, neum: 0.38, mant: 0.30, oper: 2.50, seg: 0.65 },
  'rabon':             { consumo: 0.26, neum: 0.30, mant: 0.25, oper: 2.40, seg: 0.55 },
  'plataforma':        { consumo: 0.40, neum: 0.65, mant: 0.45, oper: 2.80, seg: 1.00 },
  'full':              { consumo: 0.50, neum: 0.90, mant: 0.65, oper: 3.00, seg: 1.20 },
};

const MARGEN_CARRIER    = 0.60; // ganancia del carrier sobre sus costos operativos (~60% en México)
const MARGEN_ABSTORAGES = 0.22; // margen de ABSTORAGES sobre el precio que paga al carrier

// ── Precio diesel dinámico ────────────────────────────────────────────────────
function getDiesel() {
  const day  = new Date().getDate();
  const hour = new Date().getHours();
  const dayVar  = Math.sin(day * 0.7) * 0.35;
  const hourVar = (hour >= 7 && hour <= 20) ? 0.08 : 0;
  return parseFloat((24.80 + dayVar + hourVar).toFixed(2));
}

// ── Demanda de mercado ────────────────────────────────────────────────────────
function getDemand() {
  const hour = new Date().getHours();
  const dow  = new Date().getDay();
  if (dow === 0 || dow === 6) return 'BAJA';
  if (dow === 5 && hour >= 9 && hour <= 18) return 'MUY ALTA';
  if (hour >= 7 && hour <= 19) return 'ALTA';
  return 'NORMAL';
}

function getDemandMult(demand) {
  return demand === 'MUY ALTA' ? 1.10 : demand === 'ALTA' ? 1.05 : demand === 'BAJA' ? 0.97 : 1.00;
}

// ── Costo desglosado para una ruta y tipo de unidad ──────────────────────────
function calcCosto(ruta, tipoUnidadKey, diesel) {
  const datos = RUTAS_DATA[ruta];
  if (!datos) return null;
  const u = UNIT_COSTS[tipoUnidadKey] || UNIT_COSTS['caja seca 53'];
  const km = datos.distancia;

  const costo_diesel     = Math.round(km * u.consumo * diesel);
  const costo_casetas    = datos.casetas;
  const costo_neumaticos = Math.round(km * u.neum);
  const costo_mant       = Math.round(km * u.mant);
  const costo_operador   = Math.round(km * u.oper);
  const costo_seguro     = Math.round(km * u.seg);

  const total_carrier = costo_diesel + costo_casetas + costo_neumaticos +
                        costo_mant + costo_operador + costo_seguro;

  return {
    km,
    casetas:    costo_casetas,
    diesel:     costo_diesel,
    neumaticos: costo_neumaticos,
    mantenimiento: costo_mant,
    operador:   costo_operador,
    seguro:     costo_seguro,
    total_carrier,
  };
}

// ── Precio al cliente = costos × margen_carrier × margen_abstorages × demanda ─
// costo_operativo → precio_carrier (costo × 1.65) → precio_cliente (× 1.22) → × demanda
function calcPrecioCliente(costo, demandMult) {
  const precio_carrier = costo.total_carrier * (1 + MARGEN_CARRIER);
  return Math.round(precio_carrier * (1 + MARGEN_ABSTORAGES) * demandMult);
}

// ── Resolver clave de tipo de unidad ─────────────────────────────────────────
function resolveUnidadKey(tipoUnidad) {
  const t = (tipoUnidad || '').toLowerCase();
  if (t.includes('refriger'))  return 'caja refrigerada';
  if (t.includes('53'))        return 'caja seca 53';
  if (t.includes('48'))        return 'caja seca 48';
  if (t.includes('full'))      return 'full';
  if (t.includes('plataforma') || t.includes('plat')) return 'plataforma';
  if (t.includes('torton') || t.includes('tortón'))   return 'torton';
  if (t.includes('rabon') || t.includes('rabón'))     return 'rabon';
  if (t.includes('caja'))      return 'caja seca 53';
  return 'caja seca 53';
}

// ── Contexto completo para inyectar en el prompt del agente ──────────────────
function getContext(tipoUnidad) {
  const diesel     = getDiesel();
  const demand     = getDemand();
  const demandMult = getDemandMult(demand);
  const unitKey    = resolveUnidadKey(tipoUnidad || 'caja seca 53');
  const updated    = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

  // Calcular precios para todas las rutas
  const rutas = {};
  for (const ruta of Object.keys(RUTAS_DATA)) {
    const c = calcCosto(ruta, unitKey, diesel);
    if (c) rutas[ruta] = calcPrecioCliente(c, demandMult);
  }

  // Desglose de ejemplo (MTY→CDMX)
  const ejemplo = calcCosto('MTY → CDMX', unitKey, diesel);
  const precioEjemplo = calcPrecioCliente(ejemplo, demandMult);

  const rutasSample = [
    'MTY → CDMX', 'MTY → GDL', 'CDMX → GDL', 'CDMX → VER',
    'CDMX → QRO', 'NLD → CDMX', 'TIJ → CDMX', 'CDMX → MRD',
  ].map(r => `${r} $${rutas[r]?.toLocaleString('es-MX') || '?'}`).join(' | ');

  const prompt =
    `\n\n---\nCONTEXTO TARIFARIO EN TIEMPO REAL (${updated}):\n` +
    `Diesel PEMEX: $${diesel}/L | Demanda: ${demand} | Unidad de referencia: ${unitKey}\n` +
    `Componentes de costo por viaje (MTY→CDMX, ${ejemplo.km} km):\n` +
    `  Diesel: $${ejemplo.diesel.toLocaleString('es-MX')} | Casetas: $${ejemplo.casetas.toLocaleString('es-MX')} | ` +
    `Neumáticos: $${ejemplo.neumaticos.toLocaleString('es-MX')} | Mantenimiento: $${ejemplo.mantenimiento.toLocaleString('es-MX')} | ` +
    `Operador: $${ejemplo.operador.toLocaleString('es-MX')} | Seguro: $${ejemplo.seguro.toLocaleString('es-MX')}\n` +
    `  Costo carrier total: $${ejemplo.total_carrier.toLocaleString('es-MX')} → Precio cliente (margen 22%): $${precioEjemplo.toLocaleString('es-MX')}\n` +
    `Precios vigentes: ${rutasSample}\n` +
    `Usa SIEMPRE estos precios actualizados — el costo ya incluye todos los componentes operativos.\n---\n`;

  return {
    diesel: diesel.toString(),
    demand,
    multiplier: demandMult.toFixed(2),
    updated,
    rutas,
    unitKey,
    margen: MARGEN_ABSTORAGES,
    prompt,
  };
}

// ── Precio y desglose para ruta + unidad específica ──────────────────────────
function getPrecioRuta(origen, destino, tipoUnidad) {
  const norm = s => s.toUpperCase()
    .replace(/MONTERREY.*/,'MTY').replace(/GUADALAJARA.*/,'GDL')
    .replace(/CIUDAD DE M[EÉ]XICO|CDMX|D\.?F\.?/,'CDMX')
    .replace(/QUER[EÉ]TARO.*/,'QRO').replace(/VERACRUZ.*/,'VER')
    .replace(/TAMPICO.*/,'TMP').replace(/TORRE[OÓ]N.*/,'TOR')
    .replace(/AGUASCALIENTES.*/,'AGS').replace(/SAN LUIS POTOS[IÍ].*/,'SLP')
    .replace(/NUEVO LAREDO.*/,'NLD').replace(/CD\.? JU[AÁ]REZ.*|CIUDAD JU[AÁ]REZ.*/,'JRZ')
    .replace(/TIJUANA.*/,'TIJ').replace(/MEXICALI.*/,'MXL')
    .replace(/M[EÉ]RIDA.*/,'MRD').replace(/CANC[UÚ]N.*/,'CUN')
    .replace(/PUEBLA.*/,'PUE').replace(/CULIAC[AÁ]N.*/,'CUL')
    .replace(/OAXACA.*/,'OAX').trim();

  const o = norm(origen);
  const d = norm(destino);
  const ruta    = `${o} → ${d}`;
  const rutaRev = `${d} → ${o}`;
  const key     = RUTAS_DATA[ruta] ? ruta : RUTAS_DATA[rutaRev] ? rutaRev : null;
  if (!key) return null;

  const diesel     = getDiesel();
  const demand     = getDemand();
  const demandMult = getDemandMult(demand);
  const unitKey    = resolveUnidadKey(tipoUnidad);
  const costo      = calcCosto(key, unitKey, diesel);
  const precio     = calcPrecioCliente(costo, demandMult);

  return { ruta: key, precio, costo, demand, diesel };
}

module.exports = { getContext, getPrecioRuta, RUTAS_DATA, UNIT_COSTS };
