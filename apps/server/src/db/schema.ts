import { BACKGROUND_SCHEMA } from "./background-schema.ts";
import type { Db } from "./db.ts";

// The complete schema for a fresh Rei installation.
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        iterations INTEGER NOT NULL,
        totp_secret TEXT NOT NULL,
        totp_last_step INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

CREATE TABLE setup_pending (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        iterations INTEGER NOT NULL,
        totp_secret TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

CREATE TABLE login_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        at INTEGER NOT NULL,
        ok INTEGER NOT NULL
      );

-- One row per device (GLOSSARY): a sign-in from a browser or an app, with its own credential.
CREATE TABLE auth_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      , id TEXT, label TEXT NOT NULL DEFAULT '', client_kind TEXT NOT NULL DEFAULT 'web');

CREATE UNIQUE INDEX auth_sessions_id ON auth_sessions (id);

CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        home_session_id TEXT,
        created_at INTEGER NOT NULL
      , default_profile TEXT NOT NULL DEFAULT 'standard', model TEXT, allowed_connector_ids TEXT, thinking_level TEXT NOT NULL DEFAULT 'off'
      CHECK (thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
        network_mode TEXT NOT NULL DEFAULT 'block' CHECK (network_mode IN ('block', 'whitelist', 'any')),
        can_create_triggers_for_other_agents INTEGER NOT NULL DEFAULT 0 CHECK (can_create_triggers_for_other_agents IN (0, 1)));

CREATE TABLE session_trees (
        id TEXT PRIMARY KEY,
        root_session_id TEXT,
        state TEXT NOT NULL DEFAULT 'live',
        next_wake_at INTEGER,
        work_in_flight INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER
      );

CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        tree_id TEXT NOT NULL,
        pi_conversation_id TEXT,
        origin TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        preview TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
        , parent_session_id TEXT, forked_from_session_id TEXT, forked_from_message_id TEXT, depth INTEGER NOT NULL DEFAULT 0, spawn_key TEXT, profile TEXT NOT NULL DEFAULT 'standard', taint TEXT NOT NULL DEFAULT '[]', pending_approvals INTEGER NOT NULL DEFAULT 0, browser_url TEXT, browser_title TEXT, forked_from_step_id TEXT, forked_from_edited INTEGER NOT NULL DEFAULT 0, forked_from_retried INTEGER NOT NULL DEFAULT 0, trigger_id TEXT, hide_in_list INTEGER NOT NULL DEFAULT 0 CHECK (hide_in_list IN (0, 1)), pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)), last_run_status TEXT, unread INTEGER NOT NULL DEFAULT 0);

-- Approval, takeover and memory cards shown in a conversation: anchored to a Pi tool task, entry or run, never stored in Pi.
CREATE TABLE overlays (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('approval', 'takeover', 'memory')),
        ref_id TEXT NOT NULL,
        run_id TEXT,
        task_id TEXT,
        entry_id TEXT,
        json TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

CREATE INDEX overlays_session ON overlays (session_id, created_at);

CREATE INDEX overlays_ref ON overlays (kind, ref_id);

-- A surface fed by a worker session (Rei writes the worker's progress into it until the worker ends).
CREATE TABLE surface_feeds (
        surface_id TEXT PRIMARY KEY,
        owner_session_id TEXT NOT NULL,
        worker_session_id TEXT NOT NULL,
        tree_id TEXT NOT NULL,
        last_hash TEXT,
        written_at INTEGER NOT NULL DEFAULT 0);
CREATE INDEX surface_feeds_owner ON surface_feeds (owner_session_id);

CREATE TABLE steps (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        session_id TEXT,
        type TEXT NOT NULL,
        pi_entry_id TEXT,
        provider TEXT,
        model TEXT,
        status TEXT NOT NULL,
        error_code TEXT,
        started_at INTEGER NOT NULL,
        first_byte_ms INTEGER,
        latency_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        payload_blob TEXT,
        side_effect INTEGER NOT NULL DEFAULT 0
      , tool_name TEXT, action_class TEXT, decision TEXT, approval_id TEXT, summary TEXT, tool_call_id TEXT, response_blob TEXT, usage_purpose TEXT CHECK (usage_purpose IN ('chat', 'memory', 'title', 'agent_task', 'other')), usage_agent_id TEXT NOT NULL DEFAULT '', usage_accounted_at INTEGER, activity TEXT, context_window INTEGER, context_input INTEGER, context_cached INTEGER, context_output INTEGER, offered_tools TEXT, loaded_tools TEXT);

CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        tree_id TEXT,
        session_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );


CREATE TABLE deletion_jobs (
        id TEXT PRIMARY KEY,
        tree_id TEXT NOT NULL,
        session_ids TEXT NOT NULL,
        remove_tree INTEGER NOT NULL,
        blob_refs TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );

CREATE TABLE approvals (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        session_title TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        run_id TEXT,
        run_assigned_by TEXT,
        tool TEXT NOT NULL,
        args_json TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        connector TEXT NOT NULL,
        operation TEXT NOT NULL,
        action_class TEXT NOT NULL,
        destination TEXT,
        summary TEXT NOT NULL,
        args_preview TEXT NOT NULL,
        taint TEXT NOT NULL,
        lengths TEXT NOT NULL,
        status TEXT NOT NULL,
        grant_length TEXT,
        grant_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER,
        once_expires_at INTEGER,
        consumed_by TEXT,
        consumed_at INTEGER,
        notified_at INTEGER
      , preview_json TEXT);

