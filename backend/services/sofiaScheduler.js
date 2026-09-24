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
const notifier          = require('./notifier');
const contactos         = require('./contactos');

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
  const ult10 = t => (t || '').replace(/\D/g, '').slice(-10);
  proveedoresReales = proveedoresReales.filter(p => PILOTO_TELEFONOS.has(ult10(p.telefono)));

  // Proveedores guardados en la Base de Datos (no solo los del TMS) que estén
  // en la lista blanca — así un proveedor dado de alta ahí sí entra a la ronda.
  // Si la nota trae un trato específico ("Sr. Marco"), se usa como nombre en
  // el mensaje en vez del nombre completo.
  let desdeBD = [];
  try {
    const guardados = await contactos.listarPorAgente('SOFIA', { tipo: 'proveedor' });
    const yaEstan = new Set(proveedoresReales.map(p => ult10(p.telefono)));
    desdeBD = guardados
      .filter(c => PILOTO_TELEFONOS.has(ult10(c.telefono)) && !yaEstan.has(ult10(c.telefono)))
      .map(c => {
        const trato = (c.notas || '').match(/"(Sr\.?\s[^"]+)"/);
        return { id: c.id, nombre: trato ? trato[1] : c.nombre_completo, telefono: c.telefono, rutas: [], tipos_unidad: [], activo: true };
      });
  } catch (e) {
    console.error('[SOFIA scheduler] Error leyendo proveedores de la Base de Datos:', e.message);
  }
  proveedoresReales = proveedoresReales.concat(desdeBD);
  console.log(`[SOFIA scheduler] Piloto: ${proveedoresReales.length} proveedores en la lista blanca (${desdeBD.length} desde Base de Datos, ${proveedoresReales.length - desdeBD.length}/${antesDelFiltro} del TMS)`);
  if (!proveedoresReales.length) {
    pushActividad?.({ agente: 'SOFIA', tipo: 'DISPONIBILIDAD_DIARIA', mensaje: 'Ronda diaria: ningún proveedor real coincide con la lista blanca del piloto — no se contactó a nadie' });
    return;
  }

  console.log(`[SOFIA scheduler] Ronda diaria — ${folios.length} folio(s) sin proveedor en las próximas ${VENTANA_HORAS}h`);

  // Se acumula quién SÍ fue contactado de verdad (nunca lo pausado/omitido
  // por límite) para mandar el reporte por email al terminar la ronda —
  // así Diego y Rafael tienen registro exacto sin tener que estar viendo
  // el panel en el momento.
  const contactados = [];
  const enviosPorProveedor = {};
  const MAX_POR_PROVEEDOR = 2;

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

    // Se manda uno por uno (no con preguntarDisponibilidadATodos) para poder
    // saber exactamente a quién SÍ le llegó de verdad — necesario para el
    // reporte por email, y para no reportar como "contactado" a alguien que
    // en realidad se omitió por pausa o por límite diario.
    for (const p of compatibles) {
      // Tope por proveedor por ronda — con pocos proveedores en el piloto y
      // varios folios pendientes, sin esto una sola persona recibiría una
      // avalancha de mensajes la misma mañana.
      const k = ult10(p.telefono);
      if ((enviosPorProveedor[k] || 0) >= MAX_POR_PROVEEDOR) continue;
      enviosPorProveedor[k] = (enviosPorProveedor[k] || 0) + 1;
      try {
        const r = await whatsappProactivo.preguntarDisponibilidad(p, orden);
        const seOmitio = !r || ['paused', 'rate_limited', 'stub'].includes(r.status);
        if (!seOmitio) contactados.push({ folio, ruta: orden.ruta, proveedor: p.nombre, telefono: p.telefono });
      } catch (e) {
        console.error(`[SOFIA scheduler] Error preguntando disponibilidad a ${p.nombre} — folio ${folio}:`, e.message);
      }
    }

    pushActividad?.({
      agente: 'SOFIA', tipo: 'DISPONIBILIDAD_DIARIA',
      mensaje: `Ronda diaria: folio ${folio} (${origen} → ${destino}) — disponibilidad solicitada a ${compatibles.length} proveedor(es)`,
      metadata: { folio, proveedores: compatibles.length },
    });
  }

  if (contactados.length) {
    notifier.notificarRondaDisponibilidad(contactados, { fecha, foliosRevisados: folios.length }).catch(e =>
      console.error('[SOFIA scheduler] Error mandando el reporte por email de la ronda:', e.message));
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
