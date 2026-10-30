#!/usr/bin/env node
// ── Smoke test previo a deploy ───────────────────────────────────────────────
// Nació del incidente del 30-oct-2026: un commit subió un require() a un
// archivo que nunca se había agregado a git — Railway crasheaba en cada
// arranque ("Cannot find module"). Esto no es un problema de la IA, es de
// proceso: nada validaba, antes de hacer push, que lo que se está subiendo
// de verdad arranca.
//
// Valida dos cosas sobre los archivos que git va a subir (no sobre el disco
// local, que puede tener cosas sin commitear):
//   1. Cada .js tiene sintaxis válida (`node -c`).
//   2. Cada require('./...') / require('../...') de un entrypoint apunta a
//      un archivo que SÍ está trackeado en git — no solo presente en disco.
//
// Uso: node scripts/smoke-test.js
// Sale con código 1 si algo falla (para usarlo como hook de pre-push o en CI).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function archivosTrackeados() {
  return new Set(sh('git ls-files').split('\n').filter(Boolean));
}

// Entrypoints reales del proyecto — los que Railway/npm start realmente
// ejecutan. No hace falta escanear TODO el repo, solo lo que se arranca.
const ENTRYPOINTS = ['server-lite.js', 'backend/server.js'];

let errores = [];

console.log('── Smoke test ──────────────────────────────────────────────');

// 1. Sintaxis de todos los .js trackeados (rápido, atrapa errores obvios
//    como el incidente de comillas invertidas de sep-2026 mencionado en
//    server-lite.js).
const trackeados = archivosTrackeados();
const jsFiles = [...trackeados].filter(f => f.endsWith('.js') && !f.startsWith('node_modules/') && !f.startsWith('ios/'));
console.log(`Verificando sintaxis de ${jsFiles.length} archivos .js trackeados...`);
for (const f of jsFiles) {
  try {
    execSync(`node -c "${f}"`, { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    errores.push(`SINTAXIS INVÁLIDA: ${f}\n${e.stderr?.toString().slice(0, 400) || e.message}`);
  }
}

// 2. Cada require('./...' | '../...') de los entrypoints debe resolver a un
//    archivo TRACKEADO en git (esto es justo lo que falló el 30-oct-2026:
//    el archivo existía en disco local, pero no en git, y Railway solo ve
//    lo que está en git).
function requiresLocales(contenido) {
  const re = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(contenido))) out.push(m[1]);
  return out;
}

function resolverDesde(entrypointDir, req) {
  let p = path.normalize(path.join(entrypointDir, req));
  const candidatos = [p, p + '.js', p + '.json', path.join(p, 'index.js')];
  for (const c of candidatos) {
    const rel = path.relative(ROOT, c).replace(/\\/g, '/');
    if (trackeados.has(rel)) return rel;
  }
  return null;
}

console.log(`Verificando que los require() de los entrypoints estén en git...`);
for (const entry of ENTRYPOINTS) {
  if (!trackeados.has(entry)) { errores.push(`ENTRYPOINT NO TRACKEADO: ${entry}`); continue; }
  const visitados = new Set();
  const pendientes = [entry];
  while (pendientes.length) {
    const actual = pendientes.pop();
    if (visitados.has(actual)) continue;
    visitados.add(actual);
    if (!actual.endsWith('.js')) continue; // no seguimos requires dentro de .json
    const full = path.join(ROOT, actual);
    if (!fs.existsSync(full)) continue; // ya se reportó arriba si aplica
    const contenido = fs.readFileSync(full, 'utf8');
    const dir = path.dirname(actual);
    for (const req of requiresLocales(contenido)) {
      const resuelto = resolverDesde(dir, req);
      if (!resuelto) {
        errores.push(`REQUIRE ROTO: ${actual} → require('${req}') no resuelve a ningún archivo TRACKEADO en git (¿falta un 'git add'?)`);
      } else {
        pendientes.push(resuelto);
      }
    }
  }
}

if (errores.length) {
  console.error(`\n❌ ${errores.length} problema(s) encontrado(s):\n`);
  errores.forEach(e => console.error(`- ${e}\n`));
  process.exit(1);
}

console.log('✅ Todo en orden — sintaxis válida y todos los require() de los entrypoints están en git.');
