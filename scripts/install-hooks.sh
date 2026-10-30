#!/bin/sh
# Instala el hook de pre-push localmente — hay que correr esto una vez por
# cada copia del repo (los hooks de git no se comparten solos vía git, cada
# quien tiene que instalarlo en su propia máquina).
HOOKS_DIR="$(git rev-parse --show-toplevel)/.git/hooks"
cp "$(git rev-parse --show-toplevel)/scripts/pre-push-hook.sh" "$HOOKS_DIR/pre-push"
chmod +x "$HOOKS_DIR/pre-push"
echo "Hook de pre-push instalado — cada 'git push' va a correr 'npm run smoke' primero."
