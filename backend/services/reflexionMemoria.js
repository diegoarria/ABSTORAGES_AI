// ── Reflexión de memoria — qué vale la pena recordar de ESTA persona ───────
// Punto #6 de la lista de mejoras pedida por el usuario (30-oct-2026): hasta
// ahora, lo único que se guardaba a largo plazo de un proveedor/cliente era
// lo que algún punto específico del código ya había anticipado (ej.
// whatsappProactivo.guardarContextoRequerimiento guarda ruta/fecha/unidad
// cuando SOFIA le pregunta disponibilidad a un proveedor). Cualquier otro
// tipo de dato importante que nadie haya anticipado en código — "este
// proveedor siempre regatea fuerte y acepta a la segunda", "este cliente se
// queja seguido del tiempo de respuesta", "esta persona solo contesta de
// noche" — nunca se guardaba, sin importar cuántas veces hubiera pasado.
//
// Esto corre DESPUÉS de que la respuesta ya se mandó (fire-and-forget, nunca
// bloquea ni retrasa la conversación real) y decide con una llamada aparte,
// barata, si ese turno dejó algo que valga la pena recordar para el futuro —
// no datos de ESTE servicio puntual (eso ya lo cubren folioContexto/
// guardarContextoRequerimiento), sino patrones de la RELACIÓN con esta
// persona. Si no hay nada nuevo, no escribe nada — la mayoría de los turnos
// no van a dejar un hecho nuevo, y está bien así.
//
// Apagado por default — requiere REFLEXION_MEMORIA=true en el entorno,
// mismo criterio que mariaTmsWatch.js/difusionGeneral.js: un gasto nuevo de
// API en cada mensaje no se activa solo.
const memory = require('./memory');
const claude = require('./claude');

const HABILITADO = process.env.REFLEXION_MEMORIA === 'true';
// Mensajes muy cortos ("ok", "va", "gracias") casi nunca dejan un hecho
// nuevo — se filtran antes de gastar una llamada al modelo.
const LARGO_MINIMO = 15;

const SYSTEM_PROMPT = `Eres un extractor de memoria de relación para una empresa de logística (ABSTORAGES). Te paso un mensaje de un proveedor o cliente y la respuesta que se le dio.

Tu única tarea: decidir si ese intercambio revela un HECHO DURADERO sobre esa persona o empresa — algo útil para conversaciones FUTURAS, no para el servicio puntual de ahora mismo (ruta, fecha, folio — eso ya se guarda aparte, ignóralo).

Ejemplos de hechos que SÍ vale la pena guardar:
- Patrones de comportamiento: "siempre contesta de noche", "tiende a regatear fuerte y acepta a la segunda oferta", "nunca contesta llamadas, solo WhatsApp"
- Preferencias o capacidad real: "su unidad de 53 pies ya no la tiene, ahora solo maneja torton", "prefiere rutas cortas, evita Nuevo Laredo"
- Quejas o fricciones reales: "se quejó de que el pago tardó más de lo acordado", "pidió que ya no le manden la plantilla general, prefiere trato directo"
- Confiabilidad: "canceló dos veces después de confirmar", "siempre cumple lo que promete"

Ejemplos de lo que NO cuenta (ignóralos, responde NADA):
- Datos de un servicio puntual (ruta, fecha, tonelaje, precio de este viaje)
- Saludos, confirmaciones simples, agradecimientos
- Cualquier cosa que ya es obvia o no aporta nada nuevo

Responde con UNA sola frase corta y factual (máximo 25 palabras), en español, sin opiniones ni adornos — o responde exactamente "NADA" si no hay nada que valga la pena guardar. Nunca expliques tu razonamiento, nunca agregues nada más que la frase o "NADA".`;

async function reflexionar(session, textoUsuario, textoRespuesta) {
  if (!HABILITADO) return;
  const texto = String(textoUsuario || '').trim();
  if (texto.length < LARGO_MINIMO) return; // mensajes muy cortos casi nunca dejan un hecho nuevo
  try {
    const r = await claude.chat(SYSTEM_PROMPT, [{
      role: 'user',
      content: `Mensaje de la persona: "${texto.slice(0, 600)}"\nRespuesta que se le dio: "${String(textoRespuesta || '').slice(0, 600)}"\n\n¿Hay un hecho duradero que valga la pena recordar?`,
    }], { maxTokens: 80 });
    const limpio = String(r || '').trim().replace(/^["']|["']$/g, '');
    if (!limpio || /^nada\.?$/i.test(limpio)) return;
    memory.agregarHecho(session, limpio);
  } catch (e) {
    console.error('[reflexionMemoria] Error:', e.message);
  }
}

module.exports = { reflexionar };
