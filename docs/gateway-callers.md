# Gateway callers: letting another service use the gateway

The gateway holds the model sign-ins, the web search keys and the embedding endpoint. Rei is its first caller. Another service on the same machine can be a caller too, so it uses the same sign-in instead of holding a copy. This page is for the person who runs the stack and for whoever writes the other service. The decisions behind it are in [ADR 0018](adr/0018-the-gateway-serves-several-callers.md).

An outside caller gets models, web search, embeddings and web reading. It does not get Rei's connectors, push notifications, provider setup or call log.

## How it is deployed

The gateway and web reader run in Dodai · 土台, a compose project of its own, `dodai` (`containers/compose.dodai.yaml`), next to Rei's (`containers/compose.yaml`). Other services may depend on it, so it keeps running while Rei is stopped.

| Command                             | Rei's services | The gateway             |
| ----------------------------------- | -------------- | ----------------------- |
| `./rei start`, `./rei setup`        | started        | started first           |
| `./rei stop`, `./rei restart`       | acted on       | left running            |
| `./rei stop --all`, `restart --all` | acted on       | acted on too            |
| `./rei redeploy`                    | rebuilt        | rebuilt, recreated first (Garage and Qdrant only get a plain `up`, so callers' storage is not interrupted) |

`./rei status` and `./rei doctor` show both. To run compose by hand, name the right file; both need the two env files:

```sh
docker compose --env-file containers/.env --env-file containers/.secrets/secrets.env -f containers/compose.dodai.yaml logs gateway
```

The gateway has fixed addresses on its two networks, so a second container of it cannot start beside the first: use `exec` for one-off commands, not `run`. Sign in to a model provider in the web app (**Settings → Providers**).

On an installation from before the split, compose warns that the volume `rei_gateway-data` "already exists but was created for project rei". That is expected: the Dodai project mounts the existing volume so the sign-ins and the call log are kept.

### Renaming an existing shared stack

Dodai replaces the `rei-shared` project and `compose.shared.yaml`. Before the first start under the new name, stop outside callers and Rei, then remove the old project's containers and networks using the new file with the old project name:

```sh
docker compose --env-file containers/.env --env-file containers/.secrets/secrets.env -f containers/compose.dodai.yaml -p rei-shared down --remove-orphans
./rei start
```

Restart outside callers after Rei and Dodai are healthy. Do not add `--volumes`: the gateway and reader keep `rei_gateway-data` and `rei_reader-data`, including sign-ins, caller tokens and reader records. Compose may warn that these volumes belong to an older project; reusing them is intentional. The network names (`rei-gateway-admin`, `rei-gateway-shared`, `rei-reader-internal`) and caller address (`http://rei-gateway:8781`) also stay the same.

## Managing callers

```sh
./rei callers add reports --note "nightly reports"
./rei callers list
./rei callers set reports --provider openai=2 --search 0
./rei callers rotate reports            # the old token works for 24 hours more; --grace 0 ends it now
./rei callers revoke reports
./rei callers usage --since 7d
```

- `add` and `rotate` print the token once, on the last line. It cannot be read back; only its SHA-256 is stored.
- An id is lower-case letters, digits and hyphens. `rei` and `all` are reserved.
- `--scopes` takes any of `models`, `search`, `embeddings`, `read` and `read-local` (all but `read-local` by default). `read-local` lets a caller ask the reader to open addresses on the local network; only Rei holds it.
- Changes apply at once, with no restart.
- `usage` shows calls and tokens per caller and provider from the call log, and how often a budget refused a call since the gateway started. Permanent daily counters per caller (models, search, embeddings, page reads and budget refusals) are also kept in the gateway and shown in Rei's web app under **Settings → Usage** as one tab per caller plus an **All** tab.

Rei's own token is `REI_STANDIN` (it holds every scope, including `read-local`, and Rei reads all its pages through `POST /read`) in `containers/.secrets/secrets.env`. To change it, edit the file and run `./rei start`, which recreates the gateway and the control plane with the new value.

### Budgets

A budget caps how many calls a caller may have in flight at once. It is the only limit the gateway applies, and it is the same rule for every caller.

| Flag                     | Caps                                            | New caller |
| ------------------------ | ----------------------------------------------- | ---------- |
| `--provider <id>=<n>`    | calls in flight to that model provider          | not set    |
| `--default-provider <n>` | calls in flight to each provider not listed     | 1          |
| `--search <n>`           | searches in flight                              | 2          |
| `--embeddings <n>`       | embedding calls in flight                       | 2          |
| `--reads <n>`            | page reads in flight                            | 2          |

A value is 0 to 16, or `none` for no cap. 0 turns that off for the caller: `--provider openai=0` keeps a caller off the ChatGPT subscription, including subscription web search. Rei has no caps unless `GATEWAY_REI_BUDGET` is set in `containers/.env` to a JSON budget, for example `{"providers":{"openai":4}}`.

A call that holds a slot is cut after 10 minutes (`GATEWAY_CAPPED_CALL_MAX_MS`), so a stuck stream cannot hold a caller's only slot.

## Calling the gateway from another service

Join the shared network from the other project's compose file, and call `http://rei-gateway:8781`:

```yaml
services:
  worker:
    networks: [default, rei-gateway-shared]
networks:
  rei-gateway-shared:
    external: true
```

The network has no route out and reaches nothing of Rei's except the gateway's shared listener. The gateway must be up before the other project starts.

The names are the default stack's. [A second stack on the same machine](installation.md#a-second-stack-on-one-machine) prefixes its networks with its own `REI_PROJECT`: a caller of that stack joins `<REI_PROJECT>-gateway-shared` (and `<REI_PROJECT>-storage-shared` for storage) and is signed up with that stack's CLI (`REI_ENV_DIR=… ./rei callers …`). The alias `rei-gateway` and the address `http://rei-gateway:8781` are the same on both, because each stack's network is its own.

Send the token as `Authorization: Bearer <token>` on every call.

| Route                                 | Scope        | What it is                                                                 |
| ------------------------------------- | ------------ | -------------------------------------------------------------------------- |
| `GET /healthz`                        | none         | `200` when the gateway is up                                               |
| `/v1/*`                               | `models`     | Passed to the model provider, with the provider's credential added         |
| `POST /search`                        | `search`     | `{"query": "..."}`; results from the search providers set up in Rei        |
| `GET /embedding/v1/models`, `POST /embedding/v1/embeddings` | `embeddings` | The embedding endpoint set up in Rei, OpenAI-shaped       |
| `POST /read`                          | `read`       | One web page as text, through the shared reader ([docs/reader.md](reader.md)) |

Every other path answers `404` on this listener.

### Models

`/v1/<path>` goes to the provider named by the `x-rei-provider-id` header (`openai` when absent), at the same path.

- **`openai`** goes to `https://api.openai.com/v1/`. With a ChatGPT sign-in (not an API key) only the Responses API works, and it insists on a particular shape: `input` must be a list, `stream` must be `true` and `store` must be `false`. Chat Completions is refused by OpenAI for a subscription.
- **A custom provider** saved in Rei goes to its saved base URL. Name it by its id or by its name, both shown in Rei under **Settings → Providers**. A name is matched in any case, with a space written as `_`; an id always wins, and a name that two providers share answers `400 ambiguous_provider` (use the id).
- **Any other provider** needs `x-rei-upstream` set to the full upstream URL, which must be on the gateway's allowlist. Without it the answer is `400 missing_upstream`.

An OpenAI SDK works with the gateway as its base URL and the caller token as its API key:

```ts
const client = new OpenAI({ baseURL: "http://rei-gateway:8781/v1", apiKey: process.env.GATEWAY_TOKEN });
const stream = await client.responses.create({
  model: "<a model your sign-in offers>",
  input: [{ role: "user", content: "Hello" }],
  stream: true,
  store: false,
});
```

Optional: `x-rei-step-id` (up to 64 characters) is stored with the call record, to tie a call to the caller's own job.

### Reading a page

`POST /read` takes `{"url", "allowHosts", "render"?, "localNetworks"?, "maxRedirects"?}` and answers `200` with one of three shapes, told apart by `outcome`: `page` (the text, its sections and details), `redirect` (the page redirects to a host you did not list in `allowHosts`: decide, add the host and call again with `maxRedirects` reduced by `hops`) or `failed` (blocked, needs JavaScript, unreachable; `message` is written for a model). The caller owns the destination policy: the reader only fetches the hosts in `allowHosts`. `localNetworks` other than `"none"` needs the `read-local` scope. The full contract and the reader's limits are in [docs/reader.md](reader.md).

Errors the gateway adds for this route: `read_unavailable` (`503` when no reader is configured, `502` when it does not answer), plus the usual `bad_token`, `route_not_allowed` and `caller_concurrency`. A budget of 0 turns reading off for a caller.

### Errors the gateway itself returns

The body is `{"error": {"code", "message"}}`. A response from the gateway rather than the provider carries the header `x-rei-refused-by: gateway` when a budget refused it.

| Status | Code                    | Meaning                                                              | What to do                      |
| ------ | ----------------------- | -------------------------------------------------------------------- | ------------------------------- |
| 401    | `bad_token`             | Missing, wrong, revoked or expired token                             | Get a new token                 |
| 403    | `route_not_allowed`     | The token lacks the scope, or the budget for the route is 0          | Ask for the scope               |
| 403    | `provider_not_allowed`  | The caller's budget for this provider is 0                           | Use another provider            |
| 429    | `caller_concurrency`    | The caller already has its maximum calls in flight                   | Wait `retry-after` seconds, retry |
| 400    | `missing_upstream`      | No upstream is known for the provider                                | Send `x-rei-upstream`           |
| 403    | `upstream_not_allowed`  | The upstream URL is not on the allowlist                             | Use a connected provider        |

A `429` without `x-rei-refused-by` is the provider's own, passed through unchanged. A stream cut after the 10-minute ceiling ends early; the call record says `capped_call_timeout`.

## Storage

A caller that needs object storage can have its own bucket in Dodai's Garage. Storage is **not** behind the gateway: the caller talks S3 to Garage directly with its own key, and the key can use only its own bucket. The gateway never sees it and does not depend on it. (Qdrant is Dodai's too, but only Rei uses it for now; callers get Garage only.)

