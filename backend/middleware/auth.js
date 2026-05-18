require('dotenv').config();

function basicAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="ABSTORAGES AI Portal"');
    return res.status(401).json({ error: 'Autenticación requerida' });
  }

  const base64 = authHeader.slice(6);
  const decoded = Buffer.from(base64, 'base64').toString('utf8');
  const [username, password] = decoded.split(':');

  if (username === process.env.PORTAL_USERNAME && password === process.env.PORTAL_PASSWORD) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="ABSTORAGES AI Portal"');
  return res.status(401).json({ error: 'Credenciales inválidas' });
}

module.exports = basicAuth;
