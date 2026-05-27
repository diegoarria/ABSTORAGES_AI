// ── ordersStore — Almacén en memoria de órdenes cerradas por SARA ─────────────
// Cuando SARA cierra una venta genera NUEVA_ORDEN con los 13 campos.
// Este store los guarda indexados por folio para que SOFIA los consulte
// inmediatamente sin volver a preguntar nada al cliente.

const store = new Map(); // ABST-XXXXXX → datos completos

function guardarOrden(datos) {
  if (!datos?.folio) return;
  const folio = normalizarFolio(datos.folio);
  store.set(folio, { ...datos, folio, guardado: new Date().toISOString() });
  console.log(`[OrdersStore] Orden guardada: ${folio}`);
}

// Busca un folio en cualquier texto — soporta múltiples formatos:
//   ABST-123456  |  ABST 123456  |  abst123456  |  folio 123456  |  #123456
function obtenerOrden(texto) {
  if (!texto) return null;
  const folio = extraerFolio(texto);
  if (!folio) return null;
  return store.get(folio) || null;
}

// Busca directamente por folio normalizado
function obtenerOrdenPorFolio(folio) {
  if (!folio) return null;
  return store.get(normalizarFolio(folio)) || null;
}

// Devuelve el folio normalizado si se detecta en el texto, o null
function extraerFolio(texto) {
  if (!texto) return null;
  const t = String(texto);

  // 1. Formato canónico ABST-XXXXXX
  const m1 = t.match(/ABST[-\s]?(\d{6})/i);
  if (m1) return `ABST-${m1[1]}`;

  // 2. Solo los 6 dígitos precedidos por "folio", "#", "número" o similar
  const m2 = t.match(/(?:folio|#|número|n[uú]mero)[:\s]*(\d{6})/i);
  if (m2) return `ABST-${m2[1]}`;

  // 3. 6 dígitos standalone que existan en el store (validación extra)
  const m3 = t.match(/\b(\d{6})\b/);
  if (m3) {
    const candidato = `ABST-${m3[1]}`;
    if (store.has(candidato)) return candidato;
  }

  return null;
}

function normalizarFolio(folio) {
  const digits = String(folio).match(/\d{6}/);
  return digits ? `ABST-${digits[0]}` : String(folio).toUpperCase().trim();
}

function listarOrdenes() {
  return Array.from(store.values());
}

module.exports = { guardarOrden, obtenerOrden, obtenerOrdenPorFolio, extraerFolio, listarOrdenes };
