#!/usr/bin/env node
// ─── ABSTORAGES AI PORTAL — SIMULADOR TERMINAL ───────────────────────────────
// Corre SARA y SOFIA en la terminal sin necesidad de PostgreSQL ni Redis.
// Requiere solo: ANTHROPIC_API_KEY en .env

require('dotenv').config();
const readline = require('readline');
const Anthropic = require('@anthropic-ai/sdk');
const EventEmitter = require('events');

// ─── VERIFICAR API KEY ────────────────────────────────────────────────────────
if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes('xxx')) {
  console.log('\n\x1b[31m✗ ANTHROPIC_API_KEY no configurada.\x1b[0m');
  console.log('\nPasos:');
  console.log('  1. Ve a \x1b[36mhttps://console.anthropic.com\x1b[0m');
  console.log('  2. API Keys → Create Key');
  console.log('  3. Copia la clave en el archivo \x1b[33m.env\x1b[0m:');
  console.log('     \x1b[32mANTHROPIC_API_KEY=sk-ant-...\x1b[0m\n');
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const bus = new EventEmitter();

// ─── ESTADO EN MEMORIA ────────────────────────────────────────────────────────
const state = {
  folios: [],
  saraHistory: [],
  sofiaHistory: [],
  folioCounter: 1,
  pendingOrden: null,
};

// ─── SYSTEM PROMPTS (versión compacta para el simulador) ─────────────────────
const SARA_PROMPT = require('./backend/agents/sara-prompt');
const SOFIA_PROMPT = require('./backend/agents/sofia-prompt');

// ─── COLORES ──────────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  verde: '\x1b[32m',
  azul: '\x1b[34m',
  amber: '\x1b[33m',
  rojo: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  white: '\x1b[97m',
};

const verde = (t) => `${c.verde}${t}${c.reset}`;
const azul = (t) => `${c.azul}${t}${c.reset}`;
const amber = (t) => `${c.amber}${t}${c.reset}`;
const dim = (t) => `${c.dim}${t}${c.reset}`;
const bold = (t) => `${c.bold}${t}${c.reset}`;
const gray = (t) => `${c.gray}${t}${c.reset}`;

// ─── READLINE ─────────────────────────────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

function pregunta(prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

// ─── BANNER ───────────────────────────────────────────────────────────────────
function banner() {
  console.clear();
  console.log(verde('╔══════════════════════════════════════════════════════════╗'));
  console.log(verde('║') + bold('        ABSTORAGES AI Portal — SIMULADOR TERMINAL       ') + verde('║'));
  console.log(verde('╠══════════════════════════════════════════════════════════╣'));
  console.log(verde('║') + '  SARA (AI Vendedora)  +  SOFIA (AI Planner)             ' + verde('║'));
  console.log(verde('║') + dim('  Comunicación vía EventBus (simula Redis Pub/Sub)       ') + verde('║'));
  console.log(verde('╚══════════════════════════════════════════════════════════╝'));
  console.log('');
}

// ─── STREAM CON CLAUDE ────────────────────────────────────────────────────────
async function streamChat(agente, systemPrompt, historial, userMessage) {
  const color = agente === 'SARA' ? c.verde : c.azul;
  const label = agente === 'SARA' ? verde(`[SARA]`) : azul(`[SOFIA]`);

  historial.push({ role: 'user', content: userMessage });

  process.stdout.write(`\n${label} `);

  const stream = await client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: historial,
  });

  let fullText = '';

  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      const text = chunk.delta.text;
      fullText += text;
      process.stdout.write(`${color}${text}${c.reset}`);
    }
  }

  historial.push({ role: 'assistant', content: fullText });
  console.log('\n');
  return fullText;
}

// ─── DETECCIÓN DE CIERRE DE VENTA ────────────────────────────────────────────
function detectarCierre(texto) {
  const triggers = [
    'confirmo el servicio', 'venta cerrada', 'servicio registrado',
    'folio', 'pasando a sofia', 'notifico a sofia', 'publicando',
    'confirmado', 'procedo a notificar', 'cierro el servicio',
    'registrando el servicio', 'informo a sofia',
  ];
  return triggers.some(t => texto.toLowerCase().includes(t));
}

function generarFolio() {
  return `ABST-${String(state.folioCounter++).padStart(6, '0')}`;
}

