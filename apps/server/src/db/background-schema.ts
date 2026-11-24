/** Durable delivery and work records; payloads contain references, never transcript copies. */
export const BACKGROUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS lifecycle_outbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
 run_id TEXT, cut_entry_id TEXT, input_entry_id TEXT, eligible INTEGER NOT NULL DEFAULT 0,
 provider TEXT, model TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lifecycle_deliveries (
 event_id TEXT NOT NULL, handler TEXT NOT NULL, PRIMARY KEY(event_id, handler)
);
CREATE TABLE IF NOT EXISTS background_jobs (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, dedupe TEXT NOT NULL UNIQUE,
 session_id TEXT, agent_id TEXT NOT NULL, payload TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','no_changes','skipped','failed','cancelled')),
 attempt INTEGER NOT NULL DEFAULT 0, fence INTEGER NOT NULL DEFAULT 0,
 lease_until INTEGER, retry_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
 finished_at INTEGER, diagnostic TEXT, result TEXT
);
CREATE INDEX IF NOT EXISTS background_ready ON background_jobs(status,retry_at);
CREATE TABLE IF NOT EXISTS background_attempts (
 job_id TEXT NOT NULL, attempt INTEGER NOT NULL, started_at INTEGER NOT NULL,
 finished_at INTEGER, provider TEXT, model TEXT, usage TEXT, outcome TEXT,
 PRIMARY KEY(job_id,attempt)
);
CREATE TABLE IF NOT EXISTS memory_review_state (
 session_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, reviewed_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS memory_review_sources (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
 run_id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL UNIQUE, entry_id TEXT NOT NULL,
 cut_entry_id TEXT NOT NULL, provider TEXT, model TEXT, created_at INTEGER NOT NULL, job_id TEXT
);
`;
