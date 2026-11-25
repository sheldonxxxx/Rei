# Web-search providers and fallback

Settings → Providers → Web search shows every provider in a saved priority order. Move a row by its drag handle, arrow keys on the handle, or its up/down buttons. The move buttons also work on touch screens. Enable switches determine which providers may receive queries; configuring credentials does not enable a provider. Unconfigured rows are muted but remain configurable and movable. Turn all providers off to disable search.

Configure expands the settings for that provider: ChatGPT subscription model (default `gpt-6-luna`), Exa API key, Brave or Tavily key, or external SearXNG URL/authentication. Exa (keyless) and Exa (API key) can both be enabled and positioned independently. Existing setups retain their selected Exa mode and its priority. Secrets are write-only; blank inputs retain saved credentials. Save changes applies the list and configuration together. The UI distinguishes missing configuration, configured credentials, rate-limit cooldowns and the last failed attempt. Configured credentials do not guarantee provider entitlement or health.

## Execution

Rei snapshots enabled order and non-secret provider configuration when a search starts. It tries providers sequentially:

- Disabled providers receive no request. Enabled providers without required configuration are skipped.
- Active rate-limit cooldowns are skipped until Retry-After expires.
- Authentication denial, unsupported subscription models, network/HTTP failures, malformed or incomplete responses and per-provider timeouts advance to the next enabled provider.
- A valid empty result advances to the next provider. If no later provider succeeds, the first valid empty result is returned. All-provider failures return a visible failure, not a fabricated empty success.
- The first nonempty result or valid cited answer wins. Results from different providers are not merged.
- User cancellation stops the chain immediately. Rei's approval and private-data send policies run before the search and cannot be bypassed by fallback.

The chain has a 95-second total budget inside the control plane's 100-second request timeout. Subscription search is limited to 60 seconds per attempt and traditional providers to 10 seconds each, also bounded by the remaining total. Credential preparation shares the attempt deadline. No attempt starts after the total budget expires.

ChatGPT subscription search uses the selected model exactly, after validating account-advertised native search support. There is no automatic model substitution or OpenAI API-key fallback. Enabling another search provider explicitly authorizes fallback to that provider; queries may be sent to every enabled provider until one succeeds. Subscription answers retain text, citation ranges, sources, model and search-call count separately from traditional search-engine snippets. Source count and freshness for subscription search remain research preferences.

## OpenAI built-in search

Settings → Behavior → Web search has **Use OpenAI's built-in search with OpenAI models** (off by default; stored as `search.useOpenAiNativeSearch` in behavior settings). When on, each model call on the built-in `openai` provider over the Responses API adds OpenAI's `web_search` tool and requests `web_search_call.action.sources`. The `web_search` function tool is not offered on those calls, so the model has one search tool. The provider chain above, its approvals and its fallback are bypassed for those calls; OpenAI runs the search and bills it as part of the model call. Other providers and custom connections keep using `web_search`. `web_fetch` is unchanged. The change applies from the next model call. The recorded request in detail mode shows the tool that was sent.

## Storage and contracts

Gateway settings keep `providers` as the ordered enabled subset for existing CLI/API clients. Optional `providerOrder` stores all five IDs, including disabled rows, exactly once. On migration, previous enabled order is preserved and missing rows are appended disabled. No provider is enabled just because a credential exists. Existing all-off settings stay off. Legacy clients that omit `providerOrder` still submit their enabled order; remaining rows are retained afterward. No database migration or reset is needed.

GET/POST `/setup/search` return non-secret `providerStatus` for every row. POST accepts `providerOrder`, enabled `providers`, and the existing provider configuration. The gateway validates the order and computes execution order from it. Credentials never appear in responses.

`POST /search` returns safe `attempts` summaries for actual attempts and skipped enabled providers: provider, status (`skipped`, `failed`, `empty`, `succeeded`), stable reason and elapsed milliseconds. Success retains `provider`, `results` and optional `answer`. Failure retains `{error:{code,message}}` and includes attempt summaries. Tool results expose fallback provenance and timing for inspection, including when all providers fail. Gateway call records retain actual calls and usage; service logs never include queries, citations, credentials or upstream error bodies.

## Validation

Validation evidence and screenshots were kept locally and are not published.

### Local acceptance, 2026-11-14

- Implemented on `main` at base `b516a38`; unrelated dirty changes preserved; work remains uncommitted.
- Full suite: 244 files passed, 3 skipped; 3,011 tests passed, 19 existing environment-dependent skips. Coverage gates passed; overall line coverage 87.67%. The first run hit a surface/worker refresh timeout outside this change; that suite passed separately, then the full suite passed unchanged.
- Typechecking, contract generation/check, architecture, dependency check, secret scan and frontend production build passed. `npm run verify` was run; it stops at the existing formatting findings in `ChatView.tsx`, `ChatView.test.tsx` and `docs/sandbox-network.md`. Separate lint still reports the existing unused import in `NotificationSettings.tsx`.
- Security audit completed: two moderate vulnerable packages (`hono`, `@hono/node-server`), unchanged by this work. Existing skipped suites need their documented benchmark, embedding endpoint and Chromium CDP prerequisites. No skips or coverage floors were added or lowered.
- Local Docker gateway/control/edge rebuilt and redeployed without resetting volumes; stack healthy, edge remains on `127.0.0.1:8787`. Gateway image `sha256:1e1067059e5213cd4d36767d08a0630731da22966dcbf649d9b74a8d94d1a5b8`; control/edge image `sha256:5963a3c0ebdd94420f72c8b3ec4a0d3711bdc78aa24b4cdc4829f4418d924200`.
- Browser: five rows with configured/missing-setup/off states; enable switches, arrow buttons, native drag reorder, Save and reload persistence verified. Configuring an unconfigured provider remains available. Reviewed desktop 1280×900 and phone 390×844 in light/dark; scrolling reaches Save changes. Screenshots were kept locally and are not published.
- Live fallback: enabled Exa after ChatGPT, temporarily selected an unavailable subscription model, then searched for the official Vite website. HTTP 200 via Exa; trace recorded `subscription_model_unavailable` followed by Exa success.
- Browser chat with the existing Qwen model completed the same fallback flow and rendered a clickable `https://vite.dev/` citation. The detailed tool step contains both attempt statuses and elapsed times. The public acceptance chat remains available as “Vite official website”.
- Restored the original enabled choice (ChatGPT only), original order and `gpt-6-luna`. A subsequent live request succeeded through Luna and cleared the temporary failure state. Other providers remain available for explicit enabling. The isolated browser was closed.

This establishes local code, build and affected-flow acceptance. It does not certify other hosts, independently audit subscription billing, or test production backup/restore; no data migration or reset was performed.
