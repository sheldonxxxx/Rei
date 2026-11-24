# History indexing

`MemoryService.history` is the history indexing module. Its interface owns ingestion, startup catch-up and recovery, embedding configuration, rebuilds, lookup, deletion visibility, and status. Its implementation keeps `HistoryIndex`, `IndexWorker`, `RetrievalOutbox`, `RetrievalSyncer`, and the embedding/retrieval adapters private.

`MemoryService` composes history indexing with profile memory. It retains search fusion, relevance filtering, snippet formatting, and final hit presentation. Session purge removes a deleted chat's entries and queues their exact point deletions inside the purge transaction, together with the profile purge hook; the remote deletion drain follows the commit.

The lexical sync loop and embedding loop remain separate internally, including their retry schedules. Collection recovery, generation selection, stale-vector eviction, and SQLite checks belong behind the history interface. Diagnostics obtains a snapshot through that interface rather than reaching into workers or storage adapters.

## Contracts retained

- SQLite remains authoritative; Qdrant indexes are derived. Local keyword fallback remains available without embeddings or when remote lookup fails.
- Vector generations retain their semantic identities, rebuild/promotion behavior, and coverage records. Storage formats, settings, and protocol responses are unchanged.
- Hydration retains its existing contract: candidate lookup checks visibility before ranking. Hydration alone is not an authorization or visibility check.
- Exact chunk deletion, revision-aware outbox completion, and post-upload dense visibility checks remain intact.
- Search scoring, limits and snippet formatting remain outside the indexing module.

## Tests and seams

The production Qdrant adapter and fake retrieval adapter still satisfy the same retrieval interface. Tests exercise history lookup, lifecycle, and cleanup through `MemoryService.history`, with adapter-controlled failures and paused writes. Tests requiring corrupt, missing, or legacy persisted state use `test/helpers/history.ts`; that fixture constructs a separate view of SQLite state and does not expose live workers or caches.

The dependency check rejects production imports of the history implementation outside its owning modules. Recovery, concurrency, fallback, and ranking regressions remain; additional tests cover transaction rollback and partial-message visibility. Semantic-compatibility tests use real history lookup with persisted vector generations instead of invoking a prototype with a fabricated receiver.
