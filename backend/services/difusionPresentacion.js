// ─── Difusión única de presentación — SOFIA se presenta como asistente del
// planner a los proveedores que ya tienen uno asignado ─────────────────────
// Pedido explícito del usuario (04-nov-2026): un envío ÚNICO (no diario, no
// recurrente) de la plantilla "presentacion_sofia_planner" (ya aprobada por
// Meta) a los 78 proveedores con planner humano asignado (Abigail/Gabriel/
// Claudia/Yamilet) — NO a los 21 que SOFIA maneja en su propia cuenta,
// porque a ellos no les aplica "voy a ser la asistente de [planner]".
//
// Usa enviarPlantilla() (CON candado "yaSeEnvio") a propósito, no
// enviarPlantillaSinCandado() como difusionAsignados.js — esta plantilla es
// de presentación, debe mandarse una sola vez por proveedor para siempre;
// si se vuelve a disparar por error, el candado la bloquea sola sin volver
// a escribirle a quien ya se presentó.
const contactos = require('./contactos');
const whatsappProactivo = require('./whatsappProactivo');
const actividadBus = require('./actividadBus');
const notifier = require('./notifier');

const CONTENT_SID = process.env.KAPSO_TEMPLATE_PRESENTACION_PLANNER || 'presentacion_sofia_planner';

const titulo = s => String(s || '').trim().split(/\s+/)[0].toLowerCase().replace(/^./, c => c.toUpperCase());
const feed = e => actividadBus.emitir({ agente: 'SOFIA', ...e });

// Los mismos 78 de difusionAsignados.js pero excluyendo explícitamente a
// los que SOFIA maneja directo (planner_asignado === 'SOFIA').
async function proveedoresConPlannerHumano() {
  const bd = await contactos.listarPorAgente('SOFIA', { tipo: 'proveedor' });
  return bd
    .filter(c => c.telefono && c.planner_asignado && c.planner_asignado !== 'SOFIA' && !/Estatus en catálogo: (Baja|Suspendido)/i.test(c.notas || ''))
    .map(c => ({ id: c.id, nombre: c.nombre_completo, empresa: c.empresa, telefono: c.telefono, planner: c.planner_asignado }));
}

async function dispararManual() {
  let lista;
  try { lista = await proveedoresConPlannerHumano(); } catch (e) { console.error('[difusionPresentacion] Error armando la lista:', e.message); return { ok: false, motivo: 'error_lista' }; }
  if (!lista.length) return { ok: true, enviados: 0, total: 0, resumen: 'No hay proveedores con planner humano asignado.' };

  feed({ tipo: 'DIFUSION_PRESENTACION', mensaje: `Difusión de presentación de planner — empezando con ${lista.length} proveedores, uno tras otro` });

  let enviados = 0, duplicados = 0, sinCredito = 0, fallidos = 0;
  const detalle = [];
  for (const p of lista) {
    try {
      const nombre = titulo(p.nombre);
      const variables = { '1': nombre, '2': p.planner };
      const textoEnviado = `¡Hola ${nombre}! Soy SOFIA, de ABSTORAGES. Te escribo para presentarme, a partir de ahora voy a ser la asistente de ${p.planner}, y juntos vamos a coordinar contigo tus cargas y preguntarte disponibilidad de unidades.\n\nCualquier duda sobre rutas o un servicio en curso, escríbeme directo por aquí.`;
      const r = await whatsappProactivo.enviarPlantilla('sofia', p.telefono, CONTENT_SID, variables);
      if (r?.status === 'rate_limited') { sinCredito = lista.length - enviados - duplicados - fallidos; detalle.push({ ...p, status: 'rate_limited' }); break; }
      if (r?.status === 'paused') { detalle.push({ ...p, status: 'paused' }); break; }
      if (r?.status === 'ya_contactado_hoy' || r?.status === 'baneado') { detalle.push({ ...p, status: r.status }); continue; }
      if (r?.status === 'duplicado') { duplicados++; detalle.push({ ...p, status: 'duplicado' }); continue; }
      enviados++;
      detalle.push({ ...p, status: 'ok' });
      whatsappProactivo.registrarEnMemoria?.('sofia', p.telefono, textoEnviado);
      contactos.upsertContacto({ agente: 'sofia', telefono: p.telefono, resumen_interaccion: 'Presentación de SOFIA como asistente del planner', canal: 'whatsapp-plantilla' }).catch(() => {});
    } catch (e) { fallidos++; detalle.push({ ...p, status: 'error', error: e.message }); console.error(`[difusionPresentacion] Error mandando a ${p.nombre}:`, e.message); }
    await new Promise(res => setTimeout(res, 3000));
  }

  const resumen = `Difusión de presentación de planner: ${enviados} enviados de ${lista.length}${duplicados ? ` · ${duplicados} ya presentados antes (omitidos)` : ''}${sinCredito ? ` · ${sinCredito} sin enviar por tope diario` : ''}${fallidos ? ` · ${fallidos} con error` : ''}.`;
  feed({ tipo: 'DIFUSION_PRESENTACION', mensaje: resumen });
  notifier.notificarAlerta({ title: 'SOFIA — Difusión de presentación de planner', body: resumen, tipo: 'DIFUSION_PRESENTACION' }).catch(() => {});
  console.log(`[difusionPresentacion] ${resumen}`);
  return { ok: true, enviados, total: lista.length, duplicados, sinCredito, fallidos, resumen, detalle };
}

module.exports = { dispararManual, proveedoresConPlannerHumano };
