// ─── Tariff — Tarifario dinámico en tiempo real · México ──────────────────────
// Precios base en MXN para caja seca 53 pies (unidad estándar).
// Se aplican multiplicadores por diesel, demanda y día de semana.

const RUTAS_BASE = {
  // ── Norte → Centro ──────────────────────────────────────────────────────────
  'MTY → CDMX':    38500,
  'MTY → GDL':     22000,
  'MTY → QRO':     26000,
  'MTY → SLP':     18500,
  'MTY → AGS':     20000,
  'MTY → TMP':     16000,
  'MTY → TOR':     14500,
  'MTY → VER':     40000,
  // ── Centro ──────────────────────────────────────────────────────────────────
  'CDMX → GDL':    26000,
  'CDMX → VER':    16000,
  'CDMX → PUE':     7500,
  'CDMX → QRO':     9500,
  'CDMX → SLP':    18000,
  'CDMX → TOR':    32000,
  'CDMX → AGS':    24000,
  'CDMX → CUL':    44000,
  'CDMX → OAX':    20000,
  'CDMX → MRD':    48000,
  'CDMX → CUN':    54000,
  // ── Frontera ────────────────────────────────────────────────────────────────
  'NLD → CDMX':    45000,
  'NLD → GDL':     42000,
  'JRZ → CDMX':    52000,
  'TIJ → CDMX':    60000,
  'TIJ → GDL':     42000,
  'MXL → CDMX':    58000,
  // ── Occidente ───────────────────────────────────────────────────────────────
  'GDL → MTY':     22000,
  'GDL → CDMX':    26000,
  'GDL → TIJ':     38000,
  'GDL → CUL':     28000,
};

// Nombres completos para display
const CIUDAD_LABEL = {
  MTY: 'Monterrey', CDMX: 'CDMX', GDL: 'Guadalajara',
  QRO: 'Querétaro', SLP: 'S.L.P.', AGS: 'Aguascalientes',
  TMP: 'Tampico', TOR: 'Torreón', VER: 'Veracruz',
  PUE: 'Puebla', CUL: 'Culiacán', OAX: 'Oaxaca',
  MRD: 'Mérida', CUN: 'Cancún', NLD: 'Nuevo Laredo',
  JRZ: 'Cd. Juárez', TIJ: 'Tijuana', MXL: 'Mexicali',
};

// Multiplicadores por tipo de unidad (relativo a caja seca 53)
const UNIT_MULT = {
  'caja seca 53':       1.00,
  'caja seca 48':       0.95,
  'caja refrigerada':   1.28,
  'torton':             0.62,
  'rabon':              0.50,
  'plataforma':         1.05,
  'full':               1.55,
  'lowboy':             1.40,
};

// ── Precio del diesel PEMEX (simulado con variación diaria realista) ──────────
function getDiesel() {
  const day  = new Date().getDate();
  const hour = new Date().getHours();
  // Base $24.80 + variación diaria + pico horario
  const dayVar  = Math.sin(day * 0.7) * 0.35;
  const hourVar = (hour >= 7 && hour <= 20) ? 0.08 : 0;
  return (24.80 + dayVar + hourVar).toFixed(2);
}

// ── Demanda de mercado ────────────────────────────────────────────────────────
function getDemand() {
  const hour = new Date().getHours();
  const dow  = new Date().getDay(); // 0=dom, 5=vie, 6=sab
  if (dow === 0 || dow === 6) return 'BAJA';           // fin de semana
  if (dow === 5 && hour >= 9 && hour <= 18) return 'MUY ALTA';  // viernes hábil
  if (hour >= 7 && hour <= 19) return 'ALTA';
  return 'NORMAL';
}

