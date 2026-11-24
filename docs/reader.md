# The shared web reader

One service reads web pages for everything on this machine: it fetches a URL, follows redirects within the hosts the caller allowed, and returns the page as Markdown with its sections. Rei's `web_fetch` is its first caller: it keeps no fetch, extraction or browser code of its own (see "How Rei calls it" below). The decisions behind it are in [ADR 0020](adr/0020-web-reading-is-a-shared-service.md). How a model sees a page is in [web-reading.md](web-reading.md).

## Where it runs

The reader is a service of Dodai · 土台’s compose project `dodai` (`containers/compose.dodai.yaml`), next to the gateway, so it keeps running while Rei is stopped. Nothing calls it directly: callers use `POST /read` on the gateway, which checks the token, the `read` scope and the caller's budget, and forwards the request over the `reader-internal` network (no route out).

| Network           | Members                | Route out |
| ----------------- | ---------------------- | --------- |
| `reader-internal` | gateway, reader (`10.89.236.2`) | no |
| `reader-egress`   | reader                 | yes       |

The reader fetches pages through its own forward proxy, bound to loopback inside the container. The proxy resolves names itself and refuses special addresses, the subnets of the reader's own interfaces and the stack's networks (`READER_REFUSE_CIDRS`); only ports 80 and 443 are allowed. A page on the local network is reachable only when the request names `localNetworks` and the gateway has checked the caller holds `read-local`.

## `POST /read`

Through the gateway; see [gateway-callers.md](gateway-callers.md#reading-a-page) for the route, scope and budget. The request:

| Field          | Meaning |
| -------------- | ------- |
| `url`          | http or https, ports 80 and 443, at most 2,000 characters, no credentials |
| `allowHosts`   | the hosts the caller's policy already allowed (the start host at least); a redirect to any other host is handed back |
| `render`       | `auto` (default: render a page that needs JavaScript or came back thin), `off` or `force` (browser directly, without an HTTP preflight) |
| `localNetworks`| `"none"` (default), `"all"` or a list of addresses and networks; anything else needs `read-local` |
| `maxRedirects` | the caller's remaining hops, 0 to 5 (default 5) |
| `stepId`       | ties the read to the caller's step in logs (also the `x-rei-step-id` header) |

The answer has `outcome: "page" | "redirect" | "failed"`. A `redirect` carries the absolute `location` and `hops`, the redirects taken in this call including that one. The caller decides whether the new host is allowed, adds it to `allowHosts` and calls again with `maxRedirects` reduced by `hops`. A `failed` answer is a normal `200`: `message` says what happened in words for a model, `quality` says why when the page is blocked or needs JavaScript. A malformed request is `400 bad_request`.

## How Rei calls it

`web_fetch` calls `/read` through the gateway with Rei's own token (`REI_STANDIN`, which holds `read-local`). It always sends `render: "force"` to go directly to Moli (with the configured engine fallback). It sends `allowHosts` from its own policy, turns the agent's network setting into `localNetworks`, and handles `redirect` answers itself: check the new host with the agent's policy, add it to `allowHosts`, call again with fewer hops. It shows the reader's `details` (engine, fallback, slot wait, time) in the step's Fetch section. Nothing Rei-specific lives in the reader: another caller with a `read` token gets the same behavior.

Log fields in Rei's control plane for a read: `web.fetch` (debug) and `web.fetch_failed` (info) carry `host`, `redirects`, `quality`, `extractor`, `method` (`http` or `render`), `sections`, `durationMs` and, on a failure, `renderReason`. They never carry the URL or the text. The reader's own lines are listed below; the `stepId` is the same on both sides.

## Rendering

A page that is an app shell, or whose fetched text is only its summary or embedded data, is opened in a browser and read after its script has run. Two engines can do it, tried in the order of `READER_ENGINES` (default `moli,chromium`):

- **Moli** (a pinned release binary, checksum-verified in the image) is the first choice. It runs as one process per render, so a render leaves nothing behind.
- **Chromium** (the Debian package) is the fallback: one long-lived headless process with a browser context per render.

Both are driven over the DevTools protocol with the same rules: all traffic goes through the reader's own proxy under the render's token, images, media and fonts are failed before they are requested, service workers, WebRTC and WebSockets are removed, downloads are denied, and a main-frame navigation to a host outside `allowHosts` ends the render with the `redirect` answer. A render keeps nothing but the HTML read back.

**Fallback.** The second engine runs when the first fails (`failed`), still shows an app shell (`requires_js`) or only a summary (`thin`). A blocked page, a stopped navigation, an HTTP error, a cancelled read and a busy engine never fall back. The better of the two results wins (quality, then text). If both renders give nothing, the fetched page is returned when it had something to read, with `details.render.failed`.

**Slots.** Each engine runs `READER_RENDER_SLOTS` renders at once (2), shared fairly between callers. A read waits up to 30 seconds for a slot, then answers that the browser is busy.

**Shadow comparison.** With probability `READER_SHADOW_RATE` (0.1) a Moli success is also rendered by Chromium after the answer was sent, only if a Chromium slot is free. The shadow result is recorded and never returned.

**Attempt rows.** Every render attempt is a row in `render_attempts` (SQLite, `${READER_DATA}/reader.db`, kept 180 days): read id, caller, engine and version, role (`primary`, `fallback`, `shadow`), trigger, outcome, quality, text size, time, slot wait, proxy connections and refusals, the full URL and host, the fallback reason and whether the result was used. The full URL lives only there: the service log carries the host. Log events: `read.request` (debug), `read.render`, `read.fallback`, `read.shadow`.

### Is Chromium still needed?

```sh
./rei reader stats [--since 30d]
```

shows per-engine counts and p50/p95 render time, fallbacks by reason, the rescue rate (reads the fallback turned from failed or thin into better, over primary renders), the hosts rescued most, and the shadow divergence (pairs where Chromium read better, or at least 20% more text). `GET /stats?since=30d` on the reader returns the same numbers as JSON.

The decision rule: after at least 30 days and 500 primary renders, with a rescue rate below 1% and a shadow divergence below 2%, propose setting `READER_ENGINES=moli` and taking Chromium out of the image. Until then both stay.

### Red-team suite

`containers/smoke-render/run.sh [moli|chromium]` runs the hostile-page checks (loopback and private addresses, redirects, service workers, WebSockets, WebRTC, downloads, state left between renders, leftover processes) against one engine in a throwaway container on an internal network. Run it once per engine whenever an engine version changes.

## Limits

15 seconds for the fetch, 5 MiB of body, 5 redirects, 2,000 characters of URL; a render has 20 seconds and keeps at most 5 MiB of HTML, and a render's proxy budget is 200 connections and 50 MiB. The text kept per page is capped at 2,000,000 characters.

## Settings

`READER_PORT` (8790), `READER_HOST`, `READER_PROXY_PORT` (3129, loopback), `READER_DATA` (`/data`), `READER_REFUSE_CIDRS`, `READER_ENGINES`, `READER_RENDER_SLOTS`, `READER_SHADOW_RATE`, `READER_MOLI_PATH`, `READER_CHROMIUM_PATH` (compose passes the first three from `REI_READER_ENGINES`, `REI_READER_RENDER_SLOTS`, `REI_READER_SHADOW_RATE`), `REI_READER_LOG_LEVEL` (compose; falls back to `REI_LOG_LEVEL`).

## Checking it

`./rei status` and `./rei doctor` list the reader with the other Dodai services. `docker compose -f containers/compose.dodai.yaml logs reader` shows its log.
