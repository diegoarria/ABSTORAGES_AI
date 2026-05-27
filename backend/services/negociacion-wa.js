// ── Negociación WhatsApp con transportistas ─────────────────────────────────
// State machine completo: SOFIA contacta a todos los carriers en paralelo,
// negocia con cada uno, el primero en aceptar dentro del margen gana,
// a los demás se les cierra de forma amistosa.

const { enviarMensaje } = require('./whatsapp');
const { chat } = require('./claude');
const { publicarActividad } = require('./redis');

// ── Constantes de negociación ─────────────────────────────────────────────────
const MARGEN_MINIMO   = 0.20; // no bajar del 20% de margen
const MAX_RONDAS      = 2;    // máximo de contraofertass antes de cerrar

// Estados posibles por carrier
const EST = {
  ENVIADO:      'ENVIADO',       // mensaje inicial enviado, esperando respuesta
  PIDIENDO_PRECIO: 'PIDIENDO_PRECIO', // confirmó disponibilidad, pedimos precio
  NEGOCIANDO:   'NEGOCIANDO',    // contrapropuesta enviada
  GANADOR:      'GANADOR',       // este carrier ganó
  CERRADO:      'CERRADO',       // descartado o rechazado amistosamente
};

// Store en memoria: negociaciones activas por folio
const negociaciones = new Map();
// Índice inverso: telefono → folio (para ruteo de respuestas entrantes)
const telefonoAFolio = new Map();

// ── Lanzar negociación para una orden ─────────────────────────────────────────
async function lanzarNegociacion(orden, todosProveedores) {
  if (!orden?.folio) return;

  const compatibles = filtrarProveedores(todosProveedores, orden);
  if (!compatibles.length) {
    console.warn(`[NegWA] Sin proveedores compatibles para ${orden.folio}`);
    return { ok: false, motivo: 'sin_proveedores' };
  }

  // Precio techo: cuánto podemos pagarle al carrier sin romper margen mínimo
  const precioCliente = parsePrecio(orden.precio_cliente) || estimarPrecioCliente(orden);
  const precioTecho   = Math.round(precioCliente * (1 - MARGEN_MINIMO));

  // Inicializar estado del folio
  const estado = {
    folio:          orden.folio,
    orden,
    precioCliente,
    precioTecho,
    ganador:        null,
    carriers:       {},       // { tel: { nombre, estado, rondas, precioOfertado } }
    inicio:         new Date().toISOString(),
  };
  negociaciones.set(orden.folio, estado);

  console.log(`[NegWA] Iniciando negociación ${orden.folio} — ${compatibles.length} carriers — techo $${precioTecho.toLocaleString()}`);

  // Enviar a todos en paralelo
  const envios = await Promise.allSettled(
    compatibles.map(p => iniciarConCarrier(estado, p))
  );

  const ok = envios.filter(r => r.status === 'fulfilled').length;
  publicarActividad('SOFIA', 'WA_NEGOCIACION_INICIADA',
    `${ok}/${compatibles.length} mensajes enviados — folio ${orden.folio} — techo $${precioTecho.toLocaleString()}`,
    { folio: orden.folio, carriers: compatibles.length }
  ).catch(() => {});

  return { ok: true, carriers: compatibles.length, enviados: ok, precioTecho };
}

async function iniciarConCarrier(estadoFolio, proveedor) {
  const tel = normalizarTel(proveedor.telefono);
  if (!tel) return;

  const { folio, orden } = estadoFolio;

  estadoFolio.carriers[tel] = {
    nombre:         proveedor.nombre,
    proveedorId:    proveedor.id || proveedor.nombre,
    estado:         EST.ENVIADO,
    rondas:         0,
    precioOfertado: null,
    historial:      [],
  };

  // Mapear teléfono → folio para rutear respuestas entrantes
  telefonoAFolio.set(tel, folio);

  const msg = mensajeInicial(orden, proveedor.nombre);
  estadoFolio.carriers[tel].historial.push({ rol: 'sofia', texto: msg, ts: new Date().toISOString() });

  await enviarMensaje(tel, msg);
  console.log(`[NegWA] → ${proveedor.nombre} (${tel})`);
}

