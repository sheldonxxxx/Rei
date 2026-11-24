# Rendered pages use a disposable browser context and a per-job egress token

Status: accepted (2026-11-14); partly superseded by [ADR 0020](0020-web-reading-is-a-shared-service.md), which moved rendering from the agent computer's Chromium and the egress render listener into the shared reader. The rules about what a rendered page may reach still hold. Rendering shares the agent computer's browser, in its own contexts (see Consequences). Implemented by web reading v2 ticket 09; ticket 10 added the red-team suite, and `auto` is offered as an opt-in setting (default off), approved 2026-11-14.

When `web_fetch` gets a page that shows nothing without JavaScript (`requires_js`), Rei may render it in the browser container and read the resulting HTML with the same extractor. The browser container today is the agent computer: one Chromium with the user's persistent profile, whose egress listener lets every connection through while the browser is in use, with no per-host check and the user's local networks open. A rendered page must get none of that. It must not see the profile's cookies or storage, reach local networks or the stack, outlive its job, or send traffic that cannot be tied to the job.

## Decisions

- **A render job is one `web_fetch` call that renders.** Only a call that reaches the network and gets `requires_js` renders; reads of the stored copy (`query`, `section`, a re-read) use the HTML the render produced, and `refresh` is a new job. Each job has its own context, token, caps and deadline.
- **One disposable context per render job,** created over the existing DevTools connection with `Target.createBrowserContext({ disposeOnDetach: true, proxyServer: <render listener>, proxyBypassList: "<-loopback>" })`. The context shares nothing with the profile: no cookies, storage, cache, logins or permissions. Within the context:
  - downloads are denied (`Browser.setDownloadBehavior` deny);
  - images, media and fonts are failed in the browser before they are requested (`Fetch.requestPaused` with resource type `Image`, `Media` or `Font`). They add no text, and leaving them out cuts most of a page's bytes and time. A page that waits for an image before showing its text is read at the deadline with what it has;
  - every page and frame target is auto-attached paused (`Target.setAutoAttach`, `waitForDebuggerOnStart`) before it runs, gets `Fetch.enable({ handleAuthRequests: true })`, and gets a document-start script that removes `navigator.serviceWorker`;
  - a `service_worker` target that appears anyway is closed;
  - the context is disposed when the job ends for any reason (done, error, deadline, cancel). Nothing from it is kept except the HTML read back.
- **A separate render egress listener** on the egress proxy (`EGRESS_RENDER_LISTEN`, on browser-net next to the browser listener). Unlike the browser listener it requires proxy authentication: user `rei`, password a job token `r.<job id>.<mac>` minted by the control plane for that job only. Chromium answers the proxy's 407 through `Fetch.authRequired`, and keeps the credentials for the context, so dedicated workers (which have no `Fetch` domain) send them too. The proxy passes the token to the control plane like a sandbox run token, and the control plane decides as follows:
  - the job must exist and be live (not finished, cancelled or past its deadline); a used token is revoked when the job ends, so a leftover context's traffic is refused;
  - ports 80 and 443 only;
  - **any public host** may be reached once the top-level URL was allowed by `web_fetch`'s policy (the user's choice, 2026-11-14). The page's own scripts, stylesheets and API calls need no per-host approval;
  - `localNetworks: "none"` always. The proxy resolves the name itself, refuses if any address is private or one of the stack's networks, and connects to the address it checked, so DNS rebinding gets nothing new;
  - per-job caps, both server settings: at most 200 connections (`REI_RENDER_MAX_CONNECTIONS`) and 50 MiB through the proxy (`REI_RENDER_MAX_BYTES`), plus the job's deadline. With media blocked these are safety limits against a page that loops or streams, not limits a normal page reaches. The proxy cuts the job's tunnels when its token is revoked or a cap is reached, and the render is read with what it has.
- **The top-level URL is decided exactly as today.** `web_fetch` classes it and asks for approval when needed before any render. A main-frame navigation or redirect inside the render is paused (`Fetch`, `Document` requests) and checked with `evaluateTool`, as HTTP redirects are now. A denied redirect ends the render with the redirect message.
- **Several renders at once:**
  - at most 2 renders run at a time across the stack (all agents and chats), so the shared Chromium keeps its memory and the agent computer stays responsive;
  - other jobs wait in a first-come, first-served queue for up to 30 seconds. A job that gets no slot in time fails with "The browser is busy rendering other pages; try again shortly.", and its details record the wait;
  - an agent holds at most one slot while another agent's job is waiting, so one agent opening many pages cannot hold up the rest;
  - one render per agent and URL at a time: a second call for a URL the agent is already rendering waits for that render and reads the stored copy;
  - cancelling a run takes its waiting jobs out of the queue and ends its running render at once, freeing the slot;
  - the queue and the browser tools are independent: renders never wait behind, or block, the agent computer's windows.
- **Lifecycle:**
  - a 20-second deadline per render once it has a slot, separate from the 15-second HTTP fetch and the queue wait;
  - the page is read once its body text has not changed for 1 second (polled every 250 ms), never by `networkidle`; at the deadline, whatever text is there;
  - the HTML read back is capped at 5 MiB;
  - cancelling the tool call disposes the context, revokes the token and stores nothing.