CREATE TABLE grants (
        id TEXT PRIMARY KEY,
        connector TEXT NOT NULL,
        operation TEXT NOT NULL,
        destination TEXT,
        length TEXT NOT NULL,
        session_id TEXT,
        agent_id TEXT,
        expires_at INTEGER,
        approval_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

CREATE TABLE demo_effects (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        tool TEXT NOT NULL,
        args TEXT NOT NULL,
        session_id TEXT,
        at INTEGER NOT NULL
      );

CREATE TABLE workspace_purges (
        tree_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );

CREATE TABLE takeovers (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        reason TEXT,
        status TEXT NOT NULL,
        url TEXT,
        title TEXT,
        note TEXT,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        expires_at INTEGER,
        notified_at INTEGER
      );

CREATE TABLE takeover_acts (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        takeover_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL
      );

CREATE TABLE memory_lines (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        doc TEXT NOT NULL,
        agent_id TEXT,
        text TEXT NOT NULL,
        source_session_id TEXT,
        source_message_id TEXT,
        source_deleted INTEGER NOT NULL DEFAULT 0,
        added_at INTEGER NOT NULL,
        confirmed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        removed_at INTEGER
      );

CREATE TABLE memory_changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        line_seq INTEGER NOT NULL,
        doc TEXT NOT NULL,
        agent_id TEXT,
        op TEXT NOT NULL,
        before_text TEXT,
        after_text TEXT,
        by TEXT NOT NULL,
        session_id TEXT,
        at INTEGER NOT NULL,
        undone_at INTEGER,
        sealed INTEGER NOT NULL DEFAULT 0,
        prior_confirmed_at INTEGER,
        prior_source_session_id TEXT,
        prior_source_message_id TEXT
      );

CREATE TABLE memory_suggestions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        doc TEXT NOT NULL,
        agent_id TEXT,
        op TEXT NOT NULL,
        line_seq INTEGER,
        current_text TEXT,
        text TEXT,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        reported_at INTEGER
      );

CREATE TABLE history_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message_id TEXT,
        run_id TEXT,
        kind TEXT NOT NULL,
        tool_name TEXT,
        pi_entry_id TEXT,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0,
        embed_failed INTEGER NOT NULL DEFAULT 0
      );

CREATE VIRTUAL TABLE history_fts USING fts5(text, content = '', contentless_delete = 1);

CREATE TABLE memory_vector_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        identity TEXT NOT NULL,
        model TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        quant TEXT NOT NULL,
        dims INTEGER NOT NULL,
        pooling TEXT NOT NULL,
        doc_template TEXT NOT NULL,
        query_template TEXT NOT NULL,
        build TEXT NOT NULL,
        remote INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

CREATE TABLE history_vectors (
        set_id INTEGER NOT NULL,
        entry_id INTEGER NOT NULL,
        vec BLOB,
        PRIMARY KEY (set_id, entry_id)
      ) WITHOUT ROWID;

-- The queue between "SQLite decided what is searchable" and "the search service knows it". One row per entry: the
-- latest intent wins, so a deleted chunk cannot be queued for indexing behind an older copy of itself. Everything
-- here is derived state; the entries table is what is true, and the retrieval service can be rebuilt from it.
CREATE TABLE retrieval_outbox (
        entry_id INTEGER PRIMARY KEY,
        point_id TEXT,
        op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
        seq INTEGER NOT NULL,
        queued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );

CREATE INDEX retrieval_outbox_due ON retrieval_outbox(next_attempt_at);

CREATE TABLE step_images (
        step_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        blob TEXT NOT NULL,
        mime TEXT NOT NULL,
        PRIMARY KEY (step_id, idx)
      ) WITHOUT ROWID;

CREATE TABLE attachment_refs (
        attachment_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT,
        PRIMARY KEY (attachment_id, session_id)
      ) WITHOUT ROWID;

CREATE INDEX attachment_refs_session ON attachment_refs(session_id);

CREATE TABLE edit_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        at INTEGER NOT NULL,
        author TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        field TEXT NOT NULL,
        before_text TEXT,
        after_text TEXT
      );

CREATE TABLE triggers (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        schedule_json TEXT NOT NULL,
        action_json TEXT NOT NULL,
        landing TEXT NOT NULL,
        ongoing_session_id TEXT,
        report TEXT NOT NULL,
        hide_in_list INTEGER NOT NULL DEFAULT 0 CHECK (hide_in_list IN (0, 1)),
        lateness_minutes INTEGER NOT NULL,
        profile TEXT NOT NULL,
        allow_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        paused_reason TEXT,
        failures INTEGER NOT NULL DEFAULT 0,
        next_fire_at INTEGER,
        created_by_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      , catch_up TEXT NOT NULL DEFAULT 'once', overlap TEXT NOT NULL DEFAULT 'skip');

CREATE TABLE trigger_runs (
        id TEXT PRIMARY KEY,
        trigger_id TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        manual INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        reason TEXT,
        session_id TEXT,
        run_id TEXT,
        skill_version INTEGER,
        report TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        last_run_id TEXT,
        last_run_status TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        last_reply TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (trigger_id, scheduled_at, attempt)
      );

CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        current_version INTEGER NOT NULL,
        agents_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE skill_versions (
        skill_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        files_json TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        author TEXT NOT NULL,
        session_id TEXT,
        note TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (skill_id, version)
      ) WITHOUT ROWID;

CREATE TABLE skill_uses (
        run_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (run_id, skill_id)
      ) WITHOUT ROWID;