// ─── MODO SARA ────────────────────────────────────────────────────────────────
async function modoSara() {
  console.log(verde('─'.repeat(62)));
  console.log(bold(verde('  SARA — AI Vendedora · ABSTORAGES Logistics Solutions')));
  console.log(verde('─'.repeat(62)));
  console.log(dim('  Comandos: /sofia → cambiar a SOFIA  |  /exit → salir'));
  console.log(dim('  SARA detectará automáticamente cuando cierres una venta'));
  console.log(verde('─'.repeat(62)));
  console.log('');
  console.log(`${verde('[SARA]')} ¡Hola! Soy SARA, la AI Vendedora de ABSTORAGES Logistics.\n  Estoy lista para prospectar, cotizar y cerrar servicios de transporte. ¿En qué te puedo ayudar?\n`);

  while (true) {
    const input = await pregunta(`${bold(c.white + '[Tú → SARA]' + c.reset)} `);

    if (!input.trim()) continue;
    if (input.trim() === '/exit') break;
    if (input.trim() === '/sofia') {
      await modoSofia();
      break;
    }
    if (input.trim() === '/clear') {
      state.saraHistory = [];
      console.log(dim('  [Historial de SARA limpiado]\n'));
      continue;
    }
    if (input.trim() === '/folio') {
      await simularCierreVenta();
      continue;
    }

    try {
      const respuesta = await streamChat('SARA', SARA_PROMPT, state.saraHistory, input);

      // Detectar si SARA está cerrando una venta
      if (detectarCierre(respuesta)) {
        const folio = generarFolio();
        console.log(amber(`\n  ┌─── CIERRE DE VENTA DETECTADO ─────────────────────────────`));
        console.log(amber(`  │  SARA publicó evento "nueva_orden" → Redis/EventBus`));
        console.log(amber(`  │  Folio generado: ${folio}`));
        console.log(amber(`  └───────────────────────────────────────────────────────────\n`));

        state.pendingOrden = {
          folio,
          evento: 'nueva_orden',
          fuente: 'SARA',
          timestamp: new Date().toISOString(),
          mensaje_sara: input,
        };

        bus.emit('nueva_orden', state.pendingOrden);
      }
    } catch (err) {
      if (err.status === 401) {
        console.log(c.rojo + '\n✗ Error de autenticación: tu ANTHROPIC_API_KEY es inválida.\n  Verifica que copiaste la clave correctamente en .env\n' + c.reset);
      } else {
        console.log(c.rojo + `\n✗ Error: ${err.message}\n` + c.reset);
      }
    }
  }
}

// ─── MODO SOFIA ────────────────────────────────────────────────────────────────
async function modoSofia(ordenInicial = null) {
  console.log(azul('─'.repeat(62)));
  console.log(bold(azul('  SOFIA — AI Planner · ABSTORAGES Logistics Solutions')));
  console.log(azul('─'.repeat(62)));
  console.log(dim('  Comandos: /sara → cambiar a SARA  |  /exit → salir'));
  console.log(dim('  SOFIA recibe órdenes automáticamente cuando SARA cierra una venta'));
  console.log(azul('─'.repeat(62)));
  console.log('');

  if (ordenInicial) {
    const msgInicial = `Acabo de recibir una nueva orden de SARA. Folio: ${ordenInicial.folio}. Inicia el Flujo Primario — Paso 1: confirma recepción del requerimiento y describe qué harás a continuación para colocar el servicio.`;
    console.log(azul(`[SOFIA]`) + dim(` ← nueva_orden recibida (folio: ${ordenInicial.folio})\n`));
    try {
      await streamChat('SOFIA', SOFIA_PROMPT, state.sofiaHistory, msgInicial);
    } catch (err) {
      console.log(c.rojo + `✗ Error: ${err.message}\n` + c.reset);
    }
  } else {
    console.log(`${azul('[SOFIA]')} Hola, soy SOFIA, la AI Planner de ABSTORAGES Logistics.\n  Gestiono operaciones: transportistas, GPS, folios, documentación ABCONTROL. ¿Qué necesitas?\n`);
  }

  while (true) {
    const input = await pregunta(`${bold(c.white + '[Tú → SOFIA]' + c.reset)} `);

    if (!input.trim()) continue;
    if (input.trim() === '/exit') break;
    if (input.trim() === '/sara') {
      await modoSara();
      break;
    }
    if (input.trim() === '/clear') {
      state.sofiaHistory = [];
      console.log(dim('  [Historial de SOFIA limpiado]\n'));
      continue;
    }
    if (input.trim() === '/folios') {
      console.log(dim(`\n  Folios en simulación: ${state.folios.length === 0 ? 'ninguno aún' : state.folios.map(f => f.folio).join(', ')}\n`));
      continue;
    }

    try {
      await streamChat('SOFIA', SOFIA_PROMPT, state.sofiaHistory, input);
    } catch (err) {
      if (err.status === 401) {
        console.log(c.rojo + '\n✗ Error de autenticación: tu ANTHROPIC_API_KEY es inválida.\n' + c.reset);
      } else {
        console.log(c.rojo + `\n✗ Error: ${err.message}\n` + c.reset);
      }
    }
  }
}

