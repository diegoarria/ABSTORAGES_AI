// ── Envío masivo de plantillas desde Base de Datos ───────────────────────────
// Un clic manda la misma plantilla APROBADA a muchos contactos, cada uno con su
// nombre. Candados (todos obligatorios):
//   · solo plantillas aprobadas del agente (plantillasAprobadas)
//   · vista previa + confirmación escribiendo el número exacto de destinatarios
//   · pausa del agente y tope diario (outboundRateLimit) — el envío se detiene solo
//   · envío escalonado (uno cada ENVIO_MASIVO_PAUSA_MS) y nunca dos veces la
//     misma plantilla al mismo contacto el mismo día
//   · se omiten contactos sin teléfono y proveedores dados de Baja/Suspendido
const plantillas = require('./plantillasAprobadas');
const whatsapp = require('./whatsappProactivo');
const outboundRateLimit = require('./outboundRateLimit');
const agentPause = require('./agentPause');
const contactos = require('./contactos');
const actividadBus = require('./actividadBus');

const PAUSA_MS = Number(process.env.ENVIO_MASIVO_PAUSA_MS || 2500);
const MAX_POR_ENVIO = Number(process.env.ENVIO_MASIVO_MAX || 100);

const enviadasHoy = new Map(); // "idContacto|sid|fecha" → true
const trabajos = new Map();     // id → estado del envío en curso o terminado

const fechaMTY = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Monterrey', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const titulo = s => String(s || '').toLowerCase().replace(/(^|\s|-)(\S)/g, (m, a, b) => a + b.toUpperCase());

// Nombre con el que se le habla: el trato acordado en notas ("Sr. Marco"),
// el primer nombre de una persona o el nombre completo si es una empresa.
function nombreParaSaludo(c, modo) {
  const trato = (c.notas || '').match(/"(Sr\.?\s[^"]+)"/);
  if (trato) return trato[1];
  const completo = titulo(c.nombre_completo);
  if (modo === 'completo') return completo;
  const esEmpresa = c.empresa && c.nombre_completo && c.empresa.trim().toLowerCase() === c.nombre_completo.trim().toLowerCase();
  return esEmpresa ? completo : completo.split(/\s+/)[0];
}

function motivoOmision(c, agente, sid) {
  if (!c.telefono) return 'sin teléfono';
  if (/Estatus en catálogo: (Baja|Suspendido)/i.test(c.notas || '')) return 'dado de baja o suspendido en el catálogo';
  if (enviadasHoy.has(`${c.id}|${sid}|${fechaMTY()}`)) return 'ya recibió esta plantilla hoy';
  if (String(c.agente_asignado || '').toLowerCase() !== agente) return 'pertenece a otro agente';
  return null;
}

function armarVariables(plantilla, c, compartidas, modo) {
  const v = {};
  for (const campo of plantilla.campos || []) {
    v[campo.key] = /^nombre/i.test(campo.label) ? nombreParaSaludo(c, modo) : String((compartidas || {})[campo.key] || '').trim();
  }
  return v;
}
const textoDe = (plantilla, v) => (plantilla.texto || '').replace(/\{\{(\d+)\}\}/g, (m, n) => v[n] || '');

async function cargarContactos(ids) {
  const out = [];
  for (const id of ids.slice(0, MAX_POR_ENVIO + 200)) { const c = await contactos.obtenerDetalle(id); if (c) out.push(c); }
  return out;
}

async function previsualizar({ agente, ids, contentSid, variables, modoNombre }) {
  const plantilla = plantillas.buscarPlantilla(agente, contentSid);
  if (!plantilla) throw new Error('Esa plantilla no está aprobada para este agente.');
  if (!Array.isArray(ids) || !ids.length) throw new Error('No hay contactos seleccionados.');
  const lista = await cargarContactos(ids);
  const faltantes = (plantilla.campos || []).filter(c => !/^nombre/i.test(c.label) && !String((variables || {})[c.key] || '').trim());
  if (faltantes.length) throw new Error('Falta llenar: ' + faltantes.map(c => c.label).join(', '));
  const enviables = [], omitidos = [];
  for (const c of lista) {
    const m = motivoOmision(c, agente, contentSid);
    if (m) omitidos.push({ nombre: c.nombre_completo, motivo: m }); else enviables.push(c);
  }
  const est = outboundRateLimit.estado ? outboundRateLimit.estado(agente) : null;
  const restante = est ? Math.max(0, (est.limite ?? 40) - (est.count ?? 0)) : null;
  const ej = enviables[0];
  return {
    plantilla: plantilla.nombre, total: lista.length, enviables: enviables.length, omitidos,
    excedeMaximo: enviables.length > MAX_POR_ENVIO, maximo: MAX_POR_ENVIO,
    restanteHoy: restante, limiteDiario: est?.limite ?? null,
    quedaranSinEnviar: restante == null ? 0 : Math.max(0, enviables.length - restante),
    pausado: agentPause.estaPausado(agente),
    ejemplo: ej ? { para: ej.nombre_completo, texto: textoDe(plantilla, armarVariables(plantilla, ej, variables, modoNombre)) } : null,
  };
}