CREATE TABLE push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_ok_at INTEGER,
        failures INTEGER NOT NULL DEFAULT 0
      
      , device_id TEXT, kind TEXT NOT NULL DEFAULT 'webpush' CHECK (kind IN ('webpush', 'apns', 'fcm')));

CREATE TABLE notification_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        app_url TEXT
      , push_preview INTEGER NOT NULL DEFAULT 1);

CREATE TABLE notify_deliveries (
        outbox_id INTEGER NOT NULL,
        destination TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        PRIMARY KEY (outbox_id, destination)
      ) WITHOUT ROWID;

CREATE TABLE connector_settings (
        connector_id TEXT PRIMARY KEY,
        holds_private INTEGER NOT NULL DEFAULT 1
      ) WITHOUT ROWID;

CREATE TABLE tool_overrides (
        connector_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        action_class TEXT NOT NULL,
        PRIMARY KEY (connector_id, tool)
      ) WITHOUT ROWID;

CREATE TABLE usage_daily (
        day TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('chat', 'memory', 'title', 'agent_task', 'other')),
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        input_total INTEGER NOT NULL DEFAULT 0 CHECK (input_total >= 0),
        input_total_known INTEGER NOT NULL DEFAULT 0 CHECK (input_total_known >= 0),
        input_cached INTEGER NOT NULL DEFAULT 0 CHECK (input_cached >= 0),
        input_cached_known INTEGER NOT NULL DEFAULT 0 CHECK (input_cached_known >= 0),
        input_uncached INTEGER NOT NULL DEFAULT 0 CHECK (input_uncached >= 0),
        input_uncached_known INTEGER NOT NULL DEFAULT 0 CHECK (input_uncached_known >= 0),
        output_total INTEGER NOT NULL DEFAULT 0 CHECK (output_total >= 0),
        output_total_known INTEGER NOT NULL DEFAULT 0 CHECK (output_total_known >= 0),
        total_processed INTEGER NOT NULL DEFAULT 0 CHECK (total_processed >= 0),
        total_processed_known INTEGER NOT NULL DEFAULT 0 CHECK (total_processed_known >= 0),
        reasoning_output INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_output >= 0),
        reasoning_output_known INTEGER NOT NULL DEFAULT 0 CHECK (reasoning_output_known >= 0),
        cache_pair_input INTEGER NOT NULL DEFAULT 0 CHECK (cache_pair_input >= 0),
        cache_pair_cached INTEGER NOT NULL DEFAULT 0 CHECK (cache_pair_cached >= 0),
        calls_reported INTEGER NOT NULL DEFAULT 0 CHECK (calls_reported >= 0),
        calls_unreported INTEGER NOT NULL DEFAULT 0 CHECK (calls_unreported >= 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (day, purpose, provider, model, agent_id)
      ) WITHOUT ROWID;

CREATE TABLE memory_review_jobs (
        source_run_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        source_ids TEXT NOT NULL,
        memory_revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        diagnostic TEXT
      );

CREATE TABLE memory_review_turns (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        job_id TEXT
      );

-- An attachment's bytes live in the object store (M11): object_id points at the row that says where, and which state
-- that object is in. The size column is what the user's file holds; the stored object also carries the attachment's envelope.
CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        object_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      , retained INTEGER NOT NULL DEFAULT 0, file_id TEXT, version_id TEXT);

CREATE TABLE library_files (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, origin TEXT NOT NULL,
        creator TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        folder_id TEXT, favorite INTEGER NOT NULL DEFAULT 0,
        trashed_at INTEGER, purged_at INTEGER, current_version TEXT NOT NULL,
        taint TEXT NOT NULL DEFAULT '["private"]'
      );

CREATE TABLE library_versions (
        id TEXT PRIMARY KEY, file_id TEXT NOT NULL, number INTEGER NOT NULL,
        attachment_id TEXT NOT NULL UNIQUE, creator TEXT NOT NULL, created_at INTEGER NOT NULL,
        publish_key TEXT UNIQUE, UNIQUE(file_id, number)
      );

CREATE TABLE library_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT);

-- The object store's ledger (M11): every object Rei has put in Garage, and what it intends to do about it. SQLite owns
-- the state; Garage only ever holds bytes. An object is owned while an attachment row names it, and stops being owned
-- when the last one goes, which is what lets a file survive in the Library after the chat that uploaded it is deleted.
-- attempts/next_attempt_at make the delete retryable across restarts without a second table to drift out of step.
CREATE TABLE storage_objects (
        id TEXT PRIMARY KEY,
        bucket TEXT NOT NULL,
        object_key TEXT NOT NULL UNIQUE,
        content_sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','ready','delete_pending','deleted','failed')),
        created_at INTEGER NOT NULL,
        verified_at INTEGER,
        delete_after INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );

CREATE INDEX storage_objects_state ON storage_objects(state, created_at);

CREATE INDEX storage_objects_due ON storage_objects(state, next_attempt_at);

CREATE TABLE library_links (
        file_id TEXT NOT NULL, version_id TEXT NOT NULL, session_id TEXT NOT NULL,
        run_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
        PRIMARY KEY(version_id, session_id, run_id, kind)
      );

CREATE INDEX login_attempts_kind_at ON login_attempts (kind, at);

CREATE INDEX sessions_updated ON sessions (updated_at);

CREATE INDEX steps_run ON steps (run_id, started_at);

CREATE UNIQUE INDEX sessions_spawn_key ON sessions (spawn_key) WHERE spawn_key IS NOT NULL;

CREATE INDEX sessions_parent ON sessions (parent_session_id);

