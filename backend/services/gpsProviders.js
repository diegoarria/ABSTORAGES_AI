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

module.exports = { esUrlSoportada, obtenerUbicacion };
