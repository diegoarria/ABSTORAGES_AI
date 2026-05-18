// ─── Tariff — contexto de mercado en tiempo real (mock con lógica real) ────────

const RUTA_BASE = {
  'MTY → CDMX': 38000,
  'MTY → GDL':  22000,
  'CDMX → VER': 18000,
  'GDL → CDMX': 26000,
  'MTY → TMP':  19000,
  'CDMX → MTY': 38000,
};

function getDiesel() {
  // $24.80 MXN/L base + fluctuación diaria y horaria realista
  const day  = new Date().getDate();
  const hour = new Date().getHours();
  const dayVar  = (day % 7) * 0.09;
  const hourVar = hour < 8 || hour > 20 ? 0 : 0.08;
  return (24.80 + dayVar + hourVar).toFixed(2);
}

function getDemand() {
  const hour = new Date().getHours();
  const dow  = new Date().getDay(); // 0=dom, 5=vie
  if (dow === 5 && hour >= 6 && hour <= 18) return 'MUY ALTA';
  if (hour >= 7 && hour <= 19) return 'ALTA';
  return 'NORMAL';
}

function getMultiplier(diesel, demand) {
  const d   = parseFloat(diesel);
  const base = d > 25.50 ? 1.18 : d > 25.00 ? 1.12 : d > 24.80 ? 1.06 : 1.00;
  const dem  = demand === 'MUY ALTA' ? 0.10 : demand === 'ALTA' ? 0.05 : 0;
  return Math.min(1.45, base + dem).toFixed(2);
}

function getContext() {
  const diesel = getDiesel();
  const demand = getDemand();
  const mult   = parseFloat(getMultiplier(diesel, demand));
  const updated = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });

  const rutas = {};
  for (const [ruta, base] of Object.entries(RUTA_BASE)) {
    rutas[ruta] = Math.round(base * mult);
  }

  return {
    diesel,
    demand,
    multiplier: mult.toFixed(2),
    updated,
    rutas,
    prompt: `CONTEXTO TARIFARIO ACTUAL (${updated}): Diesel $${diesel}/L | Demanda de mercado: ${demand} | Multiplicador automático: x${mult.toFixed(2)} | Precios de referencia: MTY→CDMX $${rutas['MTY → CDMX'].toLocaleString()} | MTY→GDL $${rutas['MTY → GDL'].toLocaleString()} | CDMX→VER $${rutas['CDMX → VER'].toLocaleString()}. Siempre cotiza usando estos precios actualizados.`,
  };
}

module.exports = { getContext, RUTA_BASE };