CREATE INDEX sessions_tree ON sessions (tree_id);

CREATE INDEX outbox_state ON outbox (kind, state);

CREATE INDEX approvals_session ON approvals (session_id, status);

CREATE INDEX approvals_status ON approvals (status, expires_at);

CREATE INDEX grants_match ON grants (connector, operation, revoked_at);

CREATE INDEX takeovers_session ON takeovers (session_id, status);

CREATE INDEX takeovers_status ON takeovers (status, expires_at);

CREATE INDEX takeover_acts_takeover ON takeover_acts (takeover_id, seq);

CREATE INDEX memory_lines_doc ON memory_lines (doc, agent_id, removed_at);

CREATE INDEX memory_changes_line ON memory_changes (line_seq, seq);

CREATE INDEX memory_changes_session ON memory_changes (session_id);

CREATE INDEX memory_suggestions_status ON memory_suggestions (status, seq);

CREATE INDEX memory_suggestions_session ON memory_suggestions (session_id);

CREATE UNIQUE INDEX history_entries_message ON history_entries (message_id, chunk_index) WHERE kind <> 'tool';

CREATE UNIQUE INDEX history_entries_tool ON history_entries (session_id, pi_entry_id, chunk_index) WHERE kind = 'tool';

CREATE INDEX history_entries_session ON history_entries (session_id);

CREATE INDEX history_entries_run ON history_entries (run_id);

CREATE INDEX history_vectors_entry ON history_vectors (entry_id);

CREATE INDEX steps_tool_call ON steps (session_id, tool_call_id) WHERE tool_call_id IS NOT NULL;

CREATE INDEX steps_session ON steps (session_id, started_at);

CREATE INDEX triggers_due ON triggers (status, next_fire_at);

CREATE INDEX trigger_runs_trigger ON trigger_runs (trigger_id, created_at);

CREATE INDEX trigger_runs_status ON trigger_runs (status);

CREATE INDEX memory_review_jobs_pending ON memory_review_jobs (status, created_at);

CREATE INDEX memory_review_turns_interval ON memory_review_turns (agent_id, job_id, seq);

CREATE INDEX attachments_age ON attachments(created_at);

CREATE INDEX library_versions_file ON library_versions(file_id, number);

CREATE INDEX library_files_updated ON library_files(updated_at, id);

CREATE INDEX library_links_session ON library_links(session_id, run_id);

