# Private native forks use disposable stores

Background executions take a bounded online SQLite backup of the source Pi tree, neutralize all copied submissions and tasks, and create a native fork at the committed source cut inside that disposable store. Pi 1.5 has no supported branch-erasure primitive, so a shared-tree fork could retain private review context until the entire source tree was deleted; deleting the disposable directory gives each attempt an explicit erasure boundary without reconstructing the transcript or disturbing public forks.

## Consequences

The backup temporarily contains the source tree, including sibling conversations. It lives in an isolated directory, never becomes a product session or search source, and is removed after every attempt and during startup recovery. Backup size, time, execution time and model tokens are bounded. Copied tasks are abort-marked before scheduling resumes, then drained from descendants to owners with a review-only registry and fail-closed model/policy bindings. A snapshot that cannot meet these conditions fails visibly and preserves the review window.

The review reuses the source reply's actual provider/model. Its execution identity remains private; supported provider prompt-cache keys can preserve source affinity separately. Historical tool declarations are filtered from provider requests so only review tools are offered. This can reduce shared prompt prefixes, so cache hits and cost savings require measurement.

Pi still owns the canonical transcript and runs (ADR-0004). Rei's lifecycle outbox joins the existing idempotent SQLite settlement-effects transaction; acknowledgement in Pi happens afterwards. Subscriber delivery and job enqueue commit together. Memory effects, the source overlay, reviewed cursor and job completion commit atomically under the attempt fence. Model requests remain at-least-once across crashes.
