#!/usr/bin/env bash
# Xvfb and the DevTools forwarder, as the non-root user "browser". Chromium runs only while a client is connected: the
# forwarder starts it on a connection (wake.sh) and the loop at the end stops it when none has been open for a while.
# Nothing restarts it on its own. Environment:
#   BROWSER_PROXY   the egress proxy's browser listener (http://10.89.232.3:3129); unset: a dead end, so no direct traffic
#   BROWSER_SCREEN  the virtual display (default 1280x900x24)
#   BROWSER_IDLE_STOP_S  seconds with no client before Chromium is stopped (default 60)
set -u
export DISPLAY=:99
mkdir -p /tmp/.X11-unix /tmp/runtime && chmod 1777 /tmp/.X11-unix && chmod 700 /tmp/runtime
export XDG_RUNTIME_DIR=/tmp/runtime

Xvfb :99 -screen 0 "${BROWSER_SCREEN:-1280x900x24}" -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
for _ in $(seq 1 100); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done

# Preferences, only if the profile has none yet: no password manager, no autofill. The agent never sees stored secrets and
# Chromium never offers to save the ones you type in a takeover.
if [ ! -e /profile/Default/Preferences ]; then
  mkdir -p /profile/Default
  printf '%s' '{"credentials_enable_service":false,"profile":{"password_manager_enabled":false,"password_manager_leak_detection":false},"autofill":{"profile_enabled":false,"credit_card_enabled":false},"safebrowsing":{"enabled":false}}' >/profile/Default/Preferences
fi

# Chromium accepts DevTools connections from loopback only; this re-exposes the port on the container address. Each
# connection runs wake.sh, which starts Chromium if it is not running and relays to it.
socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 EXEC:/usr/local/bin/wake.sh >/tmp/socat.log 2>&1 &
FORWARDER=$!


# Stop Chromium when no client has been connected for BROWSER_IDLE_STOP_S. Clients are the forwarder's child processes
# (one per connection). A clean SIGTERM exit writes the profile (cookies, logins); SIGKILL only if it hangs.
IDLE_STOP="${BROWSER_IDLE_STOP_S:-60}"
# Anchored at the start so it matches Chromium's main process, not the shell that waits for it (whose command line
# carries the same flags).
PATTERN='^/usr/lib/chromium/chromium .*remote-debugging-port=922[2]'
idle=0
while true; do
  sleep 5
  if ! kill -0 "$FORWARDER" 2>/dev/null; then echo "forwarder exited" >&2; exit 1; fi
  if pgrep -P "$FORWARDER" >/dev/null || ! pgrep -f "$PATTERN" >/dev/null; then idle=0; continue; fi
  idle=$((idle + 5))
  [ "$idle" -lt "$IDLE_STOP" ] && continue
  (
    exec 9>/tmp/chromium.lock
    flock 9
    pgrep -P "$FORWARDER" >/dev/null && exit 0   # a client arrived while this waited for the lock
    touch /tmp/chromium-stop-planned
    pkill -TERM -f "$PATTERN"
    for _ in $(seq 1 100); do pgrep -f "$PATTERN" >/dev/null || exit 0; sleep 0.1; done
    pkill -KILL -f "$PATTERN"
  )
  idle=0
done