// ── Procesar respuesta entrante de un carrier ─────────────────────────────────
async function procesarRespuesta(telefono, textoCarrier) {
  const tel   = normalizarTel(telefono);
  const folio = telefonoAFolio.get(tel);

  if (!folio) {
    console.log(`[NegWA] Mensaje de ${tel} sin folio activo — ignorado`);
    return null;
  }

  const estado   = negociaciones.get(folio);
  if (!estado)   return null;

  const carrier  = estado.carriers[tel];
  if (!carrier)  return null;

  // Si el folio ya tiene ganador y este carrier no es el ganador → cerrar
  if (estado.ganador && estado.ganador.tel !== tel) {
    if (carrier.estado !== EST.CERRADO) await cerrarCarrier(estado, tel, 'perdio');
    return null;
  }

  // Si ya está cerrado o ganó → ignorar
  if (carrier.estado === EST.CERRADO || carrier.estado === EST.GANADOR) return null;

  carrier.historial.push({ rol: 'carrier', texto: textoCarrier, ts: new Date().toISOString() });

  console.log(`[NegWA] ← ${carrier.nombre} (${folio}): "${textoCarrier.substring(0, 80)}"`);

  // Analizar respuesta con Claude
  const analisis = await analizarRespuesta(textoCarrier, carrier, estado);

  console.log(`[NegWA] Análisis ${carrier.nombre}: disponible=${analisis.disponible}, precio=${analisis.precio}, acepta=${analisis.acepta}`);

  publicarActividad('SOFIA', 'WA_RESPUESTA',
    `${carrier.nombre}: ${analisis.disponible ? (analisis.precio ? `$${analisis.precio.toLocaleString()}` : 'disponible (sin precio)') : 'no disponible'}`,
    { folio, tel, analisis }
  ).catch(() => {});

  return await manejarAnalisis(estado, tel, analisis);
}

// ── Analizar la respuesta del carrier con Claude ──────────────────────────────
async function analizarRespuesta(texto, carrier, estadoFolio) {
  const systemPrompt = `Eres un analizador de respuestas de transportistas.
Analiza el mensaje y responde SOLO con un JSON en una línea, sin explicación.

Campos del JSON:
- disponible: true/false — ¿el transportista dice que tiene disponibilidad?
- precio: número o null — precio que ofrece en pesos MXN (sin signos, solo número)
- acepta: true/false — ¿acepta explícitamente el precio propuesto?
- rechaza: true/false — ¿dice explícitamente que no tiene disponibilidad o no puede?
- contraoferta: número o null — si propone un precio diferente al que se le ofreció`;

  const messages = [{
    role: 'user',
    content: `Contexto: SOFIA ofreció $${(estadoFolio.precioTecho || 0).toLocaleString()} por un flete.
Ronda de negociación: ${carrier.rondas + 1}/${MAX_RONDAS}
Último mensaje de SOFIA: "${carrier.historial.filter(h => h.rol === 'sofia').slice(-1)[0]?.texto || ''}"
Respuesta del transportista: "${texto}"

JSON:`
  }];

  try {
    const raw = await chat(systemPrompt, messages);
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[NegWA] Error analizando respuesta:', e.message);
  }

  // Fallback heurístico
  const lower = texto.toLowerCase();
  const disponible = /s[ií]|puedo|tengo|cuento|claro|dale|va|perfecto/i.test(lower) &&
                     !/no tengo|no puedo|no cuento|no hay|ocupado|comprometido/i.test(lower);
  const rechaza    = /no tengo|no puedo|no cuento|no hay|ocupado|comprometido|no disponible/i.test(lower);
  const precioMatch = lower.match(/(\d[\d,.]*)\s*(?:mil|k|pesos|mxn)/i);
  let precio = null;
  if (precioMatch) {
    precio = parseFloat(precioMatch[1].replace(/,/g, ''));
    if (precio < 1000 && lower.includes('mil')) precio *= 1000;
  }

  return { disponible, precio, acepta: false, rechaza, contraoferta: precio };
}

