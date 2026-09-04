// ── Crea/actualiza el único usuario del panel de monitoring ──────────────────
// Uso: node monitoring/scripts/createAdminUser.js <usuario> <contraseña>
const { upsertUser } = require('../lib/adminAuth');

const [, , username, password] = process.argv;
if (!username || !password) {
  console.error('Uso: node monitoring/scripts/createAdminUser.js <usuario> <contraseña>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('La contraseña debe tener al menos 8 caracteres.');
  process.exit(1);
}

upsertUser(username, password);
console.log(`[monitoring] Usuario "${username}" creado/actualizado en monitoring/data/admin-users.json`);
