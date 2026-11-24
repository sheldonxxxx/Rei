#!/usr/bin/env bash
# Checks that a caller's storage is its own, on the running stack (docs/gateway-callers.md#storage, docs/adr/0021). Run it
# on the machine where docker runs, from any directory:
#   containers/smoke-storage/run.sh        (containers/smoke-storage.sh runs it too)
# It makes a caller named smoke-<random> with ./rei callers add --storage, uses its Garage key from a throwaway container
# that joins rei-storage-shared and an ordinary bridge network (as a real caller's container does), then rotates and
# revokes the caller and deletes its bucket. It also checks what that network and the agent's paths (the sandbox's
# egress proxy, the browser listener, the page reader) can and cannot reach. Keys go to the container in its environment
# and are never printed. Prints PASS/FAIL lines only. Exit status 1 if anything failed. REI_PROJECT=<name> targets
# another compose project.
set -uo pipefail
cd "$(dirname "$0")/.."
repo=$(pwd)/..
project=${REI_PROJECT:-rei}
shared=(docker compose --env-file .env --env-file .secrets/secrets.env -f compose.dodai.yaml)
[[ -n ${REI_PROJECT:-} ]] && shared+=(-p "$REI_PROJECT-dodai")
failures=0
report() { # description, "ok" or anything else
  if [[ $2 == ok ]]; then echo "PASS  $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi
}
rei() { "$repo/rei" "$@" 2>&1; }

gid=$("${shared[@]}" ps -q gateway 2>/dev/null)
garage=$("${shared[@]}" ps -q garage 2>/dev/null)
[[ -n $gid && -n $garage ]] || { echo "FAIL  the gateway and Garage are running: run ./rei start"; exit 1; }
image=$(docker inspect -f '{{.Config.Image}}' "$gid")
probe="$PWD/smoke-storage/probe.mjs"
garage_ip() { docker inspect -f "{{(index .NetworkSettings.Networks \"$1\").IPAddress}}" "$garage"; }
shared_ip=$(garage_ip rei-storage-shared)
admin_ip=$(garage_ip rei-storage)

caller="smoke-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
bucket="caller-$caller"
reader_caller="$caller-r"
cleanup() {
  rei callers revoke "$caller" >/dev/null
  rei callers revoke "$reader_caller" >/dev/null
  rei callers purge "$caller" --yes >/dev/null
  rei callers purge "$reader_caller" --yes >/dev/null
}
trap cleanup EXIT

out=$(rei callers add "$caller" --note "storage smoke test" --storage)
key_id=$(printf '%s\n' "$out" | awk '$1 == "key" && $2 == "id" { print $3 }')
secret=$(printf '%s\n' "$out" | awk '$1 == "secret" { print $2 }')
report "a caller can be given storage" "$([[ $key_id == GK* && -n $secret && $out == *"bucket $bucket"* ]] && echo ok)"
[[ $key_id == GK* ]] || { echo "FAIL  no key was issued, so nothing else can be checked"; exit 1; }

# Runs the probe in a container on rei-storage-shared plus the default bridge: "<check> <observed>" lines.
run_probe() { # network..., then env assignments are taken from the PROBE_ENV array
  local name="smoke-storage-probe-$$-$RANDOM" nets=("$@") args=() e
  for e in "${PROBE_ENV[@]}"; do args+=(-e "$e"); done
  docker create --name "$name" --network "${nets[0]}" "${args[@]}" -v "$probe:/probe.mjs:ro" --entrypoint node "$image" /probe.mjs >/dev/null || return 1
  for n in "${nets[@]:1}"; do docker network connect "$n" "$name" >/dev/null; done
  docker start -a "$name" 2>&1
  docker rm -f "$name" >/dev/null 2>&1
}
seen() { printf '%s\n' "$out" | awk -v k="$1" '$1 == k { print $2 }'; }
expect() { # description, check name, expected value
  local got
  got=$(seen "$2")
  report "$1" "$([[ $got == "$3" ]] && echo ok)"
  [[ $got == "$3" ]] || echo "      saw: ${got:-nothing}"
}

echo "---- the caller's key ----"
PROBE_ENV=(SMOKE_MODE=access SMOKE_KEY_ID="$key_id" SMOKE_SECRET="$secret" SMOKE_BUCKET="$bucket")
out=$(run_probe rei-storage-shared bridge)
expect "it writes to its own bucket" put-own 200
expect "it reads its object back" get-own 200
expect "the bytes are the ones it wrote" read-back match
expect "it lists its own bucket" list-own 200
expect "the listing holds its object" list-contains-object yes
expect "ListBuckets shows only its own bucket" list-buckets "200:$bucket"
expect "it cannot read Rei's bucket (403)" get-rei 403
expect "it cannot write to Rei's bucket (403)" put-rei 403
expect "it cannot list Rei's bucket (403)" list-rei 403
expect "it cannot create a bucket (403)" create-bucket 403
expect "it can delete its own object" delete-own 204

echo "---- Rei's key ----"
out=$(docker run --rm --network rei-storage-shared --env-file .secrets/secrets.env -e SMOKE_MODE=rei -e SMOKE_BUCKET="$bucket" -v "$probe:/probe.mjs:ro" --entrypoint node "$image" /probe.mjs 2>&1)
expect "Rei's key cannot read the caller's bucket (403)" rei-get-caller 403
expect "Rei's key cannot list the caller's bucket (403)" rei-list-caller 403
expect "Rei's key cannot write to the caller's bucket (403)" rei-put-caller 403
expect "Rei's key cannot create a bucket (403)" rei-create-bucket 403

