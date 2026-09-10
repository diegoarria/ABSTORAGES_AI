// ─── DOMAIN LOCK — candado de dominio para el widget público ────────────────
// Punto 8 del checklist de Rafael: "vincular las IA al dominio ABSTORAGES —
// esto permite tener otro candado de seguridad adicional". Se aplica solo a
// las rutas del widget embebible (/api/widget/*, /widget/*) porque son las
// únicas que aceptan peticiones cross-origin (cors() abierto) — el resto del
// portal ya está protegido por el login de cookie (ver middleware/auth.js).
// Un navegador SIEMPRE manda el header Origin en una petición cross-origin;
// no puede falsificarlo. Si viene y no matchea el allowlist, se rechaza.
// Si no viene (llamada server-to-server, apps nativas, curl/Postman), se deja
// pasar — este candado corta el vector de "alguien embebe el widget en otro
// dominio para abusarlo", no reemplaza la autenticación real.
const DEFAULT_ALLOWED = [
  'https://abstorages.com',
  'https://www.abstorages.com',
  'https://abstoragesai-production.up.railway.app',
];

const ALLOWED = (process.env.ALLOWED_WIDGET_ORIGINS
  ? process.env.ALLOWED_WIDGET_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_ALLOWED
).concat(
  process.env.NODE_ENV !== 'production'
    ? ['http://localhost:3000', 'http://127.0.0.1:3000']
    : []
);

function domainLock(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next(); // sin Origin = no-browser, no es el vector que cubre este candado
  if (ALLOWED.includes(origin)) return next();
  console.warn(`[domainLock] Origin no permitido bloqueado: ${origin} → ${req.path}`);
  return res.status(403).json({ error: 'Origen no autorizado' });
}

module.exports = domainLock;
module.exports.ALLOWED = ALLOWED;
