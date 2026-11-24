#!/usr/bin/env bash
# Checks the browser wiring on the running stack (run it on the machine where docker runs, from any directory):
#   containers/smoke-browser.sh
# Chromium runs on demand: the container is healthy while it is asleep, a DevTools request starts it, and it stops after
# BROWSER_IDLE_STOP_S with no client (the last check waits for that, so the run takes over a minute). Chromium is hardened; the control plane reaches its DevTools port and the sandbox does not; the browser has no
# direct way out, and its one way out (the egress proxy's browser listener) answers with a decision, never a hang. It
# changes nothing and prints PASS/FAIL lines only. Exit status 1 if anything failed. REI_PROJECT=<name> targets
# another compose project.
set -uo pipefail
cd "$(dirname "$0")"
compose=(docker compose --env-file .env --env-file .secrets/secrets.env -f compose.yaml)
[[ -n ${REI_PROJECT:-} ]] && compose+=(-p "$REI_PROJECT")
failures=0
report() { # description, "ok" or anything else
  if [[ $2 == ok ]]; then echo "PASS  $1"; else echo "FAIL  $1"; failures=$((failures + 1)); fi
}
in_browser() { "${compose[@]}" exec -T browser bash -c "$1" 2>&1; }
in_control() { "${compose[@]}" exec -T control sh -c "$1" 2>&1; }

running=$("${compose[@]}" ps --status running --services 2>/dev/null | grep -cE '^(control|browser|egress)$')
report "control, browser and egress are running" "$([[ $running == 3 ]] && echo ok)"

id=$("${compose[@]}" ps -q browser 2>/dev/null)
health=$([[ -n $id ]] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)
report "the browser container is healthy (display and forwarder up; the check does not wake Chromium)" "$([[ $health == healthy ]] && echo ok)"

# On demand: start from a stopped Chromium (stop it the way the idle stop does, if a client left it running).
stop_s=$("${compose[@]}" exec -T browser printenv BROWSER_IDLE_STOP_S 2>/dev/null | tr -d '\r'); stop_s=${stop_s:-60}
in_browser 'pkill -TERM -f "remote-debugging-port=922[2]"; sleep 3; pgrep -f "remote-debugging-port=922[2]" >/dev/null && echo up || echo down' >/dev/null
out=$(in_browser 'pgrep -c -f "remote-debugging-port=922[2]"; true')
report "chromium is not running while nobody is connected" "$([[ ${out:-0} == 0 ]] && echo ok)"
sleep 12
health=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)
report "the browser container stays healthy with no Chromium" "$([[ $health == healthy ]] && echo ok)"

# Hardening, seen from inside.
out=$(in_browser 'echo "$(id -un):$(id -u)"')
report "chromium runs as the browser user (uid 1000)" "$([[ $out == "browser:1000" ]] && echo ok)"
out=$(in_browser 'touch /etc/.smoke 2>/dev/null && echo writable || echo read-only')
report "the root filesystem is read-only" "$([[ $out == read-only ]] && echo ok)"
out=$(in_browser 'f=/profile/.smoke.$$; touch "$f" && rm "$f" && echo writable')
report "the profile volume is writable" "$([[ $out == writable ]] && echo ok)"
out=$(in_browser 'cp /bin/true /tmp/.smoke; /tmp/.smoke 2>/dev/null && echo ran || echo blocked; rm -f /tmp/.smoke')
report "/tmp is noexec" "$([[ $out == blocked ]] && echo ok)"
out=$(in_browser 'grep -E "^CapEff:" /proc/self/status | tr -d "\t"')
report "the browser has no capabilities" "$([[ $out == "CapEff:0000000000000000" ]] && echo ok)"
# A DevTools request starts Chromium (a few seconds), and a profile cookie set now must survive its next stop and start.
out=$(in_browser 'exec 3<>/dev/tcp/127.0.0.1/9223 && printf "GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n" >&3 && timeout 20 grep -q webSocketDebuggerUrl <&3 && echo started')
report "a DevTools request starts Chromium" "$([[ $out == started ]] && echo ok)"
out=$(in_browser 'ps -o user= -p "$(pgrep -o -f "remote-debugging-port=9222")" | tr -d " "')
report "chromium, once started, runs as the browser user" "$([[ $out == browser || $out == 1000 ]] && echo ok)"
out=$(in_browser 'pgrep -c -f "remote-debugging-port=9222"')
report "chromium is running with the DevTools port on loopback only" "$([[ ${out:-0} -ge 1 ]] && echo ok)"