// ── Multiplicador final ───────────────────────────────────────────────────────
function getMultiplier(diesel, demand) {
  const d   = parseFloat(diesel);
  let base  = d > 25.50 ? 1.18 : d > 25.00 ? 1.12 : d > 24.80 ? 1.06 : 1.00;
  const dem = demand === 'MUY ALTA' ? 0.12 : demand === 'ALTA' ? 0.06 : demand === 'BAJA' ? -0.05 : 0;
  return Math.min(1.50, base + dem).toFixed(2);
}

// ── Contexto completo ─────────────────────────────────────────────────────────
function getContext(tipoUnidad = 'caja seca 53') {
  const diesel  = getDiesel();
  const demand  = getDemand();
  const mult    = parseFloat(getMultiplier(diesel, demand));
  const unitKey = Object.keys(UNIT_MULT).find(k => tipoUnidad.toLowerCase().includes(k.split(' ')[0])) || 'caja seca 53';
  const unitMult = UNIT_MULT[unitKey] || 1.00;
  const updated = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

  // Aplicar multiplicadores
  const rutas = {};
  for (const [ruta, base] of Object.entries(RUTAS_BASE)) {
    rutas[ruta] = Math.round(base * mult * unitMult);
  }

  // Texto de contexto para inyectar en el prompt del agente
  const rutasSample = [
    'MTY → CDMX', 'MTY → GDL', 'CDMX → GDL', 'CDMX → VER',
    'CDMX → QRO', 'NLD → CDMX', 'TIJ → CDMX', 'CDMX → MRD',
  ].map(r => `${r} $${rutas[r]?.toLocaleString('es-MX') || '?'}`).join(' | ');

  const prompt =
    `\n\n---\nCONTEXTO TARIFARIO EN TIEMPO REAL (${updated}):\n` +
    `Diesel PEMEX: $${diesel}/L | Demanda: ${demand} | Multiplicador: x${mult.toFixed(2)}\n` +
    `Precios vigentes (${unitKey}): ${rutasSample}\n` +
    `Para rutas no listadas, extrapola proporcionalmente por distancia. ` +
    `Usa SIEMPRE estos precios actualizados — nunca inventes tarifas ni uses valores anteriores.\n---\n`;

  return { diesel, demand, multiplier: mult.toFixed(2), updated, rutas, unitMults: UNIT_MULT, prompt };
}

// ── Precio para una ruta y unidad específica ──────────────────────────────────
function getPrecioRuta(origen, destino, tipoUnidad = 'caja seca 53') {
  // Buscar match flexible (por ciudad abreviada o nombre completo)
  const norm = s => s.toUpperCase()
    .replace(/MONTERREY|MONTER/,'MTY').replace(/GUADALAJARA|GUADA/,'GDL')
    .replace(/CIUDAD DE M[EÉ]XICO|CDMX|D\.?F\.?/,'CDMX')
    .replace(/QUER[EÉ]TARO/,'QRO').replace(/VERACRUZ/,'VER')
    .replace(/TAMPICO/,'TMP').replace(/TORRE[OÓ]N/,'TOR')
    .replace(/AGUASCALIENTES/,'AGS').replace(/SAN LUIS POTOS[IÍ]/,'SLP')
    .replace(/NUEVO LAREDO/,'NLD').replace(/CD\.? JU[AÁ]REZ|CIUDAD JU[AÁ]REZ/,'JRZ')
    .replace(/TIJUANA/,'TIJ').replace(/MEXICALI/,'MXL')
    .replace(/M[EÉ]RIDA/,'MRD').replace(/CANC[UÚ]N/,'CUN')
    .replace(/PUEBLA/,'PUE').replace(/CULIAC[AÁ]N/,'CUL')
    .replace(/OAXACA/,'OAX').trim();

  const o = norm(origen);
  const d = norm(destino);
  const key = `${o} → ${d}`;
  const keyRev = `${d} → ${o}`;

  const ctx = getContext(tipoUnidad);
  return ctx.rutas[key] || ctx.rutas[keyRev] || null;
}

module.exports = { getContext, getPrecioRuta, RUTAS_BASE, UNIT_MULT, CIUDAD_LABEL };