CREATE INDEX sessions_agent_history ON sessions (agent_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE INDEX sessions_history ON sessions (updated_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE INDEX steps_context_session ON steps (session_id, started_at DESC, id DESC) WHERE type = 'llm.call';

INSERT INTO notification_settings (id) VALUES (1);
`;
const PLUGIN_SCHEMA = `
CREATE TABLE plugins (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, current_revision INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, agents_json TEXT
);
CREATE TABLE plugin_revisions (
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, package_json TEXT NOT NULL, author TEXT NOT NULL,
  session_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(plugin_id, revision)
);
CREATE TABLE plugin_skills (
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  name TEXT NOT NULL, skill_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(plugin_id, name)
);
CREATE TABLE plugin_retired_connections (connector_id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL);
CREATE TABLE plugin_connections (
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  name TEXT NOT NULL, connector_id TEXT, url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', error TEXT,
  PRIMARY KEY(plugin_id, name)
);
`;
// Knowledge (docs/adr/0001): pages and their revisions, in SQLite. A page's body is Markdown; nested pages only (no
// folder type). activity_at is the latest activity anywhere in the page's subtree, which is the order every listing
// uses. Trashing a page trashes its live subtree under one trash_root, so a restore brings back exactly that action.
const KNOWLEDGE_SCHEMA = `
CREATE TABLE knowledge_pages (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{"tags":[]}',
        body TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL,
        locked INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        system TEXT,
        taint TEXT NOT NULL DEFAULT '["private"]',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        activity_at INTEGER NOT NULL,
        trashed_at INTEGER,
        trash_root TEXT
      );

CREATE INDEX knowledge_pages_parent ON knowledge_pages (parent_id, activity_at DESC) WHERE trashed_at IS NULL;

CREATE INDEX knowledge_pages_activity ON knowledge_pages (updated_at DESC) WHERE trashed_at IS NULL;

CREATE UNIQUE INDEX knowledge_pages_system ON knowledge_pages (system) WHERE system IS NOT NULL;

-- Consecutive writes by the same actor in the same session within the coalescing window update the latest row in place
-- (its revision moves forward with the page), so an autosave burst or a run of appends is one entry in the history.
CREATE TABLE knowledge_revisions (
        page_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{"tags":[]}',
        body TEXT NOT NULL,
        actor TEXT NOT NULL,
        session_id TEXT,
        run_id TEXT,
        external INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (page_id, revision)
      );

CREATE TABLE knowledge_page_tags (
        page_id TEXT NOT NULL REFERENCES knowledge_pages(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        label TEXT NOT NULL,
        PRIMARY KEY (page_id, tag)
      );
CREATE INDEX knowledge_page_tags_tag ON knowledge_page_tags(tag, page_id);

CREATE TABLE knowledge_links (
        from_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('page', 'file')),
        target TEXT NOT NULL,
        PRIMARY KEY (from_id, kind, target)
      );

CREATE INDEX knowledge_links_target ON knowledge_links (kind, target);

-- A tool call that wrote, by its stable key, and what it answered: a replayed call gets the same answer, not a second write.
CREATE TABLE knowledge_calls (key TEXT PRIMARY KEY, result TEXT NOT NULL, page_id TEXT, created_at INTEGER NOT NULL);

-- Keyword search over page sections, with Rei's own tokens (memory/keyword.ts). Derived: rebuilt from the pages.
CREATE VIRTUAL TABLE knowledge_fts USING fts5(tokens, page_id UNINDEXED, section UNINDEXED, path UNINDEXED, text UNINDEXED);
`;
// Meaning search over the same sections (knowledge/meaning.ts). Derived: one vector per distinct section text of a live
// page, keyed by a hash of the text that was embedded, so an edit drops only the vectors of the sections it changed.
// model_key says which embedding model made the vector; vectors of any other model are never compared with a query.
const KNOWLEDGE_VECTORS_SCHEMA = `
CREATE TABLE knowledge_vectors (
        page_id TEXT NOT NULL,
        hash TEXT NOT NULL,
        model_key TEXT NOT NULL,
        vec BLOB NOT NULL,
        PRIMARY KEY (page_id, hash)
      );
`;
/** Manual compaction (`/compact`) requests: one row per user request, written before Pi is asked (version 13). */
const MANUAL_COMPACTION_SCHEMA = `
CREATE TABLE manual_compactions (
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        instructions_digest TEXT NOT NULL,
        task_id TEXT,
        submission_id TEXT,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, request_id)
      );

CREATE INDEX manual_compactions_open ON manual_compactions (session_id, status);
`;
/**
 * Version 15: devices, the delivery channels they own, and read markers (multi-client readiness). A session's unread
 * count (`sessions.unread`) is the number of its agent entries (visible replies and trigger lines; the transcript is Pi's,
 * so Rei keeps when each one landed) after its read marker.
 */
const DEVICES_SCHEMA = `
CREATE TABLE read_markers (
        session_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL,
        item_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE agent_entries (
        session_id TEXT NOT NULL,
        item_id TEXT,
        at INTEGER NOT NULL
      );

CREATE INDEX agent_entries_session ON agent_entries (session_id, at);
CREATE UNIQUE INDEX agent_entries_item ON agent_entries (session_id, item_id) WHERE item_id IS NOT NULL;
`;

// Passkeys (ADR 0016). Additive and idempotent, so a database created before passkeys gains the tables on its next start
// without a schema-version bump (older databases are never migrated, and this needs no migration).
const PASSKEY_SCHEMA = `
CREATE TABLE IF NOT EXISTS passkeys (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL DEFAULT '',
        label TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );

CREATE TABLE IF NOT EXISTS passkey_challenges (
        id TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
`;

// Web search counters (additive and idempotent, like PASSKEY_SCHEMA). Counters only: no queries or results.
// Web Reading v2: the pages web_fetch read, kept per agent so a page is fetched once and re-read without the network.
// The readable text only, never raw HTML. Rows go with their agent, or with the session that last fetched them
// (purgeSessions); expired rows are dropped on start and on every write. Additive and idempotent: no version bump.
const WEB_READING_SCHEMA = `
CREATE TABLE IF NOT EXISTS web_documents (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        url TEXT NOT NULL,
        final_url TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        note TEXT,
        quality TEXT NOT NULL,
        extractor TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'http',
        sections_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        chars INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER NOT NULL,
        UNIQUE (agent_id, url)
      );
CREATE INDEX IF NOT EXISTS web_documents_expiry ON web_documents (expires_at);
CREATE INDEX IF NOT EXISTS web_documents_session ON web_documents (session_id);
CREATE INDEX IF NOT EXISTS web_documents_agent_used ON web_documents (agent_id, used_at);
CREATE TABLE IF NOT EXISTS web_calls (
        key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS web_calls_session ON web_calls (session_id);
CREATE TABLE IF NOT EXISTS web_passages (
        id INTEGER PRIMARY KEY,
        document_id TEXT NOT NULL,
        ord INTEGER NOT NULL,
        section_id TEXT NOT NULL,
        heading_path TEXT NOT NULL,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        tokens INTEGER NOT NULL
      );
CREATE INDEX IF NOT EXISTS web_passages_document ON web_passages (document_id, ord);
CREATE VIRTUAL TABLE IF NOT EXISTS web_passages_fts USING fts5(heading, body, content = '', contentless_delete = 1);
CREATE TRIGGER IF NOT EXISTS web_documents_passages AFTER DELETE ON web_documents BEGIN
  DELETE FROM web_passages WHERE document_id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS web_passages_fts_delete AFTER DELETE ON web_passages BEGIN
  DELETE FROM web_passages_fts WHERE rowid = old.id;
END;
`;

const SEARCH_USAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS search_usage_requests (
        day TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('answered', 'empty', 'failed')),
        with_fallback INTEGER NOT NULL CHECK (with_fallback IN (0, 1)),
        calls INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, outcome, with_fallback)
      ) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS search_usage_attempts (
        day TEXT NOT NULL,
        provider TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'empty', 'failed', 'skipped')),
        reason TEXT NOT NULL DEFAULT '',
        fallback INTEGER NOT NULL CHECK (fallback IN (0, 1)),
        calls INTEGER NOT NULL DEFAULT 0,
        total_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, provider, outcome, reason, fallback)
      ) WITHOUT ROWID;
`;
// Image generation counters, like search usage: counts and time only, never prompts or images. Additive and idempotent.
const IMAGE_USAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS image_usage (
        day TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('generate', 'edit')),
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
        reason TEXT NOT NULL DEFAULT '',
        calls INTEGER NOT NULL DEFAULT 0,
        total_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, kind, outcome, reason)
      ) WITHOUT ROWID;
`;
// Outside events (ADR 0019). Additive and idempotent, like PASSKEY_SCHEMA: an existing database gains them on its next start.
// A source's secrets are kept encrypted (events/sources.ts); an event is only a type and a reference.
const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS event_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        secret TEXT NOT NULL,
        previous_secret TEXT,
        previous_expires_at INTEGER,
        created_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        webhook_id TEXT NOT NULL,
        type TEXT NOT NULL,
        ref TEXT NOT NULL,
        occurred_at TEXT,
        received_at INTEGER NOT NULL,
        runs INTEGER NOT NULL DEFAULT 0,
        UNIQUE (source, webhook_id)
      );
CREATE INDEX IF NOT EXISTS events_source_time ON events (source, received_at);

-- The events a run was started for. The type, ref and time are copied so the run's history outlives the 7 days events are kept.
CREATE TABLE IF NOT EXISTS trigger_run_events (
        run_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        type TEXT NOT NULL,
        ref TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, event_id)
      );
`;

/** How a trigger starts (ADR 0019): a schedule (its schedule_json) or events from a source (event_json). Additive. */
function ensureTriggerStartColumns(db: Db): void {
  const columns = new Set(db.all<{ name: string }>("PRAGMA table_info(triggers)").map((c) => c.name));
  if (!columns.has("start_kind"))
    db.exec("ALTER TABLE triggers ADD COLUMN start_kind TEXT NOT NULL DEFAULT 'schedule'");
  if (!columns.has("event_json")) db.exec("ALTER TABLE triggers ADD COLUMN event_json TEXT");
  if (!columns.has("hide_in_list")) {
    db.exec("ALTER TABLE triggers ADD COLUMN hide_in_list INTEGER NOT NULL DEFAULT 0 CHECK (hide_in_list IN (0, 1))");
    db.exec("UPDATE triggers SET hide_in_list = CASE WHEN report = 'never' THEN 0 ELSE 1 END");
  }
  const sessionColumns = new Set(db.all<{ name: string }>("PRAGMA table_info(sessions)").map((c) => c.name));
  if (!sessionColumns.has("hide_in_list")) {
    db.exec("ALTER TABLE sessions ADD COLUMN hide_in_list INTEGER NOT NULL DEFAULT 0 CHECK (hide_in_list IN (0, 1))");
    db.exec(
      "UPDATE sessions SET hide_in_list = COALESCE((SELECT t.hide_in_list FROM triggers t WHERE t.id = sessions.trigger_id), 1) WHERE origin = 'trigger'",
    );
  }
  const runColumns = new Set(db.all<{ name: string }>("PRAGMA table_info(trigger_runs)").map((c) => c.name));
  if (!runColumns.has("dropped_events"))
    db.exec("ALTER TABLE trigger_runs ADD COLUMN dropped_events INTEGER NOT NULL DEFAULT 0");
}

/** Everything outside events add to a database; safe to run on every start and from the admin CLI. */
export function ensureEventsSchema(db: Db): void {
  db.exec(EVENTS_SCHEMA);
  ensureTriggerStartColumns(db);
}

/** Backup runs (docs/backup-user.md): one row per run, scheduled or manual. Added to a database of any upgradable version. */
export const BACKUP_SCHEMA = `
CREATE TABLE IF NOT EXISTS backup_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  snapshot_id TEXT,
  bytes_added INTEGER,
  counts TEXT,
  error TEXT,
  maintenance TEXT
);
CREATE INDEX IF NOT EXISTS backup_runs_started ON backup_runs (started_at);
`;

/**
 * The notification categories a device turned off (packages/protocol, NOTIFY_CATEGORIES): a row is a muted category, so a
 * device that never chose receives everything, and a category added later reaches it. Additive and idempotent, like
 * PASSKEY_SCHEMA. Rows go with their device.
 */
const NOTIFY_DEVICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS device_notification_muted (
        device_id TEXT NOT NULL,
        category TEXT NOT NULL,
        PRIMARY KEY (device_id, category)
      ) WITHOUT ROWID;
`;

export const SCHEMA_VERSION = 20;
/**
 * The oldest schema this release upgrades in place. Each release upgrades a database from at least the previous minor
 * release (docs/versioning.md#database-upgrades); anything older, or newer than SCHEMA_VERSION, is refused untouched.
 */
const OLDEST_UPGRADABLE = 18;

/** Why a database with this user_version is refused, pointing at the way back: the release that wrote it, or a backup. */
function refusal(version: number): string {
  if (version > SCHEMA_VERSION)
    return `This database was written by a newer Rei (schema ${version}; this release reads up to ${SCHEMA_VERSION}). Rei does not downgrade a database: run that newer release again, or restore the backup taken before the upgrade (docs/storage.md#backup-and-recovery). Nothing was changed.`;
  return `This database uses schema ${version}, older than this release upgrades (${OLDEST_UPGRADABLE} to ${SCHEMA_VERSION}). Upgrade through the releases in between first (docs/versioning.md#database-upgrades), or restore a backup (docs/storage.md#backup-and-recovery). Nothing was changed.`;
}

function ensureApprovalCheckpointColumns(db: Db): void {
  const columns = new Set(db.all<{ name: string }>("PRAGMA table_info(approvals)").map((c) => c.name));
  if (!columns.has("group_id")) db.exec("ALTER TABLE approvals ADD COLUMN group_id TEXT");
  if (!columns.has("tool_call_id")) db.exec("ALTER TABLE approvals ADD COLUMN tool_call_id TEXT");
  if (!columns.has("tool_task_id")) db.exec("ALTER TABLE approvals ADD COLUMN tool_task_id TEXT");
  if (!columns.has("execution"))
    db.exec("ALTER TABLE approvals ADD COLUMN execution TEXT CHECK (execution IN ('ran', 'failed', 'needs_approval'))");
  if (!columns.has("execution_interrupted"))
    db.exec("ALTER TABLE approvals ADD COLUMN execution_interrupted INTEGER NOT NULL DEFAULT 0");
  // A script's nested call: the `codemode` call it belongs under, and why its approval was withdrawn when the script ended.
  if (!columns.has("parent_call_id")) db.exec("ALTER TABLE approvals ADD COLUMN parent_call_id TEXT");
  if (!columns.has("cancel_reason"))
    db.exec("ALTER TABLE approvals ADD COLUMN cancel_reason TEXT CHECK (cancel_reason IN ('script_ended'))");
  db.exec("CREATE INDEX IF NOT EXISTS approval_checkpoint_run ON approvals (run_id) WHERE group_id IS NOT NULL");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS approval_group_call ON approvals (group_id, tool_call_id) WHERE group_id IS NOT NULL",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS approval_tool_task ON approvals (session_id, tool_task_id) WHERE tool_task_id IS NOT NULL",
  );
  db.exec("CREATE INDEX IF NOT EXISTS approval_task_run ON approvals (run_id) WHERE tool_task_id IS NOT NULL");
}

/** Prompt-reuse columns on steps (additive, like PASSKEY_SCHEMA: an existing database gains them on its next start). */
function ensureStepPrefixColumns(db: Db): void {
  const columns = new Set(db.all<{ name: string }>("PRAGMA table_info(steps)").map((c) => c.name));
  if (!columns.has("prefix_items")) db.exec("ALTER TABLE steps ADD COLUMN prefix_items INTEGER");
  if (!columns.has("input_items")) db.exec("ALTER TABLE steps ADD COLUMN input_items INTEGER");
  // A script's nested call: the step of the `codemode` call it was made under (null for every other step).
  if (!columns.has("parent_step_id")) db.exec("ALTER TABLE steps ADD COLUMN parent_step_id TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS steps_parent ON steps (session_id, parent_step_id) WHERE parent_step_id IS NOT NULL",
  );
}

/**
 * Cache hit pairs input with cached tokens only for calls that report both, and not the first model call of a run
 * (usage_daily.cache_pair_*). Existing rows are
 * backfilled where their input and cached reports agree. Cached is only ever reported together with input, so such a row's
 * input sum is exactly the paired input; a row that disagrees keeps zero and is left out of cache hit.
 */
function ensureUsageCachePairColumns(db: Db): void {
  const columns = new Set(db.all<{ name: string }>("PRAGMA table_info(usage_daily)").map((c) => c.name));
  if (columns.has("cache_pair_input")) return;
  db.exec(
    "ALTER TABLE usage_daily ADD COLUMN cache_pair_input INTEGER NOT NULL DEFAULT 0 CHECK (cache_pair_input >= 0)",
  );
  db.exec(
    "ALTER TABLE usage_daily ADD COLUMN cache_pair_cached INTEGER NOT NULL DEFAULT 0 CHECK (cache_pair_cached >= 0)",
  );
  db.exec(
    "UPDATE usage_daily SET cache_pair_input = input_total, cache_pair_cached = input_cached WHERE input_total_known = input_cached_known",
  );
}

// Message versions (Retry and Edit rewind a chat in place). One row per Pi conversation a session has had: the session's
// original (written on its first rewind, with no parent) and each rewind's fork. `sessions.pi_conversation_id` names the
// active one. `cut_entry_id` is the last entry kept from the parent (NULL: nothing kept, a rewind of the first message).
// Additive and idempotent, like PASSKEY_SCHEMA. Rows go with their session (purgeSessions).
const SESSION_BRANCHES_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_branches (
        session_id TEXT NOT NULL,
        pi_conversation_id TEXT NOT NULL,
        parent_conversation_id TEXT,
        cut_entry_id TEXT,
        replaced_message_id TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, pi_conversation_id)
      );
