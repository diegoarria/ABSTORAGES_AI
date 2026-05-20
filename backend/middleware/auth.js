const sessions = require('../services/sessions');

const PUBLIC_PATHS = ['/login', '/api/login', '/api/logout', '/webhook/whatsapp', '/favicon.ico'];

function parseCookie(header, name) {
  if (!header) return null;
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return match ? match[1] : null;
}

function auth(req, res, next) {
  if (PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p + '?'))) return next();

  const sessionId = parseCookie(req.headers.cookie, 'abs_session');
  const user = sessions.get(sessionId);

  if (!user) {
    const wantsHtml = req.headers.accept?.includes('text/html') && req.method === 'GET';
    return wantsHtml
      ? res.redirect('/login?next=' + encodeURIComponent(req.originalUrl))
      : res.status(401).json({ error: 'No autenticado' });
  }

  req.user = user;
  next();
}

module.exports = auth;