```sh
./rei callers add media --storage              # the gateway token, as above, then the storage credentials
./rei callers set media --storage              # an existing caller: grants storage; the gateway is not touched
./rei callers rotate media --storage           # a new storage key; the old one stops working at once
./rei callers revoke media                     # the gateway token and the storage key
./rei callers purge media                      # deletes the empty bucket of a revoked caller (asks you to type the id; --yes skips it)
./rei callers list                             # also one line per caller with storage
```

`add`, `set` and `rotate` print this once, and the secret is shown only when the key is made:

```text
Storage for media (network rei-storage-shared, external)
  S3        http://rei-garage:3900  region garage  path-style  bucket caller-media
  key id    GK…
  secret    …                         (shown once)
```

- **Connecting.** The caller's compose project joins `rei-storage-shared` (an `external: true` network named `rei-storage-shared`) and uses `http://rei-garage:3900`, region `garage`, with path-style addressing (`forcePathStyle`; virtual-host style is off). The network has no route out and carries only Garage's S3 port: the admin and RPC ports, Qdrant and Rei's control plane are not on it. Callers on it can reach each other's S3 port, so the key is what keeps a bucket private. Run `docker compose up` of the caller after `./rei start`, because Dodai creates the network.
- **What the key can do.** Read, write and list in `caller-<id>`. It cannot list other buckets, read or write `rei-files`, or create a bucket. Rei's own key cannot read a caller's bucket either, and no longer has `createBucket`.
- **Ids.** The id must also be a valid bucket name: lower-case letters, digits and hyphens, not starting or ending with a hyphen. The gateway also allows `_`, so an id with one cannot have storage. `rei` is reserved.
- **Where the credentials are kept.** Garage keeps the key, as signing needs it. Nothing is recorded on Rei's side and the gateway's caller store does not change. The caller puts the key id and secret in its own secrets, never in this repository. Run `set --storage` again to see the key id, and `rotate --storage` for a new secret.
- **Revoke and purge.** `revoke` deletes the key and keeps the bucket and its data. `purge` deletes the bucket only when it is empty and the caller is revoked; a non-empty bucket is refused and named. Emptying it is the caller's job.
- **Partial failure.** If storage fails after the gateway token was made, the CLI says what exists and to run `./rei callers set <id> --storage`. Every step can be repeated.
- **Behind the scenes.** The CLI runs `garage json-api` inside Dodai's garage container, which talks to the node over RPC. It needs no admin token, and the host CLI never reads a storage secret; the only secret it prints is the new key's own.
- **Backup.** Dodai's Garage volume holds every caller's bucket. A restore rolls all of them back together ([storage](storage.md#backup-and-recovery)).

## Checking it

```sh
containers/smoke-gateway-shared/run.sh                 # routes, tokens, scopes, budgets; no model call
containers/smoke-gateway-shared/run.sh --model <id>    # also one small model call
containers/smoke-storage/run.sh                        # a caller's storage is its own (also run by smoke-storage.sh)
```

The first creates a throwaway caller, calls the shared listener from a container on the shared network, and revokes the caller. The last makes a throwaway caller with storage, uses its key from a container on `rei-storage-shared`, checks what the key and the network can and cannot reach, rotates and revokes it, and deletes its bucket.

## What is not built

- Reaching the gateway or storage from another machine. The shared networks are local to the docker host.
- Qdrant for callers. Qdrant is on `rei-storage` for Rei only; callers get Garage only. A caller that needs vectors comes with its own access design (per-caller tokens, exact collection names).
- Storage quotas per caller, per-bucket restore, and emptying a caller's bucket for it.
- Priority between callers, or keeping part of a subscription for Rei. Give a caller a low cap instead.
- A page for managing callers (tokens, scopes and budgets) in the web app. Outside callers' usage and combined gateway totals are shown under **Settings → Usage**.
