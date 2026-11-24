#!/usr/bin/env bash
# The ADR 0017 spike. Runs spike.mjs in a throwaway container on the stack's browser-net, against the running browser container, and checks
# that the real egress proxy saw none of the render's traffic. Needs the local stack up (containers/compose.yaml).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
status=0
docker run --rm --network rei_browser-net --user 0 -v "$here:/spike:ro" --entrypoint node rei/control:dev /spike/spike.mjs || status=$?
echo "--- egress lines that mention the spike hosts since $since (expect none):"
docker logs --since "$since" rei-egress-1 2>&1 | grep -E 'spike|169\.254|10\.89\.232\.10' || echo "(none)"
exit $status
