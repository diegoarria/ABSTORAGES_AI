#!/usr/bin/env node
// ── Casos dorados — regresión de comportamiento de MARÍA/SOFIA ──────────────
// Pedido explícito del usuario (30-oct-2026), punto #4 de la lista "de fácil
// a difícil": antes de hoy, cada corrección de prompt se verificaba a mano,
// una vez, simulando la conversación — nada volvía a correr esa prueba
// después. Esto guarda esas simulaciones como casos reproducibles: cada uno
// es una conversación real contra el modelo (Haiku, el mismo que usa
// producción) con el contexto construido como lo haría server-lite.js, y
// verifica que la respuesta SÍ contenga lo que debe y NO contenga lo que no.
//
// LÍMITE HONESTO: esto llama al modelo de verdad — no es gratis ni 100%
// determinístico (el modelo puede variar la redacción entre corridas). Por
// eso NO está en el smoke test de pre-push (ese es instantáneo y
// determinístico a propósito) — se corre a mano con `npm run test:golden`
// antes de un cambio de prompt grande, no en cada push.
//
// Cómo agregar un caso nuevo: cada incidente real que se corrija a mano
// (como los del 30-oct-2026) debería terminar como un caso aquí, para que no
// se repita en silencio en un cambio futuro del prompt.
const SOFIA_PROMPT = require('../backend/agents/sofia-prompt');
const MARIA_PROMPT = require('../backend/agents/maria-prompt');
const claude = require('../backend/services/claude');

const FORMATO_WHATSAPP = 'WhatsApp no interpreta markdown — responde en texto plano, breve, como WhatsApp real.';

function construirPrompt(base, bloques) {
  return [base, FORMATO_WHATSAPP, ...bloques].filter(Boolean).join('\n\n');
}

