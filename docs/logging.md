# Service logs

Control, gateway and egress each write one JSON object per line to stdout. These logs are for running the stack: is it up, what failed, how slow was it. They are not the record of what an agent did. That is the **Trace** (Inspect in the web app), which holds prompts, tool calls and results, and which the user can see and which goes when its chat is deleted. Background jobs keep their latest error in their own status record (Memory, Knowledge and embedding settings show it).

## Line shape

```json
{
  "timestamp": "2026-11-08T09:12:03.411Z",
  "level": "debug",
  "service": "gateway",
  "event": "call",
  "stepId": "stp_01a1…",
  "model": "qwen3.8-flash",
  "method": "POST",
  "status": 200,
  "firstByteMs": 812,
  "totalMs": 2140,
  "inputTokens": 13225,
  "outputTokens": 99,
  "cachedInputTokens": 11264
}
```

- `timestamp`, `level`, `service` (`control`, `gateway`, `egress`) and `event` are on every line, and the logger sets them. A caller cannot overwrite them.
- Other fields depend on the event. The common ones are `requestId`, `runId`, `stepId`, `sessionId`, `durationMs`, `status`, `errorCode` and `errorClass`.
- There is no human-readable mode. Use `jq`:

```sh
docker compose -f containers/compose.yaml logs --no-log-prefix control egress | jq -c 'select(.level != "debug")'
docker compose -f containers/compose.dodai.yaml logs --no-log-prefix gateway | jq -c 'select(.level != "debug")'
```

The gateway is in its own compose project (`compose.dodai.yaml`), so its logs are asked for separately.

## Levels

| Level   | What it is for                                                    | Examples                                                                                |
| ------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `debug` | Routine success: one line per request, model call or allowed host | `http.request` 2xx/3xx, gateway `call` 2xx, `egress.allow`, `step.started`, `web.fetch` |
| `info`  | State changes and refusals                                        | sign-in, settings changed, `http.request` 4xx, `egress.deny`, `policy.denied`           |
| `warn`  | Something degraded that may recover                               | `http.request` 5xx, gateway `call` 429/5xx, embedder down, egress connect failure       |
| `error` | Something failed that needs a look                                | a worker crash, a failed notification, an internal error                                |

`REI_LOG_LEVEL` sets the lowest level written: `debug`, `info`, `warn` or `error`. The default is `info`. Each service reads it once at startup and refuses to start if the value is not a level. With Compose, `REI_LOG_LEVEL` sets all three services, and `REI_CONTROL_LOG_LEVEL`, `REI_GATEWAY_LOG_LEVEL` or `REI_EGRESS_LOG_LEVEL` overrides one:

```sh
REI_GATEWAY_LOG_LEVEL=debug docker compose --env-file containers/.env --env-file containers/.secrets/secrets.env \
  -f containers/compose.dodai.yaml -f containers/compose.dodai.build.yaml up -d gateway
```

That is for a checkout, where `compose.dodai.build.yaml` keeps the image built from source. An npm installation keeps its compose files in `REI_HOME` (default `~/.rei`) and has no build overlay: use `-f ~/.rei/compose.dodai.yaml` and the env files there instead. Putting the setting in `.env` and running `./rei start` (or `rei start`) does the same.

`debug` adds events, never content. Running at debug for a while is safe. It just makes more lines.

## What may appear in a line

Service logs carry ids, counts and codes, never free text (see [ADR 0003](adr/0003-service-logs-carry-codes-not-messages.md)). The shared logger in `packages/logging` enforces this for every field:

- A string value must be token-shaped: at most 128 characters of letters, digits, `_ . : / + -`, and no `://`. Anything else becomes `"[dropped]"`. That covers a sentence, an error message, an email address or a URL.
- Fields named `text`, `token`, `password`, `secret`, `authorization`, `cookie`, `body`, `content`, `message`, `prompt`, `url` or `query` are removed whatever their value.
- Strings shaped like credentials (bearer tokens, JWTs, `sk-…` keys) are redacted. The gateway also passes every string through its own redactor, which knows Rei's own gateway token and the provider credentials it holds. Caller tokens are never logged: the gateway stores only their hashes.

A `"[dropped]"` value in the logs means a call site passed free text. Fix the call site rather than loosening the logger.

## Errors

Log an error with `classifyError`, never with `error.message`:

```ts
import { classifyError } from "../util/log.ts"; // in the gateway and egress: from "@rei/logging"

log.warn("memory.embedder_down", classifyError(error));
```

It returns `errorCode` and `errorClass`. The code comes from the error's own `code` (`ECONNREFUSED`, also when fetch wraps it in `cause`), its `kind` and `status` (`upstream_502`), a SQLite result code (`sqlite_busy`), an abort or timeout, and otherwise `unknown`. `errorClass` is the error's class name.

When a failure shows up as `errorCode: "unknown"`, give it a code. Either throw an error with a stable `code` or `kind` property, or pass a classifier for your own error types:

```ts
classifyError(error, (e) => (e instanceof QuotaError ? "quota_exceeded" : undefined));
```

The message still belongs wherever the user needs it: in the Trace for agent work, or in the job's status record.

## Following one run

`stepId` is the one id that crosses services. Each model call is a step. The control plane sends the step id to the gateway with the model request and to the egress proxy with its own web fetches. Each service logs it:

- **gateway:** `call` and `search.attempt` lines.
- **egress:** `egress.allow` and `egress.deny` lines for the control plane's web fetches. Traffic from the sandbox and the agent's browser has no step id; for that, control logs `egress.allowed` and `egress.denied` with `runId`.
- **reader:** `read.request` (debug), `read.render`, `read.fallback` and `read.shadow`, with the host and the step id, never the URL.
- **control:** `step.started` (with `runId` and `sessionId`), `step.finished`, `web.fetch` and `web.search`. A web read logs `web.fetch` (debug) or `web.fetch_failed` (info) with `host`, `redirects`, `quality`, `extractor`, `method` (`http` or `render`), `sections` and, on a failure, `renderReason`.

Most of these lines are at `debug`, so run with `REI_LOG_LEVEL=debug` while you follow a run. Copy a step id from Inspect, or from any line, then:

```sh
STEP=stp_01a1b6dbcd2ef65ccda60a40
{ docker compose -f containers/compose.yaml logs --no-log-prefix control egress
  docker compose -f containers/compose.dodai.yaml logs --no-log-prefix gateway reader
} | jq -c "select(.stepId == \"$STEP\")"
```

To find a step's run, look at its `step.started` line, or open the step in Inspect. Every HTTP request to the control plane also gets its own `requestId` on its `http.request` and `http.error` lines. The server makes that id; an id sent by the client is ignored. Ids only label lines; they never authorize anything.

## Retention

Compose gives every service Docker's `local` log driver with `max-size: 10m` and `max-file: "5"`. That is at most five compressed 10 MB files per container, and the oldest lines go first. Logs from a removed container are gone, and recreating a container on redeploy also starts a fresh log. Rei does not ship logs anywhere else. If you need them longer, collect them from Docker on the host.

Check a container's settings with:

```sh
docker inspect --format '{{.HostConfig.LogConfig}}' rei-control-1
```

The gateway's call log (`calls.sqlite` in the gateway volume) is separate. It keeps one row per model, search, embedding or connector call, with the [caller](gateway-callers.md) and provider, codes only and no response bodies, and prunes old rows on its own (30 days, and a row limit per caller). The gateway's `call` log lines carry `caller` and `provider` too, and a call refused by a budget is a `budget.refused` line.
