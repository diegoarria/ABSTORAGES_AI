// ── Despachador de proveedores de GPS soportados ────────────────────────────
// Cada proveedor expone { esUrl(url), obtenerUbicacion(url, opts) } — este
// módulo detecta cuál corresponde según el link guardado en el TMS y delega.
const wialon = require('./wialon');
const holkan = require('./holkan');
const protrack365 = require('./protrack365');

const PROVEEDORES = [wialon, holkan, protrack365];

function esUrlSoportada(url) {
  return PROVEEDORES.some(p => p.esUrl(url));
}

async function obtenerUbicacion(url, opts) {
  const proveedor = PROVEEDORES.find(p => p.esUrl(url));
  if (!proveedor) return null;
  return proveedor.obtenerUbicacion(url, opts);
}

// Fallback para folios SIN link de GPS propio: si hay una cuenta espejo de
// Wialon configurada (WIALON_MIRROR_TOKEN), busca la unidad por nombre/placas
// dentro de esa flota en vez de depender de que el proveedor comparta un
// link por viaje. null si no hay cuenta espejo o no se encuentra la unidad.
async function obtenerUbicacionPorNombre(nombre, opts) {
  if (!wialon.MIRROR_ACTIVO) return null;
  return wialon.obtenerUbicacionPorNombre(nombre, opts);
}

module.exports = { esUrlSoportada, obtenerUbicacion, obtenerUbicacionPorNombre };
