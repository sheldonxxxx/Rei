#!/bin/sh
# The onboarding CLI (run it where docker runs; see apps/cli/src/main.ts).
exec node "$(dirname "$0")/apps/cli/src/main.ts" "$@"