`;

// Imported chats (docs/importing.md): one row per source chat, so a repeat import finds the session it made. `pending`
// until every entry is written; a pending row left by a crash is redone. Additive and idempotent, like PASSKEY_SCHEMA.
// The row goes with its session (purgeSessions), so a deleted import can be imported again.
const SESSION_IMPORTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_imports (
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source, source_id)
      );
CREATE INDEX IF NOT EXISTS session_imports_session ON session_imports (session_id);
`;

/**
 * Which conversation of its session wrote a history entry, and whether a rewind or a version switch took it out of the
 * active chain (`branch_hidden`: the row is also `hidden`, and comes back when its version is active again). Additive:
 * existing rows are backfilled with their session's conversation, which was the only one before versions existed.
 */
function ensureHistoryBranchColumns(db: Db): void {
  const columns = new Set(db.all<{ name: string }>("PRAGMA table_info(history_entries)").map((c) => c.name));
  if (!columns.has("pi_conversation_id")) {
    db.exec("ALTER TABLE history_entries ADD COLUMN pi_conversation_id TEXT");
    db.exec(
      "UPDATE history_entries SET pi_conversation_id = (SELECT pi_conversation_id FROM sessions s WHERE s.id = history_entries.session_id)",
    );
  }
  if (!columns.has("branch_hidden"))
    db.exec("ALTER TABLE history_entries ADD COLUMN branch_hidden INTEGER NOT NULL DEFAULT 0");
}

