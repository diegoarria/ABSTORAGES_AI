#!/bin/sh
# Smoke test antes de cada push — instalado por scripts/install-hooks.sh.
# Bloquea el push si algo no arranca (ver scripts/smoke-test.js).
node "$(git rev-parse --show-toplevel)/scripts/smoke-test.js"
