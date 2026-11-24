# ChatGPT subscription web search

Search configuration now uses an ordered provider list with explicit enable switches. See [Web-search providers and fallback](search.md) for current ordering, migration and failure behavior. This supersedes the original exclusive-provider behavior recorded below.

Rei can use its existing OpenAI connection signed in with ChatGPT as a dedicated search backend, independently of the active chat model. Select **ChatGPT / Codex subscription** under Web search in the web app's **Settings → Providers**. Set **Search model** in that panel; the default is `gpt-6-luna`. The model is stored in gateway settings as `codexModel` and changes apply immediately. Older saved settings without this field use the default. Environment-only setups can select `GATEWAY_SEARCH_PROVIDERS=codex-subscription`. Existing provider settings and the default keyless Exa selection are preserved until explicitly changed.

The gateway accepts `codex-subscription` in the enabled fallback order. It never falls back to an OpenAI API key or changes the configured model. It may fall back to another explicitly enabled search provider. Missing OAuth credentials, denied entitlement, unavailable models, rate limits, incomplete streams and missing citations return visible errors with stable codes. Choosing a different search provider explicitly remains possible.

## Transport and results

The gateway checks that the stored `openai` credential is OAuth, resolves it through the existing refresh lifecycle, then checks the credential type again. It queries the official `https://api.openai.com/v1/models` subscription catalog and verifies that the configured search model is advertised with API access and a native web-search capability. It uses that exact model, with no automatic model substitution. It does not invent a model ID or infer support from a model name. Catalogs that do not advertise those capabilities are rejected. Discovery and search do not follow redirects.

Search uses `POST https://api.openai.com/v1/responses` with `store:false`, `stream:true`, message-array input, native `web_search`, required tool choice and source inclusion. No unsupported sampling or output-token fields are sent. Subscription search has a 60-second per-attempt timeout within the chain’s 95-second overall budget and a 2 MiB reply limit. The server tool allows 100 seconds for its gateway request. Search is a separate request; the chat model's request and tool schema transport are unaffected. `web_fetch` remains a separate page-reading tool.

The gateway retains streamed output items as well as terminal response output. A `response.completed` event with completed status, a completed search item, assistant answer and valid URL citation are all required. A final event with an empty output array does not discard earlier completed items.

`POST /search` retains `{provider, results}` and adds an optional `answer` object for subscription search. Its `results` array is empty: generated answers are not search-engine snippets. `answer` contains original text, citation character ranges, sources consulted, selected model and actual search-call count. It does not invent publication dates. Source count is a requested target, and freshness is a research preference rather than a strict publication-date filter. Rei renders citations as Markdown links and supplies the answer and sources to any active model.

Both web tools classify outbound requests from sessions holding private data as sends, using the existing approval policy. Service logs carry provider, status, counts and codes; gateway call records retain token usage and latency, never queries or credentials. Citations and answer contents belong in the inspectable tool transcript, not service logs. Subscription quotas and account/workspace policies still apply; token counts do not establish a dollar cost or independent billing guarantee.

## References

- [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [Sign in with ChatGPT preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Originating feasibility page](https://app.notion.com/p/417db724698881c6bf32cd13158db805)

## Local validation, 2026-11-14

Implemented on `main` at base `b516a38`, with uncommitted unrelated changes preserved. Local Docker gateway/control/edge were rebuilt and redeployed without volume resets; edge remains bound to `127.0.0.1:8787`.

- First real OAuth smoke through Rei Gateway: native search started, searched and completed; final assistant answer included a Vite URL citation. The terminal output array was empty, validating the need to retain streamed items.
- Deployed `POST /search`: HTTP 200, provider `codex-subscription`, account-advertised `gpt-6.1-sol`, one actual search call, cited answer and 26 consulted sources. No API key was used by this backend.
- Focused regressions: 113 tests passed (gateway transport, failure behavior, credential type, model discovery, server formatting/validation, private-data approvals, search settings UI).
- Full suite with coverage: 242 files passed, 3 files skipped; 3,000 tests passed, 19 skipped. Critical coverage gates passed. Overall line coverage 87.68%.
- Typechecking, contract generation/check, architecture, dependency check, secret scan and production frontend build passed.
- `npm run verify` was run and stopped at pre-existing formatting findings in `ChatView.tsx`, `ChatView.test.tsx`, and `docs/sandbox-network.md`. The separate lint gate reports a pre-existing unused import in `NotificationSettings.tsx`. These unrelated files were left intact.
- `npm run check:security` completed and reports two moderate vulnerable packages: `hono` and `@hono/node-server`. No dependency changes were made by this work.
- Existing environment-dependent skips require the runtime benchmark flag (`REI_BENCH`), a memory-evaluation endpoint, and a real Chromium CDP endpoint. See the corresponding eval/browser suites; no skips or coverage floors were added or lowered.

Browser acceptance passed against the deployed app using the saved development login:

- Selected **ChatGPT / Codex subscription** in Web search settings, saved it, and verified that no API-key input appears.
- Created the separate **Vite Web Search Acceptance Test** chat with the existing `modelscope/Qwen/Qwen3.8-Flash-Next` chat model. It called `web_search`, displayed completed search activity, and returned a clickable `https://vite.dev/` citation. The test chat remains available for inspection.
- Reviewed settings at 1280×800 and 390×844 in light and dark schemes. The selector, explanation and Save control remain visible and usable. Screenshots were kept locally and are not published. The isolated browser session was closed afterward.
- Deployed gateway image: `sha256:1de1fa9acf87047a329c1a5a0bb4d8b43dd81c04d64337bc25ef32b9be696895`.
- Deployed control/edge image: `sha256:bcf0f14b358584357eeb6658ddd71b3f1d402f439b90726b1a7d06da1c79b107`.

This is local validation, not a production release or a backup/restore certification. Account entitlement and billing behavior beyond the successful subscription-authenticated request have not been independently audited.

## Search-model setting follow-up, 2026-11-14

The user replaced automatic catalog-order model selection with an explicit **Search model** setting, defaulting to `gpt-6-luna`. The API accepts an optional `codexModel` field in search settings; existing clients that omit it retain the saved model. Model IDs are validated before saving. Search validates the exact configured ID against the connected subscription catalog, failing visibly when unsupported instead of choosing a different model. The UI exposes the field only for subscription search.

Focused regression checks passed (22 tests), covering the Luna default, editing/saving a different model, persistence after reload, invalid IDs and refusal to substitute a different advertised model. The rebuilt local gateway/control/edge stack is healthy with existing volumes preserved. Browser acceptance confirmed the `gpt-6-luna` default, saved `gpt-6.1-sol`, reloaded and verified persistence, then restored and saved `gpt-6-luna`. A live subscription-backed `POST /search` returned HTTP 200 with `answer.model: "gpt-6-luna"`, one completed search call and a URL citation. Screenshots of the new field were kept locally and are not published.

The full suite passed again: 3,000 tests passed and 19 existing environment-dependent tests skipped; coverage gates passed (87.67% line coverage). Typechecking, contract check and frontend build passed. `npm run verify` still stops at the unrelated formatting findings listed above; the separate lint gate still reports the unrelated notification-settings import. No coverage floor or skip was changed.