/** How a stored page was read (Web Reading v2 ticket 09): additive, an existing database gains it on its next start. */
function ensureWebDocumentColumns(db: Db): void {
  const columns = new Set(db.all<{ name: string }>("PRAGMA table_info(web_documents)").map((c) => c.name));
  if (!columns.has("method")) db.exec("ALTER TABLE web_documents ADD COLUMN method TEXT NOT NULL DEFAULT 'http'");
}

/**
 * Version 20 maps sandbox network modes from versions 18 and 19. SQLite cannot change a
 * CHECK constraint in place, so the agents table is rebuilt with the new one and its rows are mapped in the same transaction.
 * No other table refers to agents. An unknown stored mode makes the mapping produce NULL, which the NOT NULL constraint refuses,
 * so the upgrade rolls back rather than guessing.
 */
function renameNetworkModes(db: Db): void {
  db.exec(`
CREATE TABLE agents_v20 (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        home_session_id TEXT,
        created_at INTEGER NOT NULL
      , default_profile TEXT NOT NULL DEFAULT 'standard', model TEXT, allowed_connector_ids TEXT, thinking_level TEXT NOT NULL DEFAULT 'off'
      CHECK (thinking_level IN ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')),
        network_mode TEXT NOT NULL DEFAULT 'block' CHECK (network_mode IN ('block', 'whitelist', 'any')));
INSERT INTO agents_v20 SELECT id, name, avatar, instructions, home_session_id, created_at, default_profile, model,
        allowed_connector_ids, thinking_level,
        CASE
          WHEN network_mode IN ('off', 'ask') THEN 'block'
          WHEN network_mode IN ('restricted', 'whitelist') THEN 'whitelist'
          WHEN network_mode IN ('full', 'any_site') THEN 'any'
        END
      FROM agents;
DROP TABLE agents;
ALTER TABLE agents_v20 RENAME TO agents;
`);
}