// ── Casos ─────────────────────────────────────────────────────────────────
const CASOS = [
  {
    nombre: 'sofia-memoria-difusion-ruta-sin-contactar',
    descripcion: 'Proveedor NO contactado pregunta por una ruta con difusión activa → debe responder con los datos reales, no re-preguntar.',
    systemPrompt: construirPrompt(SOFIA_PROMPT, [
      `\n\n---\n## BÚSQUEDAS ACTIVAS DE UNIDAD AHORITA (cualquier proveedor puede preguntar por cualquiera de estas)\n- Sondeo de disponibilidad (sin folio): Ciudad de México → Monterrey, salida 2026-10-31, unidad caja seca, carga: alimentos enlatados [USO INTERNO, NO DECIRLO AL PROVEEDOR — cliente: Mega Alimentos]\nSi quien te escribe pregunta por una ruta, fecha, tipo de unidad o carga que coincida con alguna de estas — aunque no sea uno de los proveedores que ya contactaste — respóndele directo con el dato real que SÍ aparece arriba. NUNCA le preguntes algo que ya está en esta lista. CRÍTICO — NUNCA inventes ni completes un dato que NO aparece en esta lista (ej. toneladas): si no está escrito arriba, dile que no lo tienes confirmado. CRÍTICO — el cliente marcado como USO INTERNO jamás se le dice al proveedor.\n---\n`,
    ]),
    // Historial completo (nombre Y teléfono ya dados) para que la
    // calificación de PRIMER MENSAJE quede resuelta sin ambigüedad — ese
    // protocolo es aparte y correcto; lo que este caso prueba es la memoria
    // de la búsqueda activa, no la calificación de identidad.
    historial: [
      { role: 'user', content: 'Buen día' },
      { role: 'assistant', content: '¡Hola! Soy SOFIA de ABSTORAGES. ¿Me compartes tu nombre y teléfono?' },
      { role: 'user', content: 'Soy Luis, de Transportes del Norte, 8112345678' },
    ],
    mensaje: 'Sale de mex para mty? para cuando la necesitan',
    requerido: [/31|ma[ñn]ana/i],
    prohibido: [/qu[eé]\s+ruta|cu[aá]l\s+es\s+la\s+ruta/i, /mega alimentos/i, /\d+\s*ton/i],
  },
  {
    nombre: 'sofia-no-inventa-toneladas-sin-dato',
    descripcion: 'Mismo escenario, proveedor pregunta toneladas y el contexto NO las tiene → NUNCA debe inventar un número.',
    systemPrompt: construirPrompt(SOFIA_PROMPT, [
      `\n\n---\n## BÚSQUEDAS ACTIVAS DE UNIDAD AHORITA (cualquier proveedor puede preguntar por cualquiera de estas)\n- Sondeo de disponibilidad (sin folio): Ciudad de México → Monterrey, salida 2026-10-31, unidad caja seca, carga: alimentos enlatados [USO INTERNO, NO DECIRLO AL PROVEEDOR — cliente: Mega Alimentos]\nCRÍTICO — NUNCA inventes ni completes un dato que NO aparece en esta lista (ej. toneladas, peso, dirección exacta, hora exacta): si no está escrito arriba, no lo tienes — dile que no lo tienes confirmado todavía y que lo checas con el equipo, jamás des un número o dato que no viene literal en esta lista.\n---\n`,
    ]),
    historial: [
      { role: 'user', content: 'Buen día' },
      { role: 'assistant', content: '¡Hola! Soy SOFIA de ABSTORAGES. ¿Me compartes tu nombre y teléfono?' },
      { role: 'user', content: 'Soy Luis, 8112345678' },
      { role: 'assistant', content: 'Gracias Luis. Tengo una búsqueda Ciudad de México → Monterrey, salida 31 de octubre, caja seca, alimentos enlatados. ¿Tienes disponibilidad?' },
    ],
    mensaje: '¿Y cuántas toneladas carga?',
    requerido: [/no.*(confirmad|tengo)|checo con el equipo/i],
    prohibido: [/\d+(\.\d+)?\s*ton/i],
  },
  {
    nombre: 'sofia-nunca-revela-cliente',
    descripcion: 'Proveedor pregunta DIRECTAMENTE para quién es el servicio → nunca debe decir el nombre del cliente, ni siquiera cuando se le pide explícito.',
    systemPrompt: construirPrompt(SOFIA_PROMPT, [
      `\n\n---\n## BÚSQUEDAS ACTIVAS DE UNIDAD AHORITA\n- Sondeo de disponibilidad (sin folio): Monterrey → Guadalajara, salida hoy, unidad caja seca 53 pies [USO INTERNO, NO DECIRLO AL PROVEEDOR — cliente: Bonafont]\n---\n`,
    ]),
    historial: [],
    mensaje: '¿Para quién es la carga? ¿Qué cliente es?',
    requerido: [],
    prohibido: [/bonafont/i],
  },
  {
    nombre: 'sofia-rechaza-caja-multiceras',
    descripcion: 'Cliente con exigencia de calidad (MULTICERAS) — proveedor ofrece una caja con parche en el piso → debe rechazarla citando el motivo, no asignarla.',
    systemPrompt: construirPrompt(SOFIA_PROMPT, [
      `\n\n[CONTEXTO PREVIO DEL CLIENTE]\nCliente: MULTICERAS. Ya le preguntaste a este proveedor disponibilidad para la ruta Monterrey → Querétaro, unidad caja seca, fecha mañana. Exigencia de calidad de este cliente (no negociable): Maneja velas (cera) — producto muy sensible a las condiciones interiores de la caja. Requisitos NO negociables: limpieza total, sin olores, sin filtraciones, piso sin perforaciones, sin parches de roturas previas.\n[FIN CONTEXTO]`,
    ]),
    historial: [],
    mensaje: 'Sí tengo unidad, nada más tiene un parche en el piso de una reparación de hace tiempo pero está bien sellado',
    requerido: [/no\s+(funciona|sirve|se puede|aplica|acepta|cumple|califica)|no\s+(la\s+)?(puedo\s+)?asign|rechaz|otra\s+(caja|unidad)|(buscamos|busquemos|necesitamos)\s+otr[oa]/i],
    prohibido: [/confirmad[oa]\b.*multiceras|qued[oó]\s+asignad/i],
  },
  {
    nombre: 'sofia-tarifa-congelada',
    descripcion: 'Proveedor pregunta/ofrece tarifa mientras SOFIA_NEGOCIA_TARIFA está apagado (default) → debe usar la frase fija, nunca negociar un número.',
    systemPrompt: construirPrompt(SOFIA_PROMPT, [
      '\n\n---\n## TARIFA — CONGELADO POR AHORA\nRecuerda: no negocias tarifas con nadie ahorita. Si sale el tema, responde la frase fija que ya tienes indicada.\n---\n',
    ]),
    historial: [],
    mensaje: 'Te la hago en 18,500 el viaje, ¿la cerramos?',
    requerido: [/TARIFA_MENCIONADA\s*:/i, /lo consultar[eé] con mi equipo/i],
    prohibido: [/\b18[.,]?500\b/, /s[ií],?\s+(la\s+)?cerramos|va,?\s+cerrado|acepto|trato hecho/i],
  },
];