// ── Manejar el resultado del análisis ────────────────────────────────────────
async function manejarAnalisis(estado, tel, analisis) {
  const carrier = estado.carriers[tel];
  const { disponible, precio, acepta, rechaza, contraoferta } = analisis;

  // 1. No disponible
  if (rechaza || (!disponible && !acepta)) {
    await cerrarCarrier(estado, tel, 'no_disponible');
    return null;
  }

  // 2. Acepta explícitamente el precio propuesto
  if (acepta && estado.ganador === null) {
    const precioFinal = carrier.precioOfertado || estado.precioTecho;
    return await declararGanador(estado, tel, precioFinal);
  }

  // 3. Tiene precio y está dentro del techo
  const precioEval = precio || contraoferta;
  if (precioEval && precioEval <= estado.precioTecho && estado.ganador === null) {
    return await declararGanador(estado, tel, precioEval);
  }

  // 4. Precio mayor al techo — contraoferta (si quedan rondas)
  if (precioEval && precioEval > estado.precioTecho) {
    carrier.precioOfertado = precioEval;
    carrier.rondas++;

    if (carrier.rondas <= MAX_RONDAS) {
      carrier.estado = EST.NEGOCIANDO;
      // Nuestra contraoferta: el techo (no cedemos más)
      const msg = mensajeContraoferta(carrier.nombre, estado.precioTecho, carrier.rondas);
      carrier.historial.push({ rol: 'sofia', texto: msg, ts: new Date().toISOString() });
      await enviarMensaje(tel, msg);
      publicarActividad('SOFIA', 'WA_CONTRAOFERTA',
        `${carrier.nombre}: ellos $${precioEval.toLocaleString()} → nuestra contra $${estado.precioTecho.toLocaleString()}`,
        { folio: estado.folio, tel }
      ).catch(() => {});
    } else {
      // Agotamos rondas de negociación
      await cerrarCarrier(estado, tel, 'precio_alto');
    }
    return null;
  }

  // 5. Disponible pero sin precio → pedirlo
  if (disponible && !precioEval && carrier.estado === EST.ENVIADO) {
    carrier.estado = EST.PIDIENDO_PRECIO;
    const msg = mensajePedirPrecio(carrier.nombre, estado.orden);
    carrier.historial.push({ rol: 'sofia', texto: msg, ts: new Date().toISOString() });
    await enviarMensaje(tel, msg);
  }

  return null;
}

// ── Declarar ganador ──────────────────────────────────────────────────────────
async function declararGanador(estado, tel, precioFinal) {
  if (estado.ganador) return null; // ya había uno
  const carrier = estado.carriers[tel];
  carrier.estado = EST.GANADOR;
  carrier.precioOfertado = precioFinal;

  estado.ganador = { tel, nombre: carrier.nombre, proveedorId: carrier.proveedorId, precioFinal };

  console.log(`[NegWA] ✅ GANADOR ${carrier.nombre} — $${precioFinal.toLocaleString()} — folio ${estado.folio}`);

  // Confirmar al ganador
  const msgGanador = mensajeGanador(carrier.nombre, estado.orden, precioFinal);
  carrier.historial.push({ rol: 'sofia', texto: msgGanador, ts: new Date().toISOString() });
  await enviarMensaje(tel, msgGanador);

  publicarActividad('SOFIA', 'WA_GANADOR',
    `🏆 ${carrier.nombre} — $${precioFinal.toLocaleString()} — folio ${estado.folio}`,
    { folio: estado.folio, ganador: estado.ganador }
  ).catch(() => {});

  // Cerrar amistosamente a todos los demás (sin bloquear)
  cerrarRestantes(estado, tel).catch(e => console.error('[NegWA] Error cerrando restantes:', e));

  return estado.ganador;
}

// ── Cerrar carriers que ya no aplican ────────────────────────────────────────
async function cerrarRestantes(estado, telGanador) {
  const pendientes = Object.entries(estado.carriers)
    .filter(([t, c]) => t !== telGanador && c.estado !== EST.CERRADO && c.estado !== EST.GANADOR);

  await Promise.allSettled(
    pendientes.map(([t]) => cerrarCarrier(estado, t, 'perdio'))
  );
}

async function cerrarCarrier(estado, tel, motivo) {
  const carrier = estado.carriers[tel];
  if (!carrier || carrier.estado === EST.CERRADO) return;
  carrier.estado = EST.CERRADO;

  const msg = motivo === 'perdio'
    ? mensajeCierreAmistoso(carrier.nombre)
    : mensajeCierreSinDisponibilidad(carrier.nombre);

  carrier.historial.push({ rol: 'sofia', texto: msg, ts: new Date().toISOString() });
  await enviarMensaje(tel, msg).catch(() => {});

  console.log(`[NegWA] ✗ ${carrier.nombre} cerrado (${motivo})`);
}

// ── Mensajes de WhatsApp ──────────────────────────────────────────────────────
function mensajeInicial(orden, nombre) {
  return (
    `Hola ${nombre} 👋 Soy *SOFIA* de *ABSTORAGES Logistics Solutions*.\n\n` +
    `Tenemos un servicio disponible — folio *${orden.folio}*:\n` +
    `📍 *Ruta:* ${orden.ruta || `${orden.origen} → ${orden.destino}`}\n` +
    `🚚 *Unidad:* ${orden.tipo_unidad}\n` +
    `📦 *Carga:* ${orden.tipo_carga || 'mercancía general'}${orden.descripcion_carga ? ` — ${orden.descripcion_carga}` : ''}\n` +
    `⚖️ *Peso:* ${orden.peso_toneladas || '?'} ton\n` +
    `📅 *Fecha:* ${orden.fecha_carga}\n\n` +
    `¿Tienes disponibilidad? ¿Cuánto cobras por este viaje?`
  );
}

