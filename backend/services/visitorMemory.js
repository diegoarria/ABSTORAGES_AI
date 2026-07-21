// Memoria persistente por visitante — identifica clientes que regresan al widget de SARA
const fs   = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '../../data/visitors');

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function safeName(vid) {
  return vid.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function load(vid) {
  ensureDir();
  const fp = path.join(DIR, `${safeName(vid)}.json`);
  if (!fs.existsSync(fp)) {
    return { visitorId: vid, sessions: [], createdAt: Date.now(), lastSeenAt: Date.now() };
  }
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return { visitorId: vid, sessions: [], createdAt: Date.now(), lastSeenAt: Date.now() }; }
}

function save(v) {
  ensureDir();
  v.lastSeenAt = Date.now();
  fs.writeFileSync(path.join(DIR, `${safeName(v.visitorId)}.json`), JSON.stringify(v, null, 2));
}

// Actualiza el perfil del visitante con datos nuevos capturados por SARA
function update(vid, data) {
  const v = load(vid);
  const keep = (old, nuevo) => (nuevo && nuevo !== '—' && nuevo !== null) ? nuevo : old;

  if (data.nombre)   v.nombre   = keep(v.nombre,   data.nombre);
  if (data.empresa)  v.empresa  = keep(v.empresa,  data.empresa);
  if (data.telefono) v.telefono = keep(v.telefono, data.telefono);
  if (data.email)    v.email    = keep(v.email,    data.email);
  if (data.origen)   v.origen   = keep(v.origen,   data.origen);
  if (data.destino)  v.destino  = keep(v.destino,  data.destino);

  // Registrar la sesión si es nueva
  if (data.sessionId) {
    const already = v.sessions.some(s => s.sessionId === data.sessionId);
    if (!already) {
      v.sessions.push({
        sessionId: data.sessionId,
        date:      new Date().toISOString(),
        resumen:   data.resumen || '',
      });
      if (v.sessions.length > 30) v.sessions = v.sessions.slice(-30);
    }
  }
  save(v);
  return v;
}

// Genera el bloque de contexto que se inyecta en el prompt de SARA
function buildContext(vid) {
  const v = load(vid);
  const lines = [];

  if (v.nombre)   lines.push(`- Nombre: ${v.nombre}`);
  if (v.empresa)  lines.push(`- Empresa: ${v.empresa}`);
  if (v.telefono) lines.push(`- Teléfono: ${v.telefono}`);
  if (v.email)    lines.push(`- Email: ${v.email}`);
  if (v.origen && v.destino) lines.push(`- Ruta conocida: ${v.origen} → ${v.destino}`);

  const visitas = v.sessions.length;

  // Si no hay datos y es la primera vez, no inyectar nada
  if (!lines.length && visitas === 0) return null;

  const ultima = v.lastSeenAt
    ? new Date(v.lastSeenAt).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
    : null;

  return [
    `[CLIENTE RECURRENTE — ${visitas} conversación${visitas !== 1 ? 'es' : ''} previa${visitas !== 1 ? 's' : ''}]`,
    ...lines,
    ultima ? `- Último contacto: ${ultima}` : '',
    `INSTRUCCIÓN: Salúdalo por su nombre desde el inicio si lo conoces. No le preguntes datos que ya tenemos. Hazle saber sutilmente que lo recuerdas.`,
    `[FIN CLIENTE RECURRENTE]`,
  ].filter(Boolean).join('\n');
}

module.exports = { load, update, buildContext };
