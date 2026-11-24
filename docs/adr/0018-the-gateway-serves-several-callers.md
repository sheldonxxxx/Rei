# The gateway serves several callers, and runs as its own compose project

Status: accepted (2026-11-15). Implemented with the change that added this file; the outside contract was checked on a live stack by `containers/smoke-gateway-shared/run.sh`.

The gateway holds the model sign-ins, the search keys and the embedding endpoint. A second service on the same machine that needs a model would otherwise hold its own copy of a sign-in, and two holders of one subscription refresh each other's tokens out from under each other and cannot see each other's usage. So the gateway becomes something more than one service may call. It had one token that opened every route, and its safety rested on only Rei's control plane being able to reach it.

## Decisions

- **A caller is a named client of the gateway**: an id, scopes, a budget and a token. Rei is the caller `rei`. There are no kinds of caller and no priority between them; only their settings differ.
- **Scopes decide routes, in one place, default deny.** `models` is `/v1/*`, `search` is `POST /search`, `embeddings` is `/embedding/*`, and `admin` is everything else that needs a token (the call log, callers, provider and search setup, connectors, push). `admin` cannot be granted: only `rei` has it. A bad token is `401 bad_token`; a good token without the scope is `403 route_not_allowed`.
- **Rei's token stays in the environment** (`REI_STANDIN`). The control plane and the gateway already read that one value; moving it into the caller store would make two copies to keep in step. The API cannot rotate or revoke it.
- **Outside callers live in the gateway's secret store.** A token is `gw.<id>.<random>`, shown once when it is made; only its SHA-256 is kept. Rotation keeps the old token working for a grace period (24 hours unless told otherwise). Changes apply without a restart.
- **A budget is a cap on calls in flight**, per caller: one cap per model provider, one for search, one for embeddings. A cap of 0 turns that thing off for the caller. A new outside caller gets 1 call in flight per provider and 2 each for search and embeddings; Rei has no caps unless `GATEWAY_REI_BUDGET` sets them. A call over its cap is refused at once with `429 caller_concurrency`, `retry-after`, and `x-rei-refused-by: gateway` so it can be told apart from an upstream's own 429. Nothing queues, and nothing is remembered about an upstream's limits.
- **A capped call may not run for ever.** A call that holds a slot is cut after `GATEWAY_CAPPED_CALL_MAX_MS` (10 minutes by default), so a stuck stream cannot hold a caller's only slot.
- **Every call record carries the caller and the provider**, and embedding calls are now recorded. Pruning keeps 30 days and a row limit per caller, so one busy caller cannot push out another's history. `GET /calls?stepId=` answers only with the asking caller's rows.
- **Two listeners, one process.** The internal listener serves every route and is where Rei's control plane connects. The shared listener serves `/healthz`, `/v1/*`, `/search` and `/embedding/*` and answers 404 to everything else whatever the token, so the admin routes are not reachable from the shared network at all, rather than reachable and refused.
- **The gateway is its own compose project** (`containers/compose.dodai.yaml`, project `dodai`). It owns two internal networks: `rei-gateway-admin`, which Rei's control plane joins, and `rei-gateway-shared`, which other compose projects join. Stopping or redeploying Rei leaves the gateway serving other callers. Rei's own project (`containers/compose.yaml`) no longer contains it, and `./rei` starts the Dodai project first and waits for it, because compose cannot order services across projects.
- **An outside caller may leave out the upstream header.** With no `x-rei-upstream`, a call for `openai` goes to `https://api.openai.com/v1/` and a call for a saved custom provider goes to its saved base URL. Any other provider needs the header.

## Considered and not done

- **Priority for Rei, or a reserve of the subscription for chat.** Dropped by the owner: every caller is treated the same. A caller that should not crowd Rei gets a low cap.
- **A separate gateway per service.** Each would hold its own sign-in, which is the problem this solves.
- **Publishing the gateway on a host port.** A network other projects join gives the same reach on one machine without putting a credential-holding service on an address other machines can try. Reaching it from another machine is left for when it is needed.
- **Moving Garage and Qdrant to the Dodai project.** They hold Rei's own data and have one caller. They move when a second caller exists. (Done: [ADR 0021](0021-storage-is-a-dodai-service.md).)
- **A web page for callers.** They change rarely; `./rei callers` is enough, and the admin routes are there for a page later.

## Consequences

- The reason Rei's token is safe is no longer "nothing else can reach the gateway". It is that the token is long and random, the admin routes are not served on the shared network, and Rei's egress proxy refuses both gateway subnets, so nothing an agent drives can reach either listener.
- The gateway's two addresses are fixed (`10.89.235.2`, `10.89.234.2`) because it binds its listeners to them. A second container of the same service cannot start beside it, so one-off gateway commands use `docker compose exec`, not `run`.
- An installation from before the split keeps its gateway data: the Dodai project mounts the volume under the name it had. Compose prints a warning that the volume was created for another project; it is expected.
- `bad_standin` is now `bad_token`. The control plane and the gateway are deployed together, so nothing else reads the old code.
