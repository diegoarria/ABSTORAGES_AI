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

const store = new Map(); // fallback en memoria — OP-ABS-YY-XXXX → datos completos

// Busca un folio en cualquier texto — formato real de ABSTORAGES (el mismo
// que usa el TMS): OP-ABS-YY-XXXX, ej. OP-ABS-26-4821. Se mantiene
// compatibilidad con el esquema interno viejo (ABST-XXXXXX) por si queda
// algún folio ya creado con ese formato antes del cambio.
function extraerFolio(texto) {
  if (!texto) return null;
  const t = String(texto);

  const m1 = t.match(/OP-ABS-(\d{2})[-\s]?(\d{3,4})/i);
  if (m1) return `OP-ABS-${m1[1]}-${m1[2].padStart(4, '0')}`;

  const legacy = t.match(/ABST[-\s]?(\d{6})/i);
  if (legacy) return `ABST-${legacy[1]}`;

  return null;
}

function normalizarFolio(folio) {
  const f = String(folio).trim();
  const m = f.match(/OP-ABS-(\d{2})[-\s]?(\d{3,4})/i);
  if (m) return `OP-ABS-${m[1]}-${m[2].padStart(4, '0')}`;
  const legacy = f.match(/\d{6}/);
  if (legacy) return `ABST-${legacy[0]}`; // compat con folios viejos ya guardados
  return f.toUpperCase();
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

// Todas las funciones que tocan Postgres atrapan sus propios errores — si la
// base no responde (o DATABASE_URL apunta a algo inalcanzable), degradamos a
// memoria/lista vacía en vez de dejar que el error tumbe el proceso completo.
async function guardarOrden(datos) {
  if (!datos?.folio) return;
  const folio = normalizarFolio(datos.folio);
  const enMemoria = () => {
    store.set(folio, { ...datos, folio, guardado: new Date().toISOString() });
    console.log(`[OrdersStore] Orden guardada en memoria: ${folio}`);
    return store.get(folio);
  };

  if (!USA_DB) return enMemoria();

  try {
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
  } catch (e) {
    console.error(`[OrdersStore] Postgres falló guardando ${folio}, cae a memoria:`, e.message);
    return enMemoria();
  }
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
  if (!USA_DB) return store.get(norm) || null;
  try {
    return await db.obtenerFolioPorFolio(norm);
  } catch (e) {
    console.error(`[OrdersStore] Postgres falló consultando ${norm}:`, e.message);
    return store.get(norm) || null;
  }
}

async function listarOrdenes() {
  if (!USA_DB) return Array.from(store.values());
  try {
    return await db.obtenerFolioActivo();
  } catch (e) {
    console.error('[OrdersStore] Postgres falló listando folios:', e.message);
    return Array.from(store.values());
  }
}

module.exports = { guardarOrden, obtenerOrden, obtenerOrdenPorFolio, extraerFolio, listarOrdenes };