echo "---- what the caller's network reaches ----"
targets="control-ip=10.89.231.10:8787,control=control:8787,admin-name=rei-garage:3903,admin-ip=$admin_ip:3903,rpc=rei-garage:3901,qdrant=rei-qdrant:6333,qdrant-grpc=rei-qdrant:6334,qdrant-ip=10.89.237.3:6333,storage-net=$admin_ip:3900,s3=rei-garage:3900"
# On rei-storage-shared alone: that is what an internal network guarantees. A container that is also on an ordinary
# bridge network may reach every container's address on some hosts (OrbStack routes between bridge networks), whatever
# these networks say; that is the host's behaviour, and it is the same for Rei's other internal networks. The keys, the
# API key and the admin token still apply there. The note below shows whether this host does it.
PROBE_ENV=(SMOKE_MODE=net SMOKE_TARGETS="$targets")
out=$(run_probe rei-storage-shared)
expect "it cannot reach Rei's control plane by address" control-ip blocked
expect "it cannot reach control by name" control blocked
expect "it cannot reach Garage's admin port by name" admin-name blocked
expect "it cannot reach Garage's admin port by address" admin-ip blocked
expect "it cannot reach Garage's RPC port" rpc blocked
expect "it cannot reach Qdrant (6333)" qdrant blocked
expect "it cannot reach Qdrant (6334)" qdrant-grpc blocked
expect "it cannot reach Qdrant by address" qdrant-ip blocked
expect "it cannot reach Garage on Rei's storage network" storage-net blocked
expect "it reaches S3 on rei-garage:3900" s3 reached
out=$(run_probe rei-storage-shared bridge)
[[ $(seen qdrant-ip) == reached ]] && echo "note  this host routes between bridge networks: a caller container that also has an ordinary bridge network reaches container addresses directly (Rei's own internal networks too); only keys and tokens protect them there"

echo "---- the agent's paths ----"
refuse="rei-garage:3900=rei-garage:3900,garage-shared-ip=$shared_ip:3900,garage-storage-ip=$admin_ip:3900,qdrant-ip=10.89.237.3:6333"
PROBE_ENV=(SMOKE_MODE=connect SMOKE_PROXY=egress:3128 SMOKE_TARGETS="$refuse")
out=$(run_probe "${project}_exec-net")
for check in rei-garage:3900 garage-shared-ip garage-storage-ip qdrant-ip; do
  got=$(seen "$check")
  report "the sandbox's proxy refuses $check" "$([[ $got != 200 && -n $got ]] && echo ok)"
  [[ $got != 200 && -n $got ]] || echo "      saw: ${got:-nothing}"
done
PROBE_ENV=(SMOKE_MODE=connect SMOKE_PROXY=10.89.232.3:3129 SMOKE_TARGETS="$refuse")
out=$(run_probe "${project}_browser-net")
for check in rei-garage:3900 garage-shared-ip garage-storage-ip qdrant-ip; do
  got=$(seen "$check")
  report "the browser listener refuses $check" "$([[ $got != 200 && -n $got ]] && echo ok)"
  [[ $got != 200 && -n $got ]] || echo "      saw: ${got:-nothing}"
done
read_token=$(rei callers add "$reader_caller" --note "storage smoke test" --scopes read,read-local | tail -n 1)
PROBE_ENV=(SMOKE_MODE=read SMOKE_TOKEN="$read_token" SMOKE_URL="http://$shared_ip/")
out=$(run_probe rei-gateway-shared)
expect "the page reader refuses Garage as one of the stack's own networks, even when local networks are allowed" read 200:failed:refused

echo "---- rotate and revoke ----"
out=$(rei callers rotate "$caller" --storage)
new_id=$(printf '%s\n' "$out" | awk '$1 == "key" && $2 == "id" { print $3 }')
new_secret=$(printf '%s\n' "$out" | awk '$1 == "secret" { print $2 }')
report "rotate issues a new key" "$([[ $new_id == GK* && $new_id != "$key_id" && -n $new_secret ]] && echo ok)"
PROBE_ENV=(SMOKE_MODE=refused SMOKE_KEY_ID="$key_id" SMOKE_SECRET="$secret" SMOKE_BUCKET="$bucket")
out=$(run_probe rei-storage-shared bridge)
expect "the old key is refused after rotate (403)" refused 403
PROBE_ENV=(SMOKE_MODE=refused SMOKE_KEY_ID="$new_id" SMOKE_SECRET="$new_secret" SMOKE_BUCKET="$bucket")
out=$(run_probe rei-storage-shared bridge)
expect "the new key works" refused 200
rei callers revoke "$caller" >/dev/null
out=$(run_probe rei-storage-shared bridge)
expect "the new key is refused after revoke (403)" refused 403
list=$(rei callers list)
report "revoke keeps the bucket and shows no key in the list" "$([[ $list == *"$caller  storage $bucket  no key (revoked)"* ]] && echo ok)"
out=$(rei callers purge "$caller" --yes)
report "purge deletes the empty bucket" "$([[ $out == *"$bucket deleted"* ]] && echo ok)"
list=$(rei callers list)
report "the bucket is gone from the list" "$([[ $list != *"storage $bucket"* ]] && echo ok)"
trap - EXIT
rei callers revoke "$reader_caller" >/dev/null

echo
if [[ $failures == 0 ]]; then echo "all caller storage checks passed"; else echo "$failures caller storage check(s) failed"; exit 1; fi
