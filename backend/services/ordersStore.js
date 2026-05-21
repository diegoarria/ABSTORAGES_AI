// ── ordersStore — Almacén en memoria de órdenes cerradas por SARA ─────────────
// Cuando SARA cierra una venta genera NUEVA_ORDEN con los 13 campos.
// Este store los guarda indexados por folio para que SOFIA los consulte
// inmediatamente sin volver a preguntar nada al cliente.

const store = new Map();

function guardarOrden(datos) {
  if (!datos?.folio) return;
  const folio = datos.folio.toUpperCase().trim();
  store.set(folio, { ...datos, guardado: new Date().toISOString() });
  console.log(`[OrdersStore] Orden guardada: ${folio}`);
}

function obtenerOrden(texto) {
  if (!texto) return null;
  // Buscar patrón ABST-XXXXXX en el texto recibido
  const match = texto.match(/ABST-\d{6}/i);
  if (!match) return null;
  return store.get(match[0].toUpperCase()) || null;
}

function listarOrdenes() {
  return Array.from(store.values());
}

module.exports = { guardarOrden, obtenerOrden, listarOrdenes };
