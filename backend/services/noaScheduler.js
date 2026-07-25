// ── NOA — seguimiento automático por llamada de folios "en tránsito" ─────────
// Cada CHEQUEO_MS revisa los folios activos en el TMS; para los que están
// "En tránsito" y no se han llamado en las últimas INTERVALO_MS, dispara una
// llamada de estatus al proveedor/chofer y otra al cliente.
//
// Apagado por default — requiere NOA_AUTOLLAMADAS=true en el entorno, porque
// son llamadas reales y recurrentes con costo y a personas reales.

const tms  = require('./tms');
const vapi = require('./vapi');

const HABILITADO   = process.env.NOA_AUTOLLAMADAS === 'true';
const INTERVALO_MS = 90 * 60 * 1000; // 1.5 horas entre llamadas por folio
const CHEQUEO_MS   = 10 * 60 * 1000; // revisa cada 10 minutos si algún folio ya toca

const ultimaLlamada = new Map(); // folio → timestamp del último ciclo de llamadas

async function telefonoProveedor(nombreProveedor) {
  if (!nombreProveedor) return null;
  try {
    const resultados = await tms.buscarProveedor(nombreProveedor);
    const p = resultados?.[0];
    return p?.['Telefono_limpio']?.[0] || p?.['Telefono'] || p?.['Movil'] || null;
  } catch { return null; }
}

async function telefonoCliente(nombreCliente) {
  if (!nombreCliente) return null;
  try {
    const resultados = await tms.buscarCliente(nombreCliente);
    const c = resultados?.[0];
    return c?.['Telefono principal'] || c?.['Móvil principal'] || null;
  } catch { return null; }
}

async function revisarFolios(pushActividad) {
  if (!HABILITADO) return;
  if (!tms.ENABLED) return;

  let folios;
  try {
    folios = await tms.foliosActivosNOA();
  } catch (e) {
    console.error('[NOA scheduler] Error obteniendo folios activos:', e.message);
    return;
  }

  const enTransito = folios.filter(f =>
    (f['EstatusMonitoreoDetalle'] || '').toLowerCase().includes('en tránsito')
  );

  const ahora = Date.now();

  for (const f of enTransito) {
    const folio = f['Folio de servicio'];
    if (!folio) continue;

    const ultima = ultimaLlamada.get(folio) || 0;
    if (ahora - ultima < INTERVALO_MS) continue;

    ultimaLlamada.set(folio, ahora); // marcar antes de llamar, evita reintentos duplicados si algo falla

    const ruta = `${f['Cuidad Origen'] || f['Estado Origen'] || '?'} → ${f['Cuidad destino'] || f['Estado destino'] || '?'}`;

    const [telProveedor, telCliente] = await Promise.all([
      telefonoProveedor(f['Proveedor']),
      telefonoCliente(f['Cliente']),
    ]);

    try {
      const rChofer = await vapi.llamarStatusChofer({
        telefono: telProveedor, nombre: f['Proveedor'], folio, ruta,
      });
      pushActividad?.({
        agente: 'NOA', tipo: 'STATUS_CHOFER',
        mensaje: telProveedor
          ? `Llamada de estatus a ${f['Proveedor']} — folio ${folio}`
          : `Sin teléfono de proveedor para folio ${folio}, se omitió la llamada`,
        metadata: { folio, resultado: rChofer?.status || rChofer?.id },
      });
    } catch (e) {
      console.error(`[NOA scheduler] Error llamando chofer/proveedor folio ${folio}:`, e.message);
    }

    try {
      const rCliente = await vapi.llamarStatusCliente({
        telefono: telCliente, nombre: f['Cliente'], folio, ruta,
      });
      pushActividad?.({
        agente: 'NOA', tipo: 'STATUS_CLIENTE',
        mensaje: telCliente
          ? `Llamada de estatus a cliente ${f['Cliente']} — folio ${folio}`
          : `Sin teléfono de cliente para folio ${folio}, se omitió la llamada`,
        metadata: { folio, resultado: rCliente?.status || rCliente?.id },
      });
    } catch (e) {
      console.error(`[NOA scheduler] Error llamando cliente folio ${folio}:`, e.message);
    }
  }
}

function iniciar(pushActividad) {
  if (!HABILITADO) {
    console.log('[NOA scheduler] Desactivado (NOA_AUTOLLAMADAS != "true")');
    return;
  }
  console.log(`[NOA scheduler] Activo — chequeo cada ${CHEQUEO_MS / 60000} min, llamadas cada ${INTERVALO_MS / 60000} min por folio`);
  setInterval(() => revisarFolios(pushActividad), CHEQUEO_MS);
  revisarFolios(pushActividad); // primer chequeo inmediato al arrancar
}

module.exports = { iniciar };
