#!/usr/bin/env bash
# Checks the storage and retrieval services (M11/M12), which are Dodai's (compose.dodai.yaml), on the running stack (run it
# on the machine where docker runs, from any directory):
#   containers/smoke-storage.sh
# Garage and Qdrant are healthy, publish no port, and are reachable from the control plane and from nothing else of
# Rei's; Qdrant is on no network outside rei-storage, and Garage's S3 port is the only thing on rei-storage-shared;
# then Rei's own Garage and Qdrant clients are run, from a container on rei-storage, against the live services. It
# creates its own objects and collections, deletes what it made, and prints no secrets. Exit status 1 if anything
# failed. REI_PROJECT=<name> targets another compose project. containers/smoke-storage/run.sh adds the caller checks.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
compose=(docker compose --env-file .env --env-file .secrets/secrets.env -f compose.yaml)
[[ -n ${REI_PROJECT:-} ]] && compose+=(-p "$REI_PROJECT")
# The gateway is in the shared services' project (compose.dodai.yaml).
shared=(docker compose --env-file .env --env-file .secrets/secrets.env -f compose.dodai.yaml)
[[ -n ${REI_PROJECT:-} ]] && shared+=(-p "$REI_PROJECT-dodai")
failures=0
report() { # description, "ok" or anything else
  if [[ $2 == ok ]]; then echo "PASS  $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi
}
in_service() {
  if [[ $1 == gateway || $1 == reader || $1 == garage || $1 == qdrant ]]; then "${shared[@]}" exec -T "$1" sh -c "$2" 2>/dev/null
  else "${compose[@]}" exec -T "$1" sh -c "$2" 2>/dev/null; fi
}
# Whether a container can open a TCP connection at all: two seconds, then no. (nc is in these images; /dev/tcp is not.)
reach() {
  in_service "$1" "nc -z -w 2 $2 $3 && echo yes || echo no"
}

running=$("${shared[@]}" ps --status running --services 2>/dev/null | grep -cE '^(garage|qdrant)$')
running=$((running + $("${compose[@]}" ps --status running --services 2>/dev/null | grep -cE '^control$')))
report "garage, qdrant (Dodai) and control are running" "$([[ $running == 3 ]] && echo ok)"
[[ $running == 3 ]] || { echo "FAIL  the stack is up: run ./rei setup (or containers/init.sh, then compose up for Dodai and Rei)"; exit 1; }

for svc in garage qdrant; do
  id=$("${shared[@]}" ps -q "$svc")
  health=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)
  report "$svc is healthy" "$([[ $health == healthy ]] && echo ok)"
  ports=$(docker port "$id" 2>/dev/null | grep -c .)
  report "$svc publishes no port to the host" "$([[ $ports == 0 ]] && echo ok)"
done

# Who can reach the private network. Of Rei's and Dodai's own services, nothing but the control plane should be able to.
# (Callers on rei-storage-shared reach Garage's S3 port only: containers/smoke-storage/run.sh checks that.)
for svc in gateway reader egress exec browser edge; do
  if [[ -n $("${compose[@]}" ps -q "$svc" 2>/dev/null)$("${shared[@]}" ps -q "$svc" 2>/dev/null) ]]; then
    report "$svc cannot reach rei-garage:3900" "$([[ $(reach "$svc" rei-garage 3900) == no ]] && echo ok)"
    report "$svc cannot reach rei-qdrant:6333" "$([[ $(reach "$svc" rei-qdrant 6333) == no ]] && echo ok)"
  fi
done
report "the control plane reaches rei-garage:3900" "$([[ $(reach control rei-garage 3900) == yes ]] && echo ok)"
report "the control plane reaches rei-qdrant:6333" "$([[ $(reach control rei-qdrant 6333) == yes ]] && echo ok)"
# Garage's admin and RPC ports are not on the callers' network, and Qdrant is not on it at all.
shared_net=rei-storage-shared
report "qdrant is not on $shared_net" "$([[ $(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$shared_net" 2>/dev/null) != *qdrant* ]] && echo ok)"

# Rei's own clients, against the live services, from inside the storage network.
network=rei-storage
repo=$(cd .. && pwd)
echo "---- Rei's Garage and Qdrant clients against the live services (on $network) ----"
docker run --rm --network "$network" \
  -v "$repo:/app:ro" \
  -e REI_GARAGE_ENDPOINT=http://rei-garage:3900 \
  -e REI_GARAGE_REGION=garage \
  -e REI_GARAGE_BUCKET=rei-files \
  -e REI_QDRANT_URL=http://rei-qdrant:6333 \
  --env-file "$repo/containers/.secrets/secrets.env" \
  node:24-alpine node --experimental-strip-types /app/containers/live-storage-check.ts
check=$?
report "Rei's own clients work against the live Garage and Qdrant" "$([[ $check == 0 ]] && echo ok)"

# What a caller's storage can and cannot do (makes and removes a temporary caller).
echo "---- a caller's storage ----"
"$here/smoke-storage/run.sh"
report "a caller's storage is its own (smoke-storage/run.sh)" "$([[ $? == 0 ]] && echo ok)"

echo
if [[ $failures == 0 ]]; then echo "all storage checks passed"; else echo "$failures storage check(s) failed"; fi
exit $((failures > 0 ? 1 : 0))
