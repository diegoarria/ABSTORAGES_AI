// Horario en el que SOFIA puede contactar proveedores por su cuenta (hora de
// Monterrey). Fuera de horario todo se queda en cola y sale al abrir la
// ventana, salvo órdenes marcadas como urgentes. Las acciones manuales de una
// persona desde Base de Datos no pasan por aquí — ahí decide la persona.
const INICIO = Number(process.env.SOFIA_HORARIO_INICIO || 8);
const FIN    = Number(process.env.SOFIA_HORARIO_FIN || 20);
const DIAS   = (process.env.SOFIA_HORARIO_DIAS || '1,2,3,4,5,6').split(',').map(Number); // 0=domingo
const LIBRE  = process.env.SOFIA_HORARIO_LIBRE === 'true';

function ahoraMTY(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Monterrey', weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  const dia = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { dia, hora: Number(p.hour) % 24 };
}

function permitido(urgente = false, d = new Date()) {
  if (urgente || LIBRE) return true;
  const { dia, hora } = ahoraMTY(d);
  return DIAS.includes(dia) && hora >= INICIO && hora < FIN;
}

module.exports = { permitido, INICIO, FIN, DIAS };
