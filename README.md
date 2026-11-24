<div align="center">

# <img src="docs/assets/rei-banner.jpg" alt="Rei レイ" width="860">

**Your own AI assistant — your context, your models, every action inspectable.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 26+](https://img.shields.io/badge/node-%E2%89%A526-339933?logo=nodedotjs&logoColor=white)
![Docker Compose](https://img.shields.io/badge/docker-compose%20v2-2496ED?logo=docker&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Status: personal project](https://img.shields.io/badge/status-personal%20project-orange)

[Install](docs/installation.md) · [Android client](apps/android/README.md) · [User guide](docs/user-guide.md) · [Architecture](#architecture) · [All docs](docs/README.md)

</div>

Hosted AI assistants are becoming the most personal software we use — learning how you write, what you work on, which files matter and what you want done every morning — while locking all of it inside someone else's black box.

**Rei** is the opposite: a self-hosted assistant running on your own machine with Docker. You bring the models and keep the memory, files, knowledge and rules. Everyday chat stays quiet and fast; one click opens the full trace behind any reply — every prompt, tool call, policy decision and token count. Before anything sensitive runs, Rei stops and asks.

It ships as a web app (PWA), a native [Android client](apps/android/README.md) and the `rei` CLI (`./rei` in a checkout) for setup, upgrades and backups.

<img src="docs/assets/approval.png" alt="Rei asking for approval before an agent fetches a web page" width="860">

## Why build your own

ChatGPT, Claude, Gemini and other hosted assistants are impressive products, but handing your most personal context to a single vendor is a bad trade:

- **Your context is the valuable part, and it is not portable.** Memory, files, routines and preferences stay behind the vendor's walls. Switching means starting over.
- **Models leapfrog each other every few months.** An assistant tied to one lab cannot move to whichever model is best, cheapest or local this month.
- **The rules are not yours.** What it remembers, which tools it may use, what it costs and when a feature disappears are decided elsewhere.
- **You cannot see why it acted.** When an assistant does something surprising, there is rarely a way to inspect the prompt, the tool calls or the policy that allowed them.

Meanwhile, building an assistant framework has never been cheaper. With AI coding agents, the framework itself is the thin, replaceable layer; what matters is that the data and behavior belong to you. Everyone who cares should end up with an assistant built the way they want it.

Rei is my version — built for myself, around how I work, with no roadmap beyond my own needs. Run it, fork it, or point your own coding agent at it as a reference while you build yours.

## Features

- **Dedicated agents.** Each agent keeps its own instructions, skills, model choice and memory, with a home chat that can delegate work to worker sessions.
- **Simple and Detail modes.** Everyday chat stays clean; Detail mode reveals every model call, tool call, policy decision, token count and timing.
- **Approvals you control.** Tool use, web access and commands can require approval just once, per chat, per agent, for a set time or always.
- **Sandboxed execution.** Agents run commands in an isolated container and browse in a headless Chromium you can take over live, governed by per-agent [network modes](docs/sandbox-network.md).
- **Readable, editable memory.** A compact profile, per-agent notes and searchable chat history (keyword plus optional [embeddings](docs/embedding-providers.md)), with undo.
- **Knowledge pages and file Library.** Long-lived Markdown pages for research, plans and decisions, alongside versioned files with in-browser previews for PDF, Office and Markdown.
- **Scheduled and event triggers.** Run prompts or skills on a schedule or when another service sends a [signed event](docs/events.md), and deliver reports back to chat.
- **MCP connectors, web search and push.** Connect external tools over MCP, configure fallback web search (keyless Exa, Brave, Tavily, external SearXNG or ChatGPT subscription search) and receive self-hosted push notifications.
- **Bring your own model.** Connect a ChatGPT sign-in, any OpenAI-compatible endpoint or local models on Apple Silicon through oMLX.
- **Built-in backups.** Automated daily local backups without stopping the stack, with one-command restore ([backups](docs/backup-user.md)).

<img src="docs/assets/detail.png" alt="Detail mode: a run's model calls and command, with the Inspect panel showing the tool, policy decision, input and output" width="860">

## Architecture

This repository ships **Rei** and its shared service foundation, **Dodai**, which run standalone out of the box. In my personal setup, Rei also sits at the center of a wider ecosystem of optional external services connected over MCP and signed webhooks — for example, a scheduled briefing can pull a ranked News digest over MCP, run web research for context and post the result to the agent's home chat with an inspectable trace.

<img src="docs/assets/rei-architecture.png" alt="Architecture diagram: Rei (web/PWA and Android clients, triggers, control plane and agent runtime, agent state, tool policy and traces, and isolated execution) sits above Dodai, a separate full-width shared foundation containing Qdrant, Gateway, Web reader and Garage S3 storage. On the right, Rei connects over MCP to optional external services: Hashi (an open-source opt-in MCP bridge for project roots and local coding agents) and Kura (a private domain-services example with Finance and News). Kura sends signed event references back to Rei, shares Dodai via scoped gateway tokens and a dedicated S3 bucket, and can optionally call Hashi's minimal MCP mode." width="860">

[Editable Excalidraw diagram](docs/assets/rei-architecture.excalidraw)

- **Rei レイ** *(this repository)* owns the agent loop and decides when to call a model, run a tool or ask for approval. The Inspector records every model call, tool call and policy decision, and MCP connectors enforce Rei's permissions while routing calls through the gateway. See the [service architecture](docs/architecture.md).
- **Dodai 土台** *(this repository, separate Compose stack)* is the shared foundation: gateway, profile-free web reader, Garage S3 storage and Qdrant vector index. It runs as its own Compose project (`dodai`) so other callers keep model, web and S3 access even while Rei is stopped. External callers receive scoped gateway tokens, per-provider concurrency budgets and dedicated Garage buckets; Qdrant stays Rei-only. See [gateway callers](docs/gateway-callers.md).
- **Hashi 橋** *(optional, standalone open-source repo)* is an opt-in MCP bridge that lets Rei and other MCP clients inspect enabled project roots and Git diffs, prepare handoffs and launch explicitly enabled local coding agents such as Claude Code, Codex and Pi. External services can also call Hashi's minimal mode for one-off model runs without tools. See the [Hashi repository](https://github.com/sheldonxxxx/Hashi).
- **Kura 蔵** *(optional, private example)* is the "storehouse" pattern in my own setup, where each private domain owns its records and runs fixed jobs — such as importing statements for Finance or triaging stories for News. Rei queries domain data over MCP; when something happens, Kura sends a signed, reference-only webhook (an event type and ID, never untrusted content) to start a Rei trigger, and the agent reads the details back over MCP. See [event triggers](docs/events.md).

## Quick start

**Requirements**

- Docker with Compose v2.20 or newer on the machine that will run Rei (macOS or Linux; on Windows, WSL2 only — developed on macOS).
- Node.js 26 or newer and npm.
- Internet access for dependencies and container images, plus disk space for images and your data.
- A supported model provider connected in the web app for real replies (ChatGPT sign-in, any OpenAI-compatible endpoint or local models via oMLX on Apple Silicon). See the [installation guide](docs/installation.md) for the full list.

**Install with npm** (no clone and no build):

```sh
npx rei-ai setup                        # or: npm i -g rei-ai && rei setup
```

Setup checks your machine, writes its files to `~/.rei`, pulls the published images for its release and starts Dodai and Rei. Open the address it prints (by default <http://127.0.0.1:8787>) and create your account with the one-time code; models, memory and web search are configured in the web app.

```sh
rei status                              # summarize Rei and Dodai services
rei doctor                              # check the installation and suggest fixes
npm i -g rei-ai@latest && rei upgrade   # move to a new release (keeps your data)
```

*(If you ran with `npx` instead of installing globally, prefix these commands with `npx rei-ai`.)*

**From source** (for working on Rei): use `./rei` from a checkout to build images locally.

```sh
git clone https://github.com/sheldonxxxx/Rei.git
cd Rei
./rei setup
```

See the [installation guide](docs/installation.md) for configuration, upgrades, backup and restore.

## Documentation

- [Installation](docs/installation.md): requirements, setup, upgrades, backup and restore, reaching Rei from your phone.
- [User guide](docs/user-guide.md): agents, approvals, memory, files, triggers and connectors.
- [Backups](docs/backup-user.md): daily local backups and one-command restore.
- [Architecture](docs/architecture.md) and [decision records](docs/adr/): how the services fit together and why.
- [Android client](apps/android/README.md): native app for chat, approvals, remote browser, files and notifications.
- [All documentation](docs/README.md): complete index of feature guides and internals.

## Use it as a reference for your own assistant

You do not have to run Rei to get value from it. If you are building your own assistant with an AI coding agent, point the agent at the parts you care about:

| If you want to understand…                       | Start with                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| The overall shape and service boundaries         | [`docs/architecture.md`](docs/architecture.md)                                                                       |
| The vocabulary (session, run, overlay, trace…)   | [`GLOSSARY.md`](GLOSSARY.md)                                                                                         |
| Why things are built the way they are            | [`docs/adr/`](docs/adr/)                                                                                             |
| How an AI agent is expected to work in this repo | [`AGENTS.md`](AGENTS.md)                                                                                             |
| Memory, history search and knowledge             | [`docs/storage.md`](docs/storage.md), [`docs/knowledge.md`](docs/knowledge.md)                                       |
| Tools, approvals and sandboxing                  | [`docs/capability-discovery.md`](docs/capability-discovery.md), [`docs/sandbox-network.md`](docs/sandbox-network.md) |

Take what fits and leave the rest. Specs, decisions and vocabulary are kept in plain Markdown next to the code so an agent can follow the reasoning, not just the result.

## Repository layout

```
apps/
  server/     control plane: API, SQLite, agent runtime, memory, library
  web/        React/Vite frontend (PWA)
  android/    native Android client (Kotlin / Jetpack Compose)
  gateway/    model, embedding, search, MCP and push gateway
  reader/     shared profile-free web reader
  egress/     network proxy for the sandbox and browser
  cli/        setup and operations CLI (./rei, and the npm package rei-ai)
packages/     shared protocol, network, proxy and logging packages
containers/   Docker Compose stacks (Rei and Dodai) and service images
docs/         user, architecture and decision docs
tests/        end-to-end and repository quality tests
```

## Development

```sh
npm ci                                        # install workspace dependencies and hooks
REI_MODEL_MODE=faux npm start -w @rei/server  # server with a simulated model
npm run dev -w @rei/web                       # Vite on :5173, proxying to :8787
npm run verify                                # format, lint, types, architecture, tests, build
```

Conventions, test expectations and commit style are in [`AGENTS.md`](AGENTS.md); quality gates are explained in [`docs/code-quality.md`](docs/code-quality.md).

## Project status

Rei is a personal project in early development (`v0.1.x`). It is shaped by what I need, there is no roadmap, and breaking changes — including to stored data — can land at any time. It is meant to run on your own machine, bound to loopback; review the [installation guide](docs/installation.md) before exposing it to a network.

## Contributing

Issues and discussion are welcome, especially bug reports and ideas you found useful in your own build. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: open an issue before a larger change, because the project follows its maintainer's priorities and a pull request may not be merged. Forking and adapting it for yourself is very much encouraged. Please report security problems privately, as described in [SECURITY.md](SECURITY.md), rather than in public issues. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Acknowledgements

Rei's agent runtime is built on [Pi](https://github.com/earendil-works/pi). It also stands on Hono, React, Vite, Playwright, Garage, Qdrant and many other open-source projects.

## License

[MIT](LICENSE). Bundled third-party material is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