- **Escalation is narrow:** only from `requires_js` (and a `low_quality` page the classifier explains), never from `blocked`, a policy denial or an HTTP error. A bot check or sign-in wall stays a wall.
- **No browser, no rendering.** When the browser container is not configured or not healthy, `web_fetch` behaves as it does now: `requires_js` fails with its message, and the details say rendering was unavailable. The setting shows why it cannot be turned on.

## Evidence

`containers/spike-render-isolation/` holds the spike (`spike.mjs`, run by `run.sh`), which runs in a throwaway container on browser-net against the real browser container (Chromium 156). It creates a context as above, pointed at a token-checking test proxy, and renders a page that fetches an API on a second host, loads an image, a video and a web font, starts a worker that fetches, opens a WebSocket, tries the control plane, the metadata address and loopback DevTools, starts a download, and on a secure-context page tries to register a service worker. Three runs passed all thirteen checks (about 1.65 s per render):

- the page's JavaScript output was read back;
- the image, video and font were failed in the browser and never reached the network, and the page still rendered;
- every other request (document, API call, worker script and the worker's own fetch, WebSocket `CONNECT`, the three local addresses) reached the context's proxy carrying the job token, after one 407 challenge per context;
- the stack's real egress proxy logged none of it;
- a cookie planted in the user's profile for the test host was never sent;
- the download was cancelled;
- with the document-start script, `navigator.serviceWorker` is absent and `/sw.js` is never requested. Without it, the script fetch bypassed the page's `Fetch` interception and closing the worker's target left the registration, which is why the script is part of the decision;
- the context and its targets were gone after disposal, and the planted cookie was removed again.

## Implementation notes (ticket 09)

- Each render opens its own DevTools WebSocket rather than sharing the browser driver's connection, so `disposeOnDetach` also covers a control plane that dies mid-render (`apps/server/src/node/browser-render.ts`).
- Bytes are counted by the proxy per token (the decision hands it a budget of bytes and milliseconds); the control plane counts connections. The step's details therefore record connections and refusals, not bytes.
- `low_quality` escalates only when the extractor fell back to the page's embedded summary (meta, JSON-LD, Next.js or Nuxt data). If that render fails, the HTTP result is returned.
- The setting (`off | auto`, default off) is offered in Behavior settings now. Ticket 10's red-team suite, and the weighing of a separate render browser, come before `auto` becomes a recommended or default choice.
- The browser driver skips pages of other browser contexts when it adopts the profile's pages.

## Red-team results and the shared browser (ticket 10)

`containers/smoke-render/run.sh` attacks the renderer from inside a rendered page (43 checks, all passing on local Docker, three runs). Its first run found three gaps, each already contained by another layer and now closed at the source:

- the render decision allowed `localhost` by name (the proxy refused it after resolving). Names that are never public (single-label container names, `localhost`, `.local`, `.internal`, `.home.arpa`, `.lan`, `.test` and others) and special address literals are now refused by the control plane before the proxy looks anything up;
- a page's WebSocket reached the destination through the render listener. WebSockets are now removed from pages and frames by the document-start script, blocked at the network layer (`Network.setBlockedURLs`), and removed from every worker while it is paused before its first line (`Runtime.evaluate` before `runIfWaitingForDebugger`), since document-start scripts do not reach workers;
- WebRTC was available, which could send UDP around the proxy to hosts on browser-net. It is removed the same way (workers have no WebRTC).

On sharing the browser: the remaining exposure is a Chromium renderer exploit on a rendered page reaching the profile, because the container runs `--no-sandbox`. Rendering stays off by default, and the setting is offered with a privacy note, so a user opts in knowingly. That is proportionate for a single-user, self-hosted stack whose agent already browses with the same browser. If `auto` is ever made the default, or the stack serves several users, rendering should move to a second, profile-less browser container (`REI_RENDER_CDP`) on its own network first; the renderer and the listener do not change.

## Consequences

- Rendering runs in the same Chromium process as the user's profile, and the container runs Chromium with `--no-sandbox`. A renderer exploit on a rendered page would reach the profile. This is the exposure the browser tools already accept when an agent browses, but rendering can happen without the user watching. If that is not acceptable, the same code can point at a second, profile-less browser container (`REI_RENDER_CDP`) on its own network at the cost of another Chromium; the decision above does not change. Ticket 10 weighs this before `auto` is offered.
- Removing `navigator.serviceWorker` is defence in depth. A worker that registered some other way still lives only in a context that is disposed at the end of the job, behind a token that is revoked then.
- The render listener is a new egress identity: its traffic is attributable per job, in the logs and in the step's details (`method: "render"`, the escalation reason, connections, bytes).
- The first request of every render pays one extra proxy round trip for the 407 challenge.
- The browser driver must ignore render contexts when it lists and polls the agent computer's windows, so a render never shows up as a session window or in a takeover.
