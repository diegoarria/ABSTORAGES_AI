// ─── BROADCAST — Envío masivo WhatsApp con cola y rate-limit ─────────────────

const whatsapp = require('./whatsapp');

// ─── Catálogo de plantillas ───────────────────────────────────────────────────
const TEMPLATES = [
  {
    id: 'servicio_programado',
    nombre: 'Servicio Programado',
    agente: 'sofia',
    descripcion: 'Notifica al cliente que su servicio fue programado',
    variables: ['nombre', 'folio', 'fecha', 'ruta'],
    preview: 'Hola {nombre}, tu servicio ABSTORAGES folio {folio} está programado para el {fecha}. Ruta: {ruta}. Para cambios o dudas responde este mensaje.',
  },
  {
    id: 'cotizacion_lista',
    nombre: 'Cotización Lista',
    agente: 'sara',
    descripcion: 'Avisa al prospecto que su cotización está lista',
    variables: ['nombre', 'ruta', 'monto'],
    preview: 'Hola {nombre}, tu cotización ABSTORAGES está lista. Ruta {ruta} desde ${monto} MXN. ¿Deseas que SARA te llame para detalles?',
  },
  {
    id: 'seguimiento_entrega',
    nombre: 'Seguimiento Post-Entrega',
    agente: 'sofia',
    descripcion: 'Confirma entrega y solicita retroalimentación',
    variables: ['nombre', 'folio'],
    preview: 'Hola {nombre}, confirmamos la entrega de tu servicio {folio}. ¿Todo llegó en perfectas condiciones? Tu opinión nos ayuda a mejorar.',
  },
  {
    id: 'recordatorio_pago',
    nombre: 'Recordatorio de Pago',
    agente: 'sara',
    descripcion: 'Recordatorio amistoso de saldo pendiente',
    variables: ['nombre', 'monto', 'vencimiento'],
    preview: 'Hola {nombre}, te recordamos un saldo pendiente de ${monto} MXN con vencimiento el {vencimiento}. Responde para agendar tu pago.',
  },
  {
    id: 'reactivacion_cliente',
    nombre: 'Reactivación de Cliente',
    agente: 'sara',
    descripcion: 'Campaña para clientes inactivos con oferta especial',
    variables: ['nombre', 'descuento'],
    preview: '¡Hola {nombre}! Te extrañamos en ABSTORAGES. Por ser cliente preferente, tenemos un {descuento}% de descuento en tu próximo servicio. ¿Platicamos?',
  },
];

// ─── Estado de campañas en memoria ───────────────────────────────────────────
const campaigns = new Map();

function getTemplates() {
  return TEMPLATES;
}

function generateId() {
  return 'BC-' + Date.now().toString(36).toUpperCase();
}

// Delay helper para rate-limit (1 msg / 200ms = 5 msg/seg, seguro en 360dialog)
const delay = ms => new Promise(r => setTimeout(r, ms));

async function runCampaign(id) {
  const c = campaigns.get(id);
  if (!c) return;

  c.status    = 'running';
  c.startedAt = Date.now();

  for (let i = 0; i < c.destinatarios.length; i++) {
    if (c.status === 'cancelled') break;

    const dest = c.destinatarios[i];
    try {
      const componentes = [{
        type: 'body',
        parameters: dest.variables.map(v => ({ type: 'text', text: String(v) })),
      }];
      await whatsapp.enviarTemplate(dest.telefono, c.template, componentes);
      c.results.push({ nombre: dest.nombre, telefono: dest.telefono, status: 'ok', ts: Date.now() });
      c.sent++;
    } catch (err) {
      c.results.push({ nombre: dest.nombre, telefono: dest.telefono, status: 'error', error: err.message, ts: Date.now() });
      c.errors++;
    }

    c.progress = Math.round(((i + 1) / c.destinatarios.length) * 100);

    // Rate-limit entre mensajes
    if (i < c.destinatarios.length - 1) await delay(200);
  }

  c.status     = c.status === 'cancelled' ? 'cancelled' : 'done';
  c.finishedAt = Date.now();
}

function startCampaign({ template, destinatarios }) {
  const id = generateId();
  const c = {
    id,
    template,
    total:        destinatarios.length,
    sent:         0,
    errors:       0,
    progress:     0,
    status:       'starting',
    destinatarios,
    results:      [],
    createdAt:    Date.now(),
    startedAt:    null,
    finishedAt:   null,
  };
  campaigns.set(id, c);
  runCampaign(id).catch(err => {
    c.status   = 'error';
    c.errorMsg = err.message;
  });
  return id;
}

function getCampaign(id)   { return campaigns.get(id) || null; }
function cancelCampaign(id) {
  const c = campaigns.get(id);
  if (c && c.status === 'running') c.status = 'cancelled';
}
function listCampaigns() {
  return [...campaigns.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map(({ destinatarios: _, ...rest }) => rest); // omit full list for performance
}

module.exports = { startCampaign, getCampaign, cancelCampaign, listCampaigns, getTemplates };
