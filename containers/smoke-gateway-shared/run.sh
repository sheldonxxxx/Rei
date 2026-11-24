#!/usr/bin/env bash
# Checks the gateway as another service sees it (docs/gateway-callers.md), on the running stack (run it on the machine
# where docker runs, from any directory):
#   containers/smoke-gateway-shared/run.sh           routes, tokens and scopes; makes no model call
#   containers/smoke-gateway-shared/run.sh --model <id>   also one small model call, with no upstream header
# It creates a caller named smoke-<random>, calls the shared listener from a throwaway container on the shared network,
# and revokes the caller when it ends. The token goes to that container in its environment and is never printed.
# Prints PASS/FAIL lines only. Exit status 1 if anything failed. REI_PROJECT=<name> targets another compose project.
set -uo pipefail
cd "$(dirname "$0")/.."
shared=(docker compose --env-file .env --env-file .secrets/secrets.env -f compose.dodai.yaml)
[[ -n ${REI_PROJECT:-} ]] && shared+=(-p "$REI_PROJECT-dodai")
model=""
[[ ${1:-} == --model ]] && model=${2:-}
failures=0
report() { # description, "ok" or anything else
  if [[ $2 == ok ]]; then echo "PASS  $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi
}
callers() { "${shared[@]}" exec -T gateway node src/cli.ts callers "$@" 2>&1; }

id=$("${shared[@]}" ps -q gateway 2>/dev/null)
[[ -n $id ]] || { echo "FAIL  the gateway is running: run ./rei start"; exit 1; }
image=$(docker inspect -f '{{.Config.Image}}' "$id")
ports=$(docker port "$id" 2>/dev/null | grep -c .)
report "the gateway publishes no port to the host" "$([[ $ports == 0 ]] && echo ok)"

caller="smoke-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
token=$(callers add "$caller" --note "smoke test" | tail -n 1)
report "a caller can be created" "$([[ $token == gw."$caller".* ]] && echo ok)"
trap 'callers revoke "$caller" >/dev/null' EXIT

# One line per check from inside the shared network: "<name> <observed>".
out=$(docker run --rm --network rei-gateway-shared -e SMOKE_TOKEN="$token" -e SMOKE_MODEL="$model" \
  -v "$PWD/smoke-gateway-shared/probe.mjs:/probe.mjs:ro" --entrypoint node "$image" /probe.mjs 2>&1)
expect() { # description, check name, expected value
  local seen
  seen=$(printf '%s\n' "$out" | awk -v k="$2" '$1 == k { print $2 }')
  report "$1" "$([[ $seen == "$3" ]] && echo ok)"
  [[ $seen == "$3" ]] || echo "      saw: ${seen:-nothing}"
}
expect "the shared listener answers /healthz without a token" healthz 200
expect "the full app does not listen on the shared network" internal-port blocked
expect "/status is not served there" status 404
expect "caller administration is not served there, even with a token" callers 404
expect "connectors are not served there, even with a token" mcp 404
expect "a model route refuses a call without a token (401 bad_token)" no-token 401:bad_token
expect "a model route refuses a wrong token" wrong-token 401:bad_token
expect "a search with the caller's token is answered" search 200
expect "a provider that is not connected has no upstream (400 missing_upstream)" unknown-provider 400:missing_upstream
[[ -n $model ]] && expect "a Responses request to $model with no upstream header is answered" model 200

callers set "$caller" --search 0 >/dev/null
out=$(docker run --rm --network rei-gateway-shared -e SMOKE_TOKEN="$token" -e SMOKE_ONLY=search \
  -v "$PWD/smoke-gateway-shared/probe.mjs:/probe.mjs:ro" --entrypoint node "$image" /probe.mjs 2>&1)
expect "a budget of 0 turns search off for the caller (403)" search 403

usage=$(callers usage --since 1h)
report "the caller's calls are recorded under its name" "$([[ $usage == *"$caller"* ]] && echo ok)"

callers revoke "$caller" >/dev/null
trap - EXIT
out=$(docker run --rm --network rei-gateway-shared -e SMOKE_TOKEN="$token" -e SMOKE_ONLY=search \
  -v "$PWD/smoke-gateway-shared/probe.mjs:/probe.mjs:ro" --entrypoint node "$image" /probe.mjs 2>&1)
expect "a revoked token is refused" search 401

echo
if [[ $failures == 0 ]]; then echo "all checks passed"; else echo "$failures check(s) failed"; exit 1; fi
