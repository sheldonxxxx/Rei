#!/usr/bin/env bash
# Run by the DevTools forwarder (socat EXEC) for every connection on port 9223: starts Chromium if it is not running,
# waits until its DevTools port answers, then relays the connection to it. Starting and stopping Chromium hold the same
# lock (/tmp/chromium.lock), so two Chromiums never meet on the profile.
set -u
export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime}"
LOCK=/tmp/chromium.lock
# Anchored at the start so it matches Chromium's main process, not the shell that waits for it (whose command line
# carries the same flags).
PATTERN='^/usr/lib/chromium/chromium .*remote-debugging-port=922[2]'

devtools_up() { (exec 3<>/dev/tcp/127.0.0.1/9222) 2>/dev/null; }

exec 9>"$LOCK"
flock 9
if ! pgrep -f "$PATTERN" >/dev/null; then
  # A profile lock names the machine that took it, so one left by a container we replaced blocks Chromium from starting at
  # all. No Chromium is running here, so any lock that is left is stale.
  rm -f /profile/SingletonLock /profile/SingletonSocket /profile/SingletonCookie /tmp/chromium-stop-planned
  PROXY="${BROWSER_PROXY:-http://127.0.0.1:1}"
  CHROME_FLAGS=(
    --user-data-dir=/profile
    --remote-debugging-port=9222
    --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
    --no-first-run --no-default-browser-check --password-store=basic
    --disable-session-crashed-bubble --hide-crash-restore-bubble
    --disable-dev-shm-usage --no-sandbox
    "--proxy-server=$PROXY" "--proxy-bypass-list=<-loopback>"
    --disable-background-networking --disable-component-update --disable-sync --disable-default-apps --disable-extensions
    --disable-client-side-phishing-detection --no-pings --deny-permission-prompts
    --disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication
    # Playwright 1.64.1 can report "Invalid frame in aria-ref selector" after a cache restore.
    # A restore also revives a document the ref generations treat as gone. Remove this flag only when both are handled.
    --disable-back-forward-cache
    --window-size=1280,900
  )
  # Detached from this connection, and without the lock's file descriptor (or the lock would stay held while it runs).
  setsid bash -c '
    chromium "$@" about:blank >>/tmp/chromium.log 2>&1
    code=$?
    planned=no; [ -e /tmp/chromium-stop-planned ] && planned=yes
    echo "$(date +%s) chromium exited with $code (planned: $planned)" >>/tmp/chromium-restarts.log
  ' chromium "${CHROME_FLAGS[@]}" </dev/null >/dev/null 2>&1 9>&- &
fi
for _ in $(seq 1 150); do devtools_up && break; sleep 0.1; done
exec 9>&-
exec socat - TCP:127.0.0.1:9222
