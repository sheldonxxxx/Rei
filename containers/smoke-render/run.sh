#!/usr/bin/env bash
# Runs the render checks (smoke.ts: rendering and the red-team suite) once per engine, in a throwaway container of the
# reader image on a throwaway internal docker network (no route out), so the engine meets exactly the proxy, job tokens
# and extractor the reader ships with. Needs rei/reader:dev built (docker build -f containers/reader/Dockerfile -t
# rei/reader:dev .). Every attempt must fail on both engines, or the engine does not ship. Exits 1 on any FAIL.
#   containers/smoke-render/run.sh [moli|chromium ...]     default: both
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
engines=("$@")
[ ${#engines[@]} -gt 0 ] || engines=(moli chromium)
network="reader-smoke-net"
docker network rm "$network" >/dev/null 2>&1 || true
docker network create --internal "$network" >/dev/null
trap 'docker network rm "$network" >/dev/null 2>&1 || true' EXIT
status=0
for engine in "${engines[@]}"; do
  echo "== $engine"
  # root, because the fixture site listens on port 80; the container is thrown away.
  docker run --rm --network "$network" --user 0 -e SMOKE_ENGINE="$engine" \
    -v "$here/smoke.ts:/app/apps/reader/smoke-render.ts:ro" \
    -w /app/apps/reader --entrypoint node rei/reader:dev smoke-render.ts || status=1
done
exit "$status"
