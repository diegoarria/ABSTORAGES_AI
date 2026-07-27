// ── Memoria compartida cross-agente (SARA/SOFIA/NOA) — contactos + interacciones ─
// Solo se guarda un contacto cuando hay un cierre real (venta/acuerdo confirmado),
// nunca por un prospecto que no llegó a nada — ver los call sites en server-lite.js.
//
// Igual que ordersStore.js: cada función atrapa sus propios errores de Postgres
// y degrada a null/[] en vez de propagar la excepción (evita crash-loop si la
// base no responde).

const db = require('../db/db');

async function upsertContacto(datos) {
  if (!process.env.DATABASE_URL) {
    console.log('[Contactos] Sin DATABASE_URL, se omite:', datos.nombre_completo);
    return null;
  }
  try {
    const contacto = await db.upsertContacto(datos);
    console.log(`[Contactos] Upsert ${datos.agente} → ${contacto.nombre_completo} (${contacto.id})`);
    return contacto;
  } catch (e) {
    console.error('[Contactos] Error en upsert:', e.message);
    return null;
  }
}

async function listarPorAgente(agente, opts) {
  if (!process.env.DATABASE_URL) return [];
  try {
    return await db.listarContactosPorAgente(agente, opts);
  } catch (e) {
    console.error('[Contactos] Error listando:', e.message);
    return [];
  }
}

async function obtenerDetalle(id) {
  if (!process.env.DATABASE_URL) return null;
  try {
    return await db.obtenerContactoDetalle(id);
  } catch (e) {
    console.error('[Contactos] Error en detalle:', e.message);
    return null;
  }
}

module.exports = { upsertContacto, listarPorAgente, obtenerDetalle };
