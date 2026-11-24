# Architecture

Rei runs as a small Docker Compose stack on one machine. The control plane owns every decision; the other services each do one job and hold only the credentials that job needs.

```
             browser (you)
                  │  127.0.0.1:8787
                ┌─┴────┐
                │ edge │  reverse proxy, the only published port
                └─┬────┘
                  │
           ┌──────┴───────┐         ┌──────────┐
           │   control    │────────▶│ gateway  │──▶ model providers, embeddings,
           │ (apps/server)│         └──────────┘    web search, MCP, push
           └──┬────┬───┬──┘
   rei-storage│    │   │ commands / browsing
   (internal) │    │   └──────────────┐
      ┌───────┴┐ ┌─┴──────┐   ┌───────┴─┐  ┌─────────┐
      │ garage │ │ qdrant │   │  exec   │  │ browser │
      │  (S3)  │ │(vector)│   │ sandbox │  │Chromium │
      └────────┘ └────────┘   └────┬────┘  └────┬────┘
      (both are Dodai services)
                                   └─────┬──────┘
                                    ┌────┴───┐
                                    │ egress │──▶ internet (per-agent policy)
                                    └────────┘
```

| Service            | Source               | Role                                                                                                                  |
| ------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `control`          | `apps/server`        | Hono API, SQLite, agent runtime, memory, knowledge, library, triggers, traces.                                        |
| `web`              | `apps/web`           | React/Vite UI, served by control. Simple mode and Detail mode share the same components.                              |
| `gateway`          | `apps/gateway`       | Holds provider secrets and talks to model, embedding, search, MCP and push services. Control never sees raw API keys. |
| `exec`             | `containers/exec`    | Sandbox where agents run commands. No direct network; traffic goes through egress.                                    |
| `browser`          | `containers/browser` | Chromium for agent browsing, running only while used (windows close after an hour idle), with live takeover when an agent needs your help. |
| `egress`           | `apps/egress`        | Network proxy that enforces each agent's sandbox network mode and whitelist.                                          |
| `garage`, `qdrant` | upstream images      | In Dodai. File bytes (S3) and history-search indexes, on internal-only networks. Garage also holds each caller's bucket. |
| `cli`              | `apps/cli`           | The `./rei` onboarding and operations CLI.                                                                            |

The stack is two compose projects. `containers/compose.yaml` is Rei itself. `containers/compose.dodai.yaml` is Dodai · 土台 (project `dodai`), containing the gateway, the web reader and storage (Garage and Qdrant): it runs on its own so that other services on the machine can use its models, search and embeddings as [callers](gateway-callers.md) with their own tokens and budgets, and so that it keeps serving them while Rei is stopped. Rei's control plane reaches the gateway and storage over private networks that only Rei and Dodai are on. A caller that needs object storage gets its own bucket and key in Garage and reaches it directly over `rei-storage-shared`, never through the gateway ([callers](gateway-callers.md#storage)).

Shared contracts live in `packages/protocol`; `packages/network` and `packages/logging` hold address policy and structured logging.

## The agent runtime

Agents are built on [Pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-*`). Pi owns each conversation's durable transcript ([ADR 0004](adr/0004-pi-owns-the-transcript.md)); Rei adds sessions, permissions, overlays (approvals, browser takeover), memory and traces around it. See [Conversation view](conversation-view.md) and [Agent runtime](agent-runtime.md).

## Where to read next

- [Storage and retrieval](storage.md): why data lives in SQLite, Garage and Qdrant.
- [Sandbox network](sandbox-network.md): per-agent network modes.
- [Client contract](contract.md): the API every client speaks.
- [Architecture decision records](adr/): the reasoning behind the shape.
- [`GLOSSARY.md`](../GLOSSARY.md): the domain vocabulary used throughout the code.
