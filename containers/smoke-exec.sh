#!/usr/bin/env bash
# Checks the sandbox wiring on the running stack (run it on the machine where docker runs, from any directory):
#   containers/smoke-exec.sh
# The control plane can ssh into exec with its mounted key and the pinned host key; the sandbox is locked down; exec cannot
# reach the control plane, the gateway or the internet directly, and the egress proxy answers there. Prints PASS/FAIL
# lines only, never a key or a token. Exit status 1 if anything failed. REI_ENV_DIR, REI_PROJECT and REI_NET pick
# the stack the way ./rei does (stack-env.sh).
set -uo pipefail
source "$(dirname "$0")/stack-env.sh"
cd "$(dirname "$0")"
failures=0
report() { # description, "ok" or anything else
  if [[ $2 == ok ]]; then echo "PASS  $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi
}

# Runs $1 in exec the way the control plane does: ssh with the client key from /run/exec-keys, host key pinned from the
# mounted public key (a known_hosts file built here, nothing scanned). Prints the remote output; exit status is ssh's.
control_ssh() {
  "${compose[@]}" exec -T control sh -c '
    kh=$(mktemp)
    printf "[exec]:2222 %s\n" "$(cut -d" " -f1,2 /run/exec-keys/host_ed25519_key.pub)" > "$kh"
    ssh -i /run/exec-keys/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
      -o UserKnownHostsFile="$kh" -o ConnectTimeout=5 -p 2222 agent@exec "$1"
    status=$?
    rm -f "$kh"
    exit $status
  ' sh "$1" 2>&1
}

running=$("${compose[@]}" ps --status running --services 2>/dev/null | grep -cE '^(control|exec|egress)$')
report "control, exec and egress are running" "$([[ $running == 3 ]] && echo ok)"

out=$(control_ssh 'echo "$(id -un):$(id -u)"')
report "control reaches exec over ssh as agent (uid 1000) with the pinned host key" "$([[ $out == "agent:1000" ]] && echo ok)"

# A different pinned key must be refused: proves StrictHostKeyChecking is in force.
if "${compose[@]}" exec -T control sh -c '
  kh=$(mktemp)
  ssh-keygen -q -t ed25519 -N "" -f "$kh.k"
  printf "[exec]:2222 %s\n" "$(cut -d" " -f1,2 "$kh.k.pub")" > "$kh"
  ssh -i /run/exec-keys/id_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$kh" \
    -o ConnectTimeout=5 -p 2222 agent@exec true
  status=$?
  rm -f "$kh" "$kh.k" "$kh.k.pub"
  exit $status' >/dev/null 2>&1; then report "ssh with a wrong pinned host key is refused" fail; else report "ssh with a wrong pinned host key is refused" ok; fi

# Hardening, seen from inside the sandbox.
out=$(control_ssh 'f=/workspace/.smoke.$$; touch "$f" && rm "$f" && echo writable')
report "/workspace is writable" "$([[ $out == writable ]] && echo ok)"
out=$(control_ssh 'touch /etc/.smoke 2>/dev/null && echo writable || echo read-only')
report "the root filesystem is read-only" "$([[ $out == read-only ]] && echo ok)"
out=$(control_ssh 'cp /bin/true /tmp/.smoke; bash -c /tmp/.smoke 2>/dev/null && echo ran || echo blocked; rm -f /tmp/.smoke')
report "/tmp is noexec" "$([[ $out == blocked ]] && echo ok)"
out=$(control_ssh 'grep -E "^(Cap(Eff|Bnd)):" /proc/self/status | tr -d "\t" | tr "\n" " "')
report "exec has no capabilities" "$([[ $out == "CapEff:0000000000000000 CapBnd:0000000000000000 " ]] && echo ok)"

# No direct way out: every one of these must fail from inside exec (name does not resolve, no route, or refused).
for destination in control:8787 gateway:8780 $net.235.2:8780 $net.234.2:8781 $net.231.10:8787 example.com:443 1.1.1.1:443; do
  out=$(control_ssh "timeout 6 bash -c 'exec 3<>/dev/tcp/${destination%:*}/${destination#*:}' >/dev/null 2>&1 && echo reached || echo blocked")
  report "exec cannot reach $destination directly" "$([[ $out == blocked ]] && echo ok)"
done

# The proxy is the way out, and it asks for credentials, then the control plane (a made-up token is not a running task).
out=$(control_ssh "curl -s -o /dev/null -m 8 -w '%{http_code}' -x http://egress:3128 http://example.com/")
report "the egress proxy answers 407 without a token" "$([[ $out == 407 ]] && echo ok)"
out=$(control_ssh "curl -s -o /dev/null -m 8 -w '%{http_connect}' -x http://run:not-a-token@egress:3128 https://example.com/")
report "the egress proxy refuses (403) a token the control plane does not know" "$([[ $out == 403 ]] && echo ok)"

echo
if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "all checks passed"
