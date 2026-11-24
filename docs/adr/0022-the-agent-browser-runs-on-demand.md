# The agent browser runs on demand

Status: accepted (2026-11-17).

The `browser` container ran Chromium all the time, about 210 MiB while idle, and restarted it whenever it exited. A window closed only when another chat took its slot, its chat was deleted or the browser restarted, and the agent has no close tool, so a finished or crashed run left its window behind. "No windows left" never happened.

## Decisions

- **Chromium runs on demand.** The container stays up with Xvfb and the DevTools forwarder (a few MiB). The forwarder runs `wake.sh` for each connection, which starts Chromium under a lock and relays to it. A loop in the entrypoint stops Chromium (SIGTERM, then SIGKILL after 10 s) once no connection has been open for `BROWSER_IDLE_STOP_S` (default 60). A clean stop writes the profile, so logins survive. Nothing restarts Chromium on its own; a crash closes the windows as a restart, and the next browser call wakes it again.
- **Windows close after an idle time.** `REI_BROWSER_IDLE_MS` (default 60 minutes, `0` disables). Only Rei's own use counts: a tool call, takeover input, or a window that is busy (a call in flight, a running run, an open takeover, a live-view viewer) at a cleanup check. Events from the page (navigation, refresh, dialogs) do not, so a self-refreshing page cannot keep the browser alive. The check runs every 60 s under the lock that window creation and eviction use.
- **The agent is told, not given a new page.** A window closed for idleness or eviction leaves a reason the next browser call returns; `browser_open` clears it. Nothing reopens on its own.
- **The control plane lets go.** When the last window closes (idle, deleted chat, closed by the user) the driver disconnects without a warning (`driver.release()`), so the container sees no client. An eviction keeps the connection, because the window it makes room for opens at once. The next open reconnects through the driver's existing backoff, which covers Chromium's cold start.
- **The Docker socket stays out of the control plane.** Stopping Chromium from Rei would need it, and it is close to root on the host and a deployment detail Rei must not carry. The container stops its own Chromium instead.
- **The healthcheck no longer touches Chromium**: it checks the display and the forwarder only, because a probe through the forwarder would wake Chromium every few seconds.

## Consequences

- The first browser call after an idle period waits a few seconds for Chromium to start.
- The agent loses a page after an hour without use; it must open it again.
- `containers/smoke-browser.sh` checks the sleep, wake, idle stop and that a cookie survives a stop.