/**
 * Opens the current fresh schema. A database from OLDEST_UPGRADABLE on is upgraded in place (18 and 19: see
 * renameNetworkModes); an older or newer one is refused with the way back, and is never migrated or reset automatically.
 */
export function initializeDatabase(db: Db, now: () => number = () => Date.now()): boolean {
  return db.transaction(() => {
    const version = db.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
    if (version >= OLDEST_UPGRADABLE && version <= SCHEMA_VERSION) {
      const columns = db.all<{ name: string }>("PRAGMA table_info(knowledge_pages)");
      if (!columns.some((c) => c.name === "metadata_json"))
        throw new Error(
          "This development database uses the earlier Knowledge schema. No automatic migration or reset is performed. Preserve this data directory and use a fresh one; see docs/knowledge-frontmatter.md.",
        );
      if (version < SCHEMA_VERSION) {
        renameNetworkModes(db);
        const at = now();
        db.run(
          "UPDATE approvals SET status = 'expired', decided_at = ?, notified_at = ? WHERE tool = 'network' AND status = 'pending'",
          at,
          at,
        );
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }
      db.exec(PASSKEY_SCHEMA);
      db.exec(SEARCH_USAGE_SCHEMA);
      db.exec(IMAGE_USAGE_SCHEMA);
      db.exec(WEB_READING_SCHEMA);
      ensureWebDocumentColumns(db);
      ensureStepPrefixColumns(db);
      ensureEventsSchema(db);
      ensureUsageCachePairColumns(db);
      db.exec(SESSION_BRANCHES_SCHEMA);
      ensureHistoryBranchColumns(db);
      ensureApprovalCheckpointColumns(db);
      db.exec(SESSION_IMPORTS_SCHEMA);
      db.exec(BACKUP_SCHEMA);
      db.exec(NOTIFY_DEVICE_SCHEMA);
      if (
        !db
          .all<{ name: string }>("PRAGMA table_info(agents)")
          .some((c) => c.name === "can_create_triggers_for_other_agents")
      )
        db.exec(`ALTER TABLE agents ADD COLUMN can_create_triggers_for_other_agents INTEGER NOT NULL DEFAULT 0
          CHECK (can_create_triggers_for_other_agents IN (0, 1))`);
      return false;
    }
    if (version !== 0) throw new Error(refusal(version));
    const existing = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")!.n;
    if (existing > 0) throw new Error("This database is not a Rei installation. Start with an empty data directory.");
    db.exec(SCHEMA);
    db.run("INSERT INTO meta (key, value) VALUES ('installed_at', ?)", String(now()));
    db.exec(PLUGIN_SCHEMA);
    db.exec(KNOWLEDGE_SCHEMA);
    db.exec(KNOWLEDGE_VECTORS_SCHEMA);
    db.exec(MANUAL_COMPACTION_SCHEMA);
    db.exec(DEVICES_SCHEMA);
    db.exec(BACKGROUND_SCHEMA);
    db.exec(PASSKEY_SCHEMA);
    db.exec(SEARCH_USAGE_SCHEMA);
    db.exec(IMAGE_USAGE_SCHEMA);
    db.exec(WEB_READING_SCHEMA);
    ensureStepPrefixColumns(db);
    ensureEventsSchema(db);
    db.exec(SESSION_BRANCHES_SCHEMA);
    ensureHistoryBranchColumns(db);
    ensureApprovalCheckpointColumns(db);
    db.exec(SESSION_IMPORTS_SCHEMA);
    db.exec(BACKUP_SCHEMA);
    db.exec(NOTIFY_DEVICE_SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return true;
  });
}
