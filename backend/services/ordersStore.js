// ── ordersStore — Órdenes cerradas por SARA ───────────────────────────────────
// Cuando SARA cierra una venta genera NUEVA_ORDEN con los 13 campos.
// Este store los guarda indexados por folio para que SOFIA los consulte
// inmediatamente sin volver a preguntar nada al cliente.
//
// Con DATABASE_URL configurada, persiste en Postgres (tablas clientes/folios
// de backend/db/schema.sql) — sobrevive redeploys. Sin DATABASE_URL, cae al
// Map() en memoria de siempre (para poder correr local sin Postgres).

const db = require('../db/db');
const USA_DB = !!process.env.DATABASE_URL;

const store = new Map(); // fallback en memoria — ABST-XXXXXX → datos completos

// Busca un folio en cualquier texto — soporta múltiples formatos:
//   ABST-123456  |  ABST 123456  |  abst123456  |  folio 123456  |  #123456
function extraerFolio(texto) {
  if (!texto) return null;
  const t = String(texto);

  const m1 = t.match(/ABST[-\s]?(\d{6})/i);
  if (m1) return `ABST-${m1[1]}`;

  const m2 = t.match(/(?:folio|#|número|n[uú]mero)[:\s]*(\d{6})/i);
  if (m2) return `ABST-${m2[1]}`;

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

// Mapea el shape de leads.js (nombre, empresa, rfc, telefono, email, origen,
// destino, tipo_carga, tipo_unidad, peso_toneladas, precio_cotizado, folio)
// a las columnas de clientes/folios.
function parsearPeso(peso) {
  const n = parseFloat(String(peso || '').replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

function parsearPrecio(precio) {
  const n = parseFloat(String(precio || '').replace(/[^\d.]/g, ''));
  return isNaN(n) ? null : n;
}

async function guardarOrden(datos) {
  if (!datos?.folio) return;
  const folio = normalizarFolio(datos.folio);

  if (USA_DB) {
    const cliente = await db.buscarOCrearCliente({
      razon_social: datos.empresa && datos.empresa !== '—' ? datos.empresa : datos.nombre,
      rfc: datos.rfc && datos.rfc !== '—' ? datos.rfc : null,
      telefono: datos.telefono && datos.telefono !== '—' ? datos.telefono : null,
      email: datos.email && datos.email !== '—' ? datos.email : null,
    });
    const guardado = await db.upsertFolio({
      folio,
      cliente_id: cliente.id,
      origen: datos.origen && datos.origen !== '—' ? datos.origen : null,
      destino: datos.destino && datos.destino !== '—' ? datos.destino : null,
      tipo_unidad: datos.tipo_unidad && datos.tipo_unidad !== '—' ? datos.tipo_unidad : null,
      mercancia: datos.tipo_carga && datos.tipo_carga !== '—' ? datos.tipo_carga : null,
      peso: parsearPeso(datos.peso_toneladas),
      fecha_carga: null, // SARA no siempre da fecha en formato parseable — se deja para captura manual
      precio_cliente: parsearPrecio(datos.precio_cotizado),
      condiciones_especiales: datos.requisitos && datos.requisitos !== '—' ? datos.requisitos : null,
    });
    console.log(`[OrdersStore] Orden guardada en Postgres: ${folio}`);
    return { ...datos, folio, cliente_id: cliente.id, guardado: guardado.updated_at || guardado.created_at };
  }

  store.set(folio, { ...datos, folio, guardado: new Date().toISOString() });
  console.log(`[OrdersStore] Orden guardada en memoria: ${folio}`);
}

async function obtenerOrden(texto) {
  if (!texto) return null;
  const folio = extraerFolio(texto);
  if (!folio) return null;
  return obtenerOrdenPorFolio(folio);
}

async function obtenerOrdenPorFolio(folio) {
  if (!folio) return null;
  const norm = normalizarFolio(folio);
  if (USA_DB) return db.obtenerFolioPorFolio(norm);
  return store.get(norm) || null;
}

async function listarOrdenes() {
  if (USA_DB) return db.obtenerFolioActivo();
  return Array.from(store.values());
}

module.exports = { guardarOrden, obtenerOrden, obtenerOrdenPorFolio, extraerFolio, listarOrdenes };
