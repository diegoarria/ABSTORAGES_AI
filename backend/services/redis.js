require('dotenv').config();
const Redis = require('ioredis');

const CHANNELS = {
  NUEVA_ORDEN: 'nueva_orden',
  UNIDADES_DISPONIBLES: 'unidades_disponibles',
  ACTIVIDAD: 'actividad',
};

let publisher = null;
let subscriber = null;

function createPublisher() {
  if (publisher) return publisher;
  publisher = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  publisher.on('error', (err) => console.error('[Redis Publisher] Error:', err));
  publisher.on('connect', () => console.log('[Redis] Publisher conectado'));
  return publisher;
}

function createSubscriber() {
  if (subscriber) return subscriber;
  subscriber = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  subscriber.on('error', (err) => console.error('[Redis Subscriber] Error:', err));
  subscriber.on('connect', () => console.log('[Redis] Subscriber conectado'));
  return subscriber;
}

async function publicarNuevaOrden(datosServicio) {
  const pub = createPublisher();
  const payload = JSON.stringify({
    evento: CHANNELS.NUEVA_ORDEN,
    timestamp: new Date().toISOString(),
    ...datosServicio,
  });
  await pub.publish(CHANNELS.NUEVA_ORDEN, payload);
  console.log(`[Redis] nueva_orden publicada — folio: ${datosServicio.folio}`);
}

async function publicarUnidadesDisponibles(unidades) {
  const pub = createPublisher();
  const payload = JSON.stringify({
    evento: CHANNELS.UNIDADES_DISPONIBLES,
    timestamp: new Date().toISOString(),
    unidades,
  });
  await pub.publish(CHANNELS.UNIDADES_DISPONIBLES, payload);
  console.log('[Redis] unidades_disponibles publicadas');
}

async function publicarActividad(agente, tipo, mensaje, metadata = {}) {
  const pub = createPublisher();
  const payload = JSON.stringify({
    evento: CHANNELS.ACTIVIDAD,
    agente,
    tipo,
    mensaje,
    metadata,
    timestamp: new Date().toISOString(),
  });
  await pub.publish(CHANNELS.ACTIVIDAD, payload);
}

function suscribirNuevaOrden(handler) {
  const sub = createSubscriber();
  sub.subscribe(CHANNELS.NUEVA_ORDEN, (err) => {
    if (err) console.error('[Redis] Error suscribiendo a nueva_orden:', err);
    else console.log('[Redis] SOFIA suscrita a nueva_orden');
  });
  sub.on('message', (channel, message) => {
    if (channel === CHANNELS.NUEVA_ORDEN) {
      try {
        handler(JSON.parse(message));
      } catch (e) {
        console.error('[Redis] Error parseando nueva_orden:', e);
      }
    }
  });
}

function suscribirUnidadesDisponibles(handler) {
  const sub = createSubscriber();
  sub.subscribe(CHANNELS.UNIDADES_DISPONIBLES, (err) => {
    if (err) console.error('[Redis] Error suscribiendo a unidades_disponibles:', err);
    else console.log('[Redis] SARA suscrita a unidades_disponibles');
  });
  sub.on('message', (channel, message) => {
    if (channel === CHANNELS.UNIDADES_DISPONIBLES) {
      try {
        handler(JSON.parse(message));
      } catch (e) {
        console.error('[Redis] Error parseando unidades_disponibles:', e);
      }
    }
  });
}

function suscribirActividad(handler) {
  const sub = createSubscriber();
  sub.subscribe(CHANNELS.ACTIVIDAD, (err) => {
    if (err) console.error('[Redis] Error suscribiendo a actividad:', err);
  });
  sub.on('message', (channel, message) => {
    if (channel === CHANNELS.ACTIVIDAD) {
      try {
        handler(JSON.parse(message));
      } catch (e) {
        console.error('[Redis] Error parseando actividad:', e);
      }
    }
  });
}

module.exports = {
  CHANNELS,
  createPublisher,
  createSubscriber,
  publicarNuevaOrden,
  publicarUnidadesDisponibles,
  publicarActividad,
  suscribirNuevaOrden,
  suscribirUnidadesDisponibles,
  suscribirActividad,
};