async function iniciar({ agente, ids, contentSid, variables, modoNombre, confirmar, por }) {
  const prev = await previsualizar({ agente, ids, contentSid, variables, modoNombre });
  if (prev.pausado) throw new Error(`${agente.toUpperCase()} está pausada — no puede contactar a nadie por ahora.`);
  if (prev.excedeMaximo) throw new Error(`Máximo ${prev.maximo} destinatarios por envío.`);
  if (!prev.enviables) throw new Error('No hay ningún contacto enviable en la selección.');
  if (Number(confirmar) !== prev.enviables) throw new Error(`Confirmación incorrecta: escribe el número exacto de destinatarios (${prev.enviables}).`);

  const plantilla = plantillas.buscarPlantilla(agente, contentSid);
  const lista = (await cargarContactos(ids)).filter(c => !motivoOmision(c, agente, contentSid));
  const id = 'EM-' + Date.now().toString(36).toUpperCase();
  const t = { id, plantilla: plantilla.nombre, total: lista.length, enviados: 0, fallidos: [], omitidosPorTope: 0, terminado: false, inicio: new Date().toISOString(), por: por || null };
  trabajos.set(id, t);
  actividadBus.emitir({ agente: agente.toUpperCase(), tipo: 'CONTACTO_SALIENTE', mensaje: `Envío masivo iniciado por ${por || 'el equipo'}: plantilla "${plantilla.nombre}" a ${lista.length} contactos` });

  (async () => {
    for (const c of lista) {
      if (agentPause.estaPausado(agente)) { t.omitidosPorTope = lista.length - t.enviados - t.fallidos.length; t.detenidoPor = 'el agente fue pausado'; break; }
      const v = armarVariables(plantilla, c, variables, modoNombre);
      try {
        const r = await whatsapp.enviarPlantilla(agente, c.telefono, contentSid, v);
        if (r?.status === 'rate_limited') { t.omitidosPorTope = lista.length - t.enviados - t.fallidos.length; t.detenidoPor = 'se alcanzó el tope diario de mensajes'; break; }
        if (r?.status === 'paused') { t.detenidoPor = 'el agente fue pausado'; t.omitidosPorTope = lista.length - t.enviados - t.fallidos.length; break; }
        t.enviados++;
        enviadasHoy.set(`${c.id}|${contentSid}|${fechaMTY()}`, true);
        whatsapp.registrarEnMemoria(agente, c.telefono, textoDe(plantilla, v));
        contactos.upsertContacto({ agente, telefono: c.telefono, resumen_interaccion: `Plantilla "${plantilla.nombre}" enviada en envío masivo desde Base de Datos`, canal: 'whatsapp-plantilla' }).catch(() => {});
      } catch (e) { t.fallidos.push({ nombre: c.nombre_completo, error: String(e.message).slice(0, 160) }); }
      await new Promise(r => setTimeout(r, PAUSA_MS));
    }
    t.terminado = true;
    actividadBus.emitir({ agente: agente.toUpperCase(), tipo: 'CONTACTO_SALIENTE', mensaje: `Envío masivo terminado: ${t.enviados} enviados de ${t.total}${t.fallidos.length ? `, ${t.fallidos.length} fallidos` : ''}${t.detenidoPor ? ` — se detuvo porque ${t.detenidoPor}` : ''}` });
  })().catch(e => { t.terminado = true; t.error = e.message; });

  return { id, total: lista.length };
}

const estado = id => trabajos.get(id) || null;

module.exports = { previsualizar, iniciar, estado };