# The DevTools port is the control plane's alone. Chromium refuses a Host header that is a name (DNS rebinding), so the
# name is resolved first, as the control plane's driver does.
out=$(in_control "node -e 'require(\"node:dns\").promises.lookup(\"browser\",{family:4}).then(({address})=>fetch(\"http://\"+address+\":9223/json/version\",{signal:AbortSignal.timeout(5000)})).then(async r=>console.log((await r.json()).Browser?\"cdp\":\"other\"),()=>console.log(\"blocked\"))'")
report "control reaches the DevTools port (browser:9223)" "$([[ $out == cdp ]] && echo ok)"
out=$("${compose[@]}" exec -T exec bash -c "timeout 6 bash -c 'exec 3<>/dev/tcp/browser/9223' >/dev/null 2>&1 && echo reached || echo blocked" 2>&1)
report "the sandbox cannot reach the DevTools port" "$([[ $out == blocked ]] && echo ok)"

# No direct way out: nothing but the proxy listener is reachable, and Chromium itself has the proxy configured.
for destination in example.com:443 1.1.1.1:443 gateway:8780 10.89.235.2:8780 10.89.234.2:8781; do
  out=$(in_browser "timeout 6 bash -c 'exec 3<>/dev/tcp/${destination%:*}/${destination#*:}' >/dev/null 2>&1 && echo reached || echo blocked")
  report "the browser cannot reach $destination directly" "$([[ $out == blocked ]] && echo ok)"
done
out=$(in_browser 'tr "\0" " " < /proc/$(pgrep -o -f "remote-debugging-port=9222")/cmdline')
report "chromium is started with the egress listener as its proxy" "$([[ $out == *"--proxy-server=http://10.89.232.3:3129"* ]] && echo ok)"

# The listener decides every host with the control plane (an unknown or idle browser is refused: a 403 reply, not a hang).
# A CONNECT answered 200 means the browser is in use and the host was allowed; both are decisions.
out=$(in_browser "exec 3<>/dev/tcp/10.89.232.3/3129 && printf 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n' >&3 && timeout 8 head -n1 <&3")
report "the egress browser listener answers a CONNECT with a decision (got: ${out%%$'\r'*})" "$([[ $out == HTTP/1.1\ 200* || $out == HTTP/1.1\ 403* || $out == HTTP/1.1\ 407* || $out == HTTP/1.1\ 502* ]] && echo ok)"
# The user's own network is reachable through the listener, but the stack's own networks are not: a page must not reach
# Chromium's DevTools (10.89.232.2) or another container through the proxy. A literal address is refused before the control
# plane is asked, so the reply names the address rule whether or not the browser is in use (an idle refusal doesn't count).
for destination in 169.254.169.254:80 10.89.232.2:443 10.89.232.10:443 10.89.231.10:443; do
  out=$(in_browser "exec 3<>/dev/tcp/10.89.232.3/3129 && printf 'CONNECT $destination HTTP/1.1\r\nHost: $destination\r\n\r\n' >&3 && timeout 4 cat <&3")
  report "the egress browser listener refuses the address $destination" "$([[ $out == HTTP/1.1\ 403* && $out == *"own networks and to special addresses"* ]] && echo ok)"
done
# The sandbox's token proxy also listens on this address; without a token it is a 407, never a tunnel.
out=$(in_browser "exec 3<>/dev/tcp/10.89.232.3/3128 && printf 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n' >&3 && timeout 8 head -n1 <&3")
report "the token proxy gives the browser no tunnel without a token" "$([[ $out == HTTP/1.1\ 407* ]] && echo ok)"

# Idle stop and persistence: set a cookie over DevTools, close the connection, wait out the idle stop, wake Chromium
# again and read the cookie back. The DevTools helper runs in the control container (it has node and the route).
cdp() { # method, params-json -> the result as JSON on stdout
  in_control "node -e '
    const dns=require(\"node:dns\").promises;
    (async()=>{
      const {address}=await dns.lookup(\"browser\",{family:4});
      const v=await (await fetch(\"http://\"+address+\":9223/json/version\")).json();
      const ws=new WebSocket(v.webSocketDebuggerUrl.replace(/ws:\\/\\/[^/]+/,\"ws://\"+address+\":9223\"));
      ws.onopen=()=>ws.send(JSON.stringify({id:1,method:process.argv[1],params:JSON.parse(process.argv[2])}));
      ws.onmessage=(m)=>{const d=JSON.parse(m.data);if(d.id===1){console.log(JSON.stringify(d.result||d.error));ws.close();process.exit(0);}};
      setTimeout(()=>process.exit(1),15000);
    })();
  ' '$1' '$2'"
}
cdp Storage.setCookies '{"cookies":[{"name":"smoke","value":"kept","url":"https://smoke.invalid/","expires":4102444800}]}' >/dev/null
sleep $((stop_s + 15))
out=$(in_browser 'pgrep -c -f "remote-debugging-port=922[2]"; true')
report "chromium stops after ${stop_s} s with no client" "$([[ ${out:-1} == 0 ]] && echo ok)"
out=$(cdp Storage.getCookies '{}')
report "a cookie set before the stop is still there after the next start" "$([[ $out == *'"name":"smoke"'* && $out == *'"value":"kept"'* ]] && echo ok)"
cdp Storage.clearCookies '{}' >/dev/null

echo
if ((failures)); then echo "$failures check(s) failed"; exit 1; fi
echo "all checks passed"
