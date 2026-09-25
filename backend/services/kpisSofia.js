// ── KPIs diarios de SOFIA — email a Diego y Rafael ───────────────────────────
// Estructura acordada con el usuario:
//   SOFIA NOVAK / Fecha / KPI's
//   1. Proveedores Alta en el mes: X/meta
//   2. Servicios Colocados del día: X/servicios del día
//   3. Total colocados en el mes: X/meta
// Definiciones:
//   - Alta: proveedor guardado en la Base de Datos de SOFIA este mes.
//   - Servicios del día: los que entraron a buscar unidad hoy + los colocados hoy.
//   - Colocado: servicio al que ya se le asignó proveedor (aprobado por una persona).
const colocaciones = require('./colocaciones');
const contactos = require('./contactos');
const notifier = require('./notifier');

const META_ALTAS = Number(process.env.KPI_META_PROVEEDORES_MES || 4);
const META_MES   = Number(process.env.KPI_META_COLOCADOS_MES || 40);
const HORA_ENVIO = Number(process.env.KPI_HORA || 19); // hora de Monterrey

async function calcular(fecha = colocaciones.fechaMTY()) {
  const mes = fecha.slice(0, 7);
  let altas = 0;
  try {
    const provs = await contactos.listarPorAgente('SOFIA', { tipo: 'proveedor' });
    altas = provs.filter(c => {
      const f = c.created_at || c.fecha_primer_contacto;
      return f && colocaciones.fechaMTY(f).slice(0, 7) === mes;
    }).length;
  } catch (e) { console.error('[kpisSofia] Error contando altas:', e.message); }
  const b = colocaciones.kpiBase(fecha);
  return { fecha, altas, metaAltas: META_ALTAS, colocadosHoy: b.colocadosHoy, serviciosDelDia: b.serviciosDelDia, colocadosMes: b.colocadosMes, metaMes: META_MES };
}

function texto(k) {
  const [y, m, d] = k.fecha.split('-');
  return [
    'SOFIA NOVAK',
    `Fecha: ${d}/${m}/${y}`,
    "KPI's",
    '',
    `1. Proveedores Alta en el mes: ${k.altas}/${k.metaAltas}`,
    `2. Servicios Colocados del día: ${k.colocadosHoy}/${k.serviciosDelDia}`,
    `3. Total colocados en el mes: ${k.colocadosMes}/${k.metaMes}`,
  ].join('\n');
}

async function vista() { const k = await calcular(); return { ...k, texto: texto(k) }; }

async function enviar() {
  const k = await calcular();
  const t = texto(k);
  const [y, m, d] = k.fecha.split('-');
  await notifier.notificarKPIsSofia({ asunto: `SOFIA NOVAK — KPI's ${d}/${m}/${y}`, texto: t });
  return { ...k, texto: t };
}

// Una vez al día, a partir de KPI_HORA (Monterrey). El último envío se guarda
// en disco para que un redeploy no lo repita ni lo salte.
async function tick() {
  const fecha = colocaciones.fechaMTY();
  const hora = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Monterrey', hour: '2-digit', hour12: false }).format(new Date())) % 24;
  if (hora < HORA_ENVIO || colocaciones.kpiMeta().ultimoEnvio === fecha) return;
  colocaciones.kpiGuardar({ ultimoEnvio: fecha }); // marcar antes: si algo falla no se reintenta en bucle
  try { await enviar(); console.log('[kpisSofia] KPIs del día enviados'); }
  catch (e) { console.error('[kpisSofia] Error enviando KPIs:', e.message); }
}

function iniciar() {
  setInterval(() => tick().catch(() => {}), 5 * 60 * 1000);
  console.log(`[kpisSofia] Activo — email diario a las ${HORA_ENVIO}:00 (Monterrey)`);
}

module.exports = { calcular, texto, vista, enviar, iniciar };
