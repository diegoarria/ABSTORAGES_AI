// ── SOFIA — ronda diaria de disponibilidad a proveedores ─────────────────────
// Cada mañana (a partir de SOFIA_DISPONIBILIDAD_HORA), revisa en el TMS qué
// folios de los próximos SOFIA_DISPONIBILIDAD_VENTANA_HORAS todavía no tienen
// proveedor asignado, y le pregunta disponibilidad — por la plantilla
// aprobada de WhatsApp (whatsappProactivo.preguntarDisponibilidadATodos) —
// solo a los proveedores compatibles con esa ruta real. Nunca manda un
// mensaje genérico sin una carga real detrás.
//
// Apagado por default — requiere SOFIA_DISPONIBILIDAD_DIARIA=true en el
// entorno, mismo criterio que noaScheduler.js (NOA_AUTOLLAMADAS): son
// mensajes reales y recurrentes a personas reales, no se activan solos.
const tms             = require('./tms');
const vapi             = require('./vapi');
const whatsappProactivo = require('./whatsappProactivo');
const agentPause        = require('./agentPause');

const HABILITADO     = process.env.SOFIA_DISPONIBILIDAD_DIARIA === 'true';
const HORA_ENVIO      = Number(process.env.SOFIA_DISPONIBILIDAD_HORA || 8); // 8am hora Monterrey
const VENTANA_HORAS   = Number(process.env.SOFIA_DISPONIBILIDAD_VENTANA_HORAS || 72);
const CHEQUEO_MS      = 15 * 60 * 1000; // revisa cada 15 min si ya toca correr hoy

// ── Piloto acotado (Semana 2 del roadmap) — lista blanca de teléfonos de
// proveedores de confianza. Mientras esta ronda automática siga siendo el
// mecanismo que causó el incidente del 16-22 sept, NUNCA debe tocar a "todos
// los proveedores compatibles" por default — solo a quien esté aquí,
// explícitamente, a propósito. Últimos 10 dígitos, separados por coma.
const PILOTO_TELEFONOS = new Set(
  (process.env.SOFIA_PILOTO_PROVEEDORES || '')
    .split(',')
    .map(t => t.replace(/\D/g, '').slice(-10))
    .filter(Boolean)
);

let ultimaFechaEnviada = null; // 'YYYY-MM-DD' en hora de Monterrey — evita doble ronda el mismo día

function horaYFechaMTY() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Monterrey', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  });
  const partes = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return { fecha: `${partes.year}-${partes.month}-${partes.day}`, hora: Number(partes.hour) };
}

async function correrSiToca(pushActividad) {
  if (!HABILITADO) return;
  if (agentPause.estaPausado('sofia')) {
    console.log('[SOFIA scheduler] SOFIA pausada — se omite la ronda diaria de hoy');
    return;
  }
  if (!PILOTO_TELEFONOS.size) {
    console.warn('[SOFIA scheduler] SOFIA_PILOTO_PROVEEDORES no configurada — por seguridad, esta ronda NUNCA corre "a todos" por default. Configúrala con los teléfonos del piloto para activarla.');
    return;
  }
  if (!tms.ENABLED) return;

  const { fecha, hora } = horaYFechaMTY();
  if (hora < HORA_ENVIO) return;
  if (ultimaFechaEnviada === fecha) return; // ya corrió hoy

  ultimaFechaEnviada = fecha; // marcar antes de correr — evita reintentos duplicados si algo falla a medias

  let folios;
  try {
    folios = await tms.foliosPorAsignar(VENTANA_HORAS);
  } catch (e) {
    console.error('[SOFIA scheduler] Error obteniendo folios por asignar:', e.message);
    return;
  }

  if (!folios.length) {
    console.log('[SOFIA scheduler] Sin folios pendientes de proveedor hoy — no se manda nada');
    pushActividad?.({ agente: 'SOFIA', tipo: 'DISPONIBILIDAD_DIARIA', mensaje: 'Ronda diaria: sin folios pendientes de proveedor, no se contactó a nadie' });
    return;
  }

  let proveedoresReales;
  try {
    proveedoresReales = await tms.proveedoresParaVapi();
  } catch (e) {
    console.error('[SOFIA scheduler] Error obteniendo proveedores del TMS:', e.message);
    return;
  }

  // Piloto acotado — nunca contactar a nadie fuera de la lista blanca,
  // aunque sea "compatible" con la ruta. Ver PILOTO_TELEFONOS arriba.
  const antesDelFiltro = proveedoresReales.length;
  proveedoresReales = proveedoresReales.filter(p => PILOTO_TELEFONOS.has((p.telefono || '').replace(/\D/g, '').slice(-10)));
  console.log(`[SOFIA scheduler] Piloto: ${proveedoresReales.length}/${antesDelFiltro} proveedores reales están en la lista blanca del piloto`);
  if (!proveedoresReales.length) {
    pushActividad?.({ agente: 'SOFIA', tipo: 'DISPONIBILIDAD_DIARIA', mensaje: 'Ronda diaria: ningún proveedor real coincide con la lista blanca del piloto — no se contactó a nadie' });
    return;
  }

  console.log(`[SOFIA scheduler] Ronda diaria — ${folios.length} folio(s) sin proveedor en las próximas ${VENTANA_HORAS}h`);

  for (const f of folios) {
    const folio = f['Folio de servicio'];
    if (!folio) continue;

    const origen  = f['Cuidad Origen']  || f['Estado Origen']  || '—';
    const destino = f['Cuidad destino'] || f['Estado destino'] || '—';
    const orden = {
      folio,
      empresa: f['Cliente'],
      ruta: `${origen} → ${destino}`,
      tipo_unidad: f['Tipo remolque'] || 'caja seca',
      fecha_carga: f['Cita de carga'] ? new Date(f['Cita de carga']).toLocaleDateString('es-MX') : 'por confirmar',
    };

    const compatibles = vapi.filtrarProveedores(proveedoresReales, orden);
    if (!compatibles.length) {
      console.warn(`[SOFIA scheduler] Folio ${folio} — sin proveedores reales compatibles`);
      pushActividad?.({
        agente: 'SOFIA', tipo: 'SIN_UNIDAD',
        mensaje: `Ronda diaria: folio ${folio} (${origen} → ${destino}) sin proveedores reales compatibles`,
        metadata: { folio },
      });
      continue;
    }

    try {
      await whatsappProactivo.preguntarDisponibilidadATodos(compatibles, orden);
      pushActividad?.({
        agente: 'SOFIA', tipo: 'DISPONIBILIDAD_DIARIA',
        mensaje: `Ronda diaria: folio ${folio} (${origen} → ${destino}) — disponibilidad solicitada a ${compatibles.length} proveedor(es)`,
        metadata: { folio, proveedores: compatibles.length },
      });
    } catch (e) {
      console.error(`[SOFIA scheduler] Error preguntando disponibilidad — folio ${folio}:`, e.message);
    }
  }
}

function iniciar(pushActividad) {
  if (!HABILITADO) {
    console.log('[SOFIA scheduler] Desactivado (SOFIA_DISPONIBILIDAD_DIARIA != "true")');
    return;
  }
  console.log(`[SOFIA scheduler] Activo — ronda diaria a partir de las ${HORA_ENVIO}:00 (hora Monterrey), ventana de ${VENTANA_HORAS}h`);
  setInterval(() => correrSiToca(pushActividad), CHEQUEO_MS);
  correrSiToca(pushActividad); // por si el servidor arranca después de la hora de envío de hoy
}

module.exports = { iniciar };
