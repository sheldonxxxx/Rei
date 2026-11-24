#!/bin/sh
# Creates, once, containers/.env, the shared secrets in containers/.secrets/secrets.env (mode 0600) and the external
# Docker volumes Dodai and Rei keep their data in. Existing values are never regenerated. The work is the CLI's
# (`./rei init`, apps/cli/src/init.ts, which documents every variable); this wrapper keeps the old command working.
# ./rei setup runs it for you. REI_PROJECT=<name> prefixes the volumes as it does for compose.
set -eu
exec node "$(dirname "$0")/../apps/cli/src/main.ts" init "$@"