function mensajePedirPrecio(nombre, orden) {
  return `${nombre}, ¿cuánto cobras por la ruta ${orden.ruta || `${orden.origen} → ${orden.destino}`} con ${orden.tipo_unidad}? Dime tu mejor precio.`;
}

function mensajeContraoferta(nombre, precioTecho, ronda) {
  if (ronda === 1) {
    return `${nombre}, lo máximo que puedo pagarte en este servicio es *$${precioTecho.toLocaleString()} MXN*. ¿Lo cerramos?`;
  }
  return `${nombre}, te insisto — mi tope es *$${precioTecho.toLocaleString()} MXN*, es lo mejor que tengo para este viaje. ¿Va?`;
}

function mensajeGanador(nombre, orden, precio) {
  return (
    `✅ *${nombre}, confirmado para el folio ${orden.folio}.*\n\n` +
    `📍 Ruta: ${orden.ruta || `${orden.origen} → ${orden.destino}`}\n` +
    `🚚 Unidad: ${orden.tipo_unidad}\n` +
    `📅 Fecha de carga: ${orden.fecha_carga}\n` +
    `💰 Tu pago: *$${precio.toLocaleString()} MXN*\n\n` +
    `En unos minutos te mandamos la *carta instrucción* con la dirección exacta y contacto del cliente.\n` +
    `Cualquier duda, escríbenos aquí. ¡Gracias y buen viaje! 🚛`
  );
}

function mensajeCierreAmistoso(nombre) {
  return (
    `Hola ${nombre}, gracias por tu pronta respuesta 👍\n\n` +
    `En esta ocasión ya cerramos el servicio con otro operador, pero tu disponibilidad y precio quedan registrados para las próximas cargas similares.\n\n` +
    `¡Mucho gusto y hasta la próxima! 🙌`
  );
}

function mensajeCierreSinDisponibilidad(nombre) {
  return `Sin problema ${nombre}, gracias por avisarme. Te contactamos cuando tengamos algo que se acomode a tu disponibilidad. ¡Hasta pronto! 👋`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizarTel(tel) {
  if (!tel) return null;
  // Quitar todo lo que no sea dígito
  const digits = String(tel).replace(/\D/g, '');
  // Asegurar formato internacional para México (52 + 10 dígitos)
  if (digits.length === 10) return `52${digits}`;
  if (digits.length === 12 && digits.startsWith('52')) return digits;
  if (digits.length === 13 && digits.startsWith('521')) return `52${digits.slice(3)}`;
  return digits;
}

function parsePrecio(val) {
  if (!val) return null;
  const n = parseFloat(String(val).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}

function estimarPrecioCliente(orden) {
  // Fallback si no hay precio: estimado genérico por tipo de unidad
  const base = { 'caja seca': 32000, 'torton': 18000, 'rabon': 14000, 'camioneta': 8000 };
  const tipo = (orden.tipo_unidad || '').toLowerCase();
  for (const [k, v] of Object.entries(base)) {
    if (tipo.includes(k)) return v;
  }
  return 25000;
}

function filtrarProveedores(proveedores, orden) {
  return proveedores.filter(p => {
    if (p.activo === false) return false;
    if (!p.telefono) return false;

    const origenOk = !p.rutas?.length ||
      p.rutas.some(r => {
        const orig = (orden.ruta || orden.origen || '').toUpperCase();
        return orig.includes(r.toUpperCase()) || r.toUpperCase().includes(orig.split(',')[0].trim());
      });

    const unidadOk = !p.tipos_unidad?.length ||
      p.tipos_unidad.some(u => {
        const unidad = (orden.tipo_unidad || '').toLowerCase();
        return unidad.includes(u.toLowerCase()) || u.toLowerCase().includes(unidad.split(' ')[0]);
      });

    return origenOk && unidadOk;
  });
}

// ── Consultar estado ──────────────────────────────────────────────────────────
function obtenerNegociacion(folio) {
  return negociaciones.get(folio?.toUpperCase?.() || folio) || null;
}

// ── Rutear mensaje entrante por teléfono ─────────────────────────────────────
function folioDeTeléfono(tel) {
  return telefonoAFolio.get(normalizarTel(tel)) || null;
}

module.exports = {
  lanzarNegociacion,
  procesarRespuesta,
  obtenerNegociacion,
  folioDeTeléfono,
  normalizarTel,
};