// ─── SIMULACIÓN RÁPIDA (demo automática) ─────────────────────────────────────
async function simularCierreVenta() {
  const folio = generarFolio();
  const orden = {
    folio,
    cliente: 'Grupo Industrial Norteño SA de CV',
    ruta: { origen: 'CDMX', destino: 'Monterrey', cp_origen: '06600', cp_destino: '64000' },
    tipo_unidad: 'Caja Seca 53\'',
    mercancia: 'Productos de limpieza (carga general)',
    peso: '20,000 kg',
    fecha_carga: new Date(Date.now() + 86400000).toISOString().split('T')[0],
    hora_cita: '08:00',
    precio_cliente: '$22,000 MXN + IVA',
    condiciones_especiales: 'Cliente requiere GPS espejo y foto de evidencia al cargar',
  };

  console.log(amber(`\n  ┌─── DEMO: VENTA CERRADA ──────────────────────────────────────`));
  console.log(amber(`  │  Cliente:   ${orden.cliente}`));
  console.log(amber(`  │  Ruta:      ${orden.ruta.origen} → ${orden.ruta.destino}`));
  console.log(amber(`  │  Unidad:    ${orden.tipo_unidad}`));
  console.log(amber(`  │  Tarifa:    ${orden.precio_cliente}`));
  console.log(amber(`  │  Folio:     ${folio}`));
  console.log(amber(`  │`));
  console.log(amber(`  │  SARA → Redis: publicando "nueva_orden"...`));
  console.log(amber(`  └──────────────────────────────────────────────────────────────\n`));

  state.pendingOrden = orden;
  state.folios.push(orden);
  bus.emit('nueva_orden', orden);
}

// ─── MENÚ PRINCIPAL ───────────────────────────────────────────────────────────
async function menuPrincipal() {
  banner();

  console.log('  ¿Con qué agente quieres empezar?\n');
  console.log(`  ${verde('[1]')} SARA — AI Vendedora  (prospecta, cotiza, cierra ventas)`);
  console.log(`  ${azul('[2]')} SOFIA — AI Planner   (opera servicios, GPS, folios)`);
  console.log(`  ${amber('[3]')} Demo completa        (simulación automática SARA→SOFIA)`);
  console.log(`  ${gray('[4]')} Salir`);
  console.log('');

  const opcion = await pregunta(`  ${bold('Opción:')} `);

  switch (opcion.trim()) {
    case '1':
      console.log('');
      await modoSara();
      break;
    case '2':
      console.log('');
      await modoSofia();
      break;
    case '3':
      console.log('');
      await demoCompleta();
      break;
    case '4':
    case '/exit':
      console.log(dim('\n  Hasta luego.\n'));
      rl.close();
      process.exit(0);
      break;
    default:
      console.log(dim('  Opción no válida.\n'));
      await menuPrincipal();
  }
}

