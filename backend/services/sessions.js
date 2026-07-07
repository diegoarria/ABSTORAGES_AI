const crypto = require('crypto');

const SECRET  = process.env.SESSION_SECRET || 'abstorages-dev-secret-2025';
const TTL_MS  = 7 * 24 * 60 * 60 * 1000; // 7 días

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token) {
  if (!token) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (Date.now() - payload._ts > TTL_MS) return null;
    return payload;
  } catch { return null; }
}

function create(user) {
  return sign({ ...user, _ts: Date.now() });
}

function get(token) {
  return verify(token);
}

function destroy(_token) {
  // Con JWT stateless no hay nada que borrar en servidor.
  // El cliente borra la cookie.
}

module.exports = { create, get, destroy };