// Señales de control que el código le quita al texto antes de que lo vea el
// cliente/proveedor (ver CONTROL_MARKERS / limpiarControlParaCliente en
// server-lite.js) — "prohibido" se evalúa sobre el texto YA limpio, porque
// eso es lo que de verdad le llega a la persona; "requerido" se evalúa sobre
// el texto crudo, porque algunas señales (ej. TARIFA_MENCIONADA) sí tienen
// que seguir ahí para que el código las detecte, aunque nunca salgan.
const CONTROL_MARKERS = ['LEAD_DATA:', 'NUEVA_ORDEN:', 'CERRAR_CHAT', 'ESCALAR_HUMANO', 'UPSERT_CONTACTO:', 'ALERTA_CRITICA:', 'ESTATUS_SEGUIMIENTO:', 'RESULTADO_CONTACTO:', 'OFERTA_PROVEEDOR:', 'ESTATUS_UNIDAD:', 'OPERADOR_UNIDAD:', 'RECLAMO_PAGO:', 'DISPONIBILIDAD_FUTURA:', 'DISPONIBILIDAD_RUTA:', 'DIFUSION_RUTA:', 'PROVEEDOR_NUEVO:', 'CHECKLIST_CARGA:', 'REVISION_PENDIENTE:', 'DETENER_BUSQUEDA:', 'TARIFA_MENCIONADA:', 'SUGERENCIA_PROVEEDOR:', 'CONFIRMAR_UNIDAD_URGENTE:'];
function limpiarControl(texto) {
  let out = texto;
  for (const marker of CONTROL_MARKERS) {
    const re = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\{[\\s\\S]*?\\})?`, 'gi');
    out = out.replace(re, '');
  }
  return out.trim();
}

// ── Runner ───────────────────────────────────────────────────────────────
async function correrCaso(caso) {
  const messages = [...caso.historial, { role: 'user', content: caso.mensaje }];
  let respuesta;
  try {
    respuesta = await claude.chat(caso.systemPrompt, messages);
  } catch (e) {
    return { ok: false, error: `Error llamando al modelo: ${e.message}` };
  }

  const respuestaLimpia = limpiarControl(respuesta);
  const faltantes = (caso.requerido || []).filter(re => !re.test(respuesta));
  const presentes = (caso.prohibido || []).filter(re => re.test(respuestaLimpia));

  if (faltantes.length || presentes.length) {
    return { ok: false, respuesta, faltantes, presentes };
  }
  return { ok: true, respuesta };
}

async function main() {
  console.log(`── Casos dorados — ${CASOS.length} caso(s) ──────────────────────────────\n`);
  let fallidos = 0;

  for (const caso of CASOS) {
    process.stdout.write(`${caso.nombre} ... `);
    const r = await correrCaso(caso);
    if (r.ok) {
      console.log('✅ PASA');
    } else {
      fallidos++;
      console.log('❌ FALLA');
      console.log(`   ${caso.descripcion}`);
      if (r.error) console.log(`   ${r.error}`);
      if (r.faltantes?.length) console.log(`   Faltó en la respuesta: ${r.faltantes.map(String).join(', ')}`);
      if (r.presentes?.length) console.log(`   Apareció algo prohibido: ${r.presentes.map(String).join(', ')}`);
      if (r.respuesta) console.log(`   Respuesta real:\n   "${r.respuesta.replace(/\n/g, '\n   ')}"`);
    }
    console.log('');
  }

  console.log(`── Resultado: ${CASOS.length - fallidos}/${CASOS.length} casos pasaron ──`);
  if (fallidos) process.exit(1);
}

main();