// ─── DEMO COMPLETA AUTOMÁTICA ─────────────────────────────────────────────────
async function demoCompleta() {
  console.log(verde('─'.repeat(62)));
  console.log(bold('  DEMO: Flujo completo SARA → SOFIA'));
  console.log(verde('─'.repeat(62)));
  console.log(dim('  Simulando una venta completa y el inicio de operaciones...\n'));

  // Paso 1: SARA recibe un cliente
  console.log(dim('  [1/4] Cliente contacta a SARA por WhatsApp...\n'));
  await streamChat(
    'SARA',
    SARA_PROMPT,
    state.saraHistory,
    'Hola, soy Carlos de Distribuidora Norteña. Necesito cotización para mover 20 toneladas de abarrotes de Guadalajara a Monterrey, quiero una caja seca 53 para el próximo jueves.'
  );

  // Paso 2: SARA cierra la cotización
  console.log(dim('  [2/4] Carlos acepta la cotización...\n'));
  const respuestaCierre = await streamChat(
    'SARA',
    SARA_PROMPT,
    state.saraHistory,
    'Me parece bien la tarifa. ¿Cómo procedemos? Confirmo el servicio.'
  );

  // Paso 3: Publicar nueva_orden
  const folio = generarFolio();
  const orden = {
    folio,
    cliente: 'Distribuidora Norteña SA de CV',
    ruta: { origen: 'Guadalajara', destino: 'Monterrey' },
    tipo_unidad: "Caja Seca 53'",
    mercancia: 'Abarrotes',
    peso: '20,000 kg',
    fecha_carga: new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0],
    precio_cliente: 'pendiente de confirmar',
  };

  console.log(amber(`\n  ┌─── EVENTO REDIS: nueva_orden ─────────────────────────────`));
  console.log(amber(`  │  SARA → EventBus → SOFIA`));
  console.log(amber(`  │  Folio: ${folio}`));
  console.log(amber(`  └──────────────────────────────────────────────────────────\n`));

  // Paso 4: SOFIA recibe y actúa
  console.log(dim(`  [3/4] SOFIA recibe la orden y ejecuta Paso 1 del flujo...\n`));
  await streamChat(
    'SOFIA',
    SOFIA_PROMPT,
    state.sofiaHistory,
    `Acabo de recibir una nueva orden de SARA con folio ${folio}. Datos: cliente Distribuidora Norteña, ruta Guadalajara→Monterrey, caja seca 53', 20 toneladas de abarrotes, fecha de carga en 3 días. Inicia el Flujo Primario desde el Paso 1: confirma recepción, extrae los datos clave y describe qué harás en el Paso 2 (búsqueda de transportistas).`
  );

  // Paso 5: SOFIA busca transportistas
  console.log(dim('  [4/4] SOFIA ejecuta Paso 2: búsqueda de disponibilidad...\n'));
  await streamChat(
    'SOFIA',
    SOFIA_PROMPT,
    state.sofiaHistory,
    `Tenemos 2 proveedores recurrentes para la ruta GDL-MTY: Transportes Martínez (tel: 3310001234) y Fletes González (tel: 8110005678). ¿Cuál es el mensaje exacto de WhatsApp que les envías para verificar disponibilidad de caja seca 53'?`
  );

  console.log(verde('─'.repeat(62)));
  console.log(bold(verde('  ✓ Demo completa')));
  console.log(dim('  SARA cerró la venta → SOFIA inició el flujo de operaciones'));
  console.log(verde('─'.repeat(62)));
  console.log('');

  const continuar = await pregunta('  ¿Continuar en modo SOFIA para seguir el flujo? (s/n) ');
  if (continuar.toLowerCase() === 's' || continuar.toLowerCase() === 'si' || continuar.toLowerCase() === 'sí') {
    console.log('');
    await modoSofia();
  } else {
    await menuPrincipal();
  }
}

// ─── ESCUCHAR EVENTOS REDIS (SIMULADO) ───────────────────────────────────────
bus.on('nueva_orden', async (orden) => {
  state.folios.push(orden);
  // Si el usuario está en modo SARA, notificar que puede cambiar a SOFIA
  console.log(azul(`\n  ── SOFIA recibió nueva_orden (folio: ${orden.folio}) ──`));
  console.log(dim(`  Escribe /sofia para ver a SOFIA tomar el control de este servicio.\n`));
});

// ─── MANEJO DE SEÑALES ────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log(dim('\n\n  Simulación terminada. Hasta luego.\n'));
  rl.close();
  process.exit(0);
});

// ─── INICIAR ──────────────────────────────────────────────────────────────────
menuPrincipal().catch((err) => {
  console.error(c.rojo + '\n✗ Error inesperado:', err.message + c.reset);
  process.exit(1);
});
