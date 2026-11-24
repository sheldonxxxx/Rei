# Web reading is a shared service

Status: accepted (2026-11-16). Partly supersedes [ADR 0017](0017-rendered-pages-use-a-disposable-context-and-a-job-token.md).

Rei fetched, extracted and rendered pages itself: the egress proxy fetched, the control plane extracted, and JavaScript pages were rendered in the agent computer's Chromium through a render listener on the egress proxy. Another service on the machine that needs to read a page would have had to copy all of that, and every copy would need its own browser and its own hostile-page testing.

## Decisions

- **One reader serves everything.** The reader is a service of Dodai’s compose project, next to the gateway. It fetches, follows redirects within the hosts the caller allowed, extracts Markdown and sections, and renders pages that need JavaScript. Rei's `web_fetch` is its first caller and keeps only the policy and the stored copies.
- **The gateway stays in front.** Callers use `POST /read` on the gateway: same tokens, a `read` scope, a per-caller budget, one call log. The reader is on a network with no other route in.
- **The caller owns the destination policy.** The reader fetches only the hosts in `allowHosts`. A redirect to another host comes back as an answer and the caller decides, so Rei's approvals and sandbox network setting apply exactly as before. `localNetworks` other than `none` needs the `read-local` scope, which only Rei holds.
- **Two engines, Moli first.** Moli (one process per render) is tried first; Chromium is the fallback. Every render attempt is recorded with its full URL in the reader's SQLite database, 10% of Moli successes are also rendered by Chromium for comparison, and `./rei reader stats` reports the rescue rate and divergence. After 30 days and 500 renders with a rescue rate under 1% and divergence under 2%, Chromium is proposed for removal.
- **ADR 0017's rules move, not vanish.** A render is still a disposable context with no profile, its own job token, public hosts only on ports 80 and 443, never local networks, capped connections and bytes, a deadline, and a redirect check on navigation. The reader mints the job tokens and enforces them in its own forward proxy. What no longer exists: rendering in the agent computer's browser, the render listener on Rei's egress proxy and the control plane's render decisions.
- **Rei's old code is deleted.** The fetch client, extractor, Markdown serializer, quality classifier and renderer left the server.

## Consequences

- A second caller gets reading, rendering and the red-team coverage for the price of a token. The reader's network position (outbound only, nothing of Rei's reachable) is the thing to protect.
- Reading depends on the reader being up. A down reader fails `web_fetch` with a readable message; stored copies still read.
- A slow site costs a gateway read slot for the call's length; callers' `--reads` budget limits that.
- Full URLs exist only in the reader's `render_attempts` rows, because the log rules forbid URLs in log fields.
