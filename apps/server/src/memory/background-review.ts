import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Extension } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { lit, obj } from "@earendil-works/pi-schema";
import type {
  BackgroundJob,
  BackgroundTaskService,
  LifecycleEvent,
  TaskContext,
  TaskOutcome,
} from "../background/service.ts";
import type { BlobStore } from "../blobs/blob-store.ts";
import { isInputData } from "../conversation/ledger.ts";
import { MODEL_ONLY } from "../pi/callers.ts";
import { instrumentModels } from "../pi/instrument.ts";
import type { ModelRuntime } from "../pi/models.ts";
import { executePrivateFork, type PrivateSnapshots } from "../pi/private-execution.ts";
import type { StepRecorder } from "../pi/steps.ts";
import type { PiStorageOpener } from "../pi/types.ts";
import type { AppStore } from "../store/store.ts";
import type { MemoryLines } from "./lines.ts";
import { REVIEW_RULES } from "./review-rules.ts";
import type { ReviewAuthority, ReviewSource } from "./review-types.ts";
import { UPDATE_MEMORY_TOOL } from "./reviewer.ts";

interface SourceRow {
  seq: number;
  session_id: string;
  agent_id: string;
  run_id: string;
  message_id: string;
  entry_id: string;
  cut_entry_id: string;
  provider: string | null;
  model: string | null;
  created_at: number;
  job_id: string | null;
}
interface Deps {
  store: AppStore;
  lines: MemoryLines;
  background: BackgroundTaskService;
  runtime: ModelRuntime;
  recorder: StepRecorder;
  snapshots: PrivateSnapshots;
  openStorage: PiStorageOpener;
  blobs: BlobStore;
  policy(authorize: (conversation: string, tool: string) => boolean): Extension;
  gatewayUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}
const INSTRUCTIONS = [
  "Privately review inherited conversation for durable, useful User Memory and this agent's Agent Memory.",
  "No new memory is expected unless supported by new first-party user evidence in the supplied review window. Earlier conversation and current memory only help interpret and deduplicate.",
  REVIEW_RULES,
  "Either call finish_review with outcome no_changes, or call update_memory once with an atomic nonempty batch. Invalid batches may be repaired. Text alone is not completion.",
].join("\n");

export class BackgroundMemoryReview {
  readonly #d: Deps;
  constructor(deps: Deps) {
    this.#d = deps;
    deps.background.subscribe("memory.review.eligibility", (event) => this.#consume(event));
    deps.background.register("memory.review", (job, task) => this.#review(job, task));
  }
  enabled(): boolean {
    return this.#d.store.metaGet("memory_extraction") === "1";
  }
  everyNTurns(): number {
    return Number(this.#d.store.metaGet("memory_review_every") ?? 5);
  }
  setEveryNTurns(value: number): void {
    if (!Number.isInteger(value) || value < 2 || value > 100) throw new Error("INVALID_CADENCE");
    this.#d.store.tx(() => {
      this.#d.store.metaSet("memory_review_every", String(value));
      this.#scheduleAll();
    });
  }
  setEnabled(on: boolean): void {
    if (on === this.enabled()) return;
    const { store, background } = this.#d;
    store.tx(() => {
      store.metaSet("memory_extraction", on ? "1" : "0");
      store.metaSet("background_review_started_at", String(store.clock.now()));
      store.metaSet(
        "background_review_start_event",
        String(store.db.get<{ n: number }>("SELECT COALESCE(MAX(seq),0) AS n FROM lifecycle_outbox")!.n),
      );
      if (!on) {
        store.db.run(
          "UPDATE background_jobs SET status='cancelled',fence=fence+1,diagnostic='DISABLED',finished_at=? WHERE kind='memory.review' AND status IN ('queued','running','failed')",
          store.clock.now(),
        );
        store.db.run("UPDATE memory_review_sources SET job_id='retired' WHERE job_id IS NULL");
      }
    });
    if (!on)
      for (const [id, active] of background.active)
        if (store.db.get<{ kind: string }>("SELECT kind FROM background_jobs WHERE id=?", id)?.kind === "memory.review")
          active.abort.abort();
  }
  async start(): Promise<void> {
    const { store } = this.#d;
    await this.#d.snapshots.sweep();
    if (store.metaGet("background_review_started_at") === undefined) {
      store.tx(() => {
        store.metaSet("background_review_started_at", String(store.clock.now()));
        store.metaSet(
          "background_review_start_event",
          String(store.db.get<{ n: number }>("SELECT COALESCE(MAX(seq),0) AS n FROM lifecycle_outbox")!.n),
        );
      });
    }
    this.#scheduleAll();
  }
  async stop(): Promise<void> {
    /* Shared executor owns shutdown. */
  }
  async settle(): Promise<void> {
    await Promise.allSettled([...this.#d.background.active.values()].map((a) => a.promise));
  }
  #consume(event: LifecycleEvent): void {
    const { store } = this.#d;
    const eventPosition =
      store.db.get<{ seq: number }>("SELECT seq FROM lifecycle_outbox WHERE id=?", event.id)?.seq ?? 0;
    if (eventPosition <= Number(store.metaGet("background_review_start_event") ?? 0)) return;
    if (
      event.kind !== "run.completed" ||
      !event.eligible ||
      !this.enabled() ||
      event.created_at < Number(store.metaGet("background_review_started_at")) ||
      !event.run_id ||
      !event.input_entry_id ||
      !event.cut_entry_id ||
      !store.getSessionRow(event.session_id) ||
      store.agentCapabilities(event.agent_id).memory !== "read_write"
    )
      return;
    store.db.run(
      "INSERT OR IGNORE INTO memory_review_sources(session_id,agent_id,run_id,message_id,entry_id,cut_entry_id,provider,model,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      event.session_id,
      event.agent_id,
      event.run_id,
      `u:${event.run_id}`,
      event.input_entry_id,
      event.cut_entry_id,
      event.provider,
      event.model,
      event.created_at,
    );
    store.db.run(
      "INSERT OR IGNORE INTO memory_review_state(session_id,agent_id) VALUES(?,?)",
      event.session_id,
      event.agent_id,
    );
    this.#schedule(event.session_id);
  }
  #scheduleAll(): void {
    if (!this.enabled()) return;
    for (const row of this.#d.store.db.all<{ session_id: string }>(
      "SELECT DISTINCT session_id FROM memory_review_sources WHERE job_id IS NULL",
    ))
      this.#schedule(row.session_id);
  }
  #schedule(sessionId: string): void {
    const { store, background } = this.#d;
    if (!store.getSessionRow(sessionId)) return;
    for (;;) {
      const rows = store.db.all<SourceRow>(
        "SELECT * FROM memory_review_sources WHERE session_id=? AND job_id IS NULL ORDER BY seq LIMIT ?",
        sessionId,
        this.everyNTurns(),
      );
      if (rows.length < this.everyNTurns()) break;
      const last = rows.at(-1)!;
      const id = background.enqueue({
        kind: "memory.review",
        dedupe: `memory.review:${sessionId}:${rows[0]!.seq}:${last.seq}`,
        sessionId,
        agentId: last.agent_id,
        payload: {
          sourceRunId: last.run_id,
          cut: last.cut_entry_id,
          through: last.seq,
          provider: last.provider,
          model: last.model,
        },
      });
      for (const row of rows)
        store.db.run("UPDATE memory_review_sources SET job_id=? WHERE seq=? AND job_id IS NULL", id, row.seq);
    }
  }
  async #review(job: BackgroundJob, task: TaskContext): Promise<TaskOutcome> {
    const { store, lines, runtime } = this.#d;
    const payload = JSON.parse(job.payload) as {
      sourceRunId: string;
      cut: string;
      through: number;
      provider: string | null;
      model: string | null;
    };
    const source = job.session_id ? store.getSessionRow(job.session_id) : undefined;
    if (!source || !payload.provider || !payload.model) throw new Error("SOURCE_MODEL_UNAVAILABLE");
    if (!runtime.models.getModel(payload.provider, payload.model)) throw new Error("SOURCE_MODEL_UNAVAILABLE");
    await runtime.refreshCredential();
    const rows = store.db.all<SourceRow>("SELECT * FROM memory_review_sources WHERE job_id=? ORDER BY seq", job.id);
    if (!rows.length) throw new Error("STALE_SOURCE");
    let outcome: TaskOutcome | undefined;
    let lastDiagnostic = "REVIEW_COMPLETION_REQUIRED";
    let authority: ReviewAuthority | undefined;
    let conversation: string | undefined;
    let providerSession: string | undefined;
    let calls = 0;
    let startChange = store.db.get<{ n: number }>("SELECT COALESCE(MAX(seq),0) AS n FROM memory_changes")!.n;
    const signal = AbortSignal.any([task.signal, AbortSignal.timeout(60_000)]);
    const valid = () => {
      task.assertLive();
      if (signal.aborted) return false;
      return (
        this.enabled() &&
        store.agentCapabilities(job.agent_id).memory === "read_write" &&
        rows.every(
          (row) =>
            store.db.get(
              "SELECT 1 FROM memory_review_sources r JOIN sessions s ON s.id=r.session_id WHERE r.seq=? AND r.job_id=? AND r.entry_id=? AND r.agent_id=? AND s.agent_id=r.agent_id AND s.deleted_at IS NULL AND s.status<>'deleting'",
              row.seq,
              job.id,
              row.entry_id,
              job.agent_id,
            ) !== undefined,
        )
      );
    };
    const complete = (applied: boolean) => {
      if (!valid()) throw new Error("STALE_SOURCE");
      const changeIds = store.db
        .all<{ id: string }>(
          "SELECT id FROM memory_changes WHERE seq>? AND session_id=? ORDER BY seq",
          startChange,
          job.session_id,
        )
        .map((r) => r.id);
      outcome = {
        status: applied ? "succeeded" : "no_changes",
        result: { changeIds, sourceRunId: payload.sourceRunId, cut: payload.cut, through: payload.through },
      };
      store.db.run("UPDATE memory_review_state SET reviewed_seq=? WHERE session_id=?", payload.through, job.session_id);
      if (applied)
        store.addMemoryMessage(
          job.session_id!,
          payload.sourceRunId,
          `Memory updated · ${changeIds.length} changes`,
          job.id,
          { change: lines.change(changeIds[0]!)!, review: { jobId: job.id, changeIds } },
        );
      task.complete(outcome);
    };
    const update = defineTool({
      ...UPDATE_MEMORY_TOOL,
      callers: MODEL_ONLY,
      execute: async (args) => {
        if (outcome || !authority)
          return { isError: true, output: [{ type: "text" as const, text: "REVIEW_FINISHED" }] };
        const changes = typeof args === "object" && args !== null && "changes" in args ? args.changes : undefined;
        if (!Array.isArray(changes) || changes.length === 0)
          return { isError: true, output: [{ type: "text" as const, text: "Use finish_review for no_changes." }] };
        const result = store.tx(() => {
          startChange = store.db.get<{ n: number }>("SELECT COALESCE(MAX(seq),0) AS n FROM memory_changes")!.n;
          return lines.applyReviewChanges(authority!, changes);
        });
        if (!result.ok) {
          lastDiagnostic = result.code;
          outcome = undefined;
        }
        return {
          isError: !result.ok,
          output: [{ type: "text" as const, text: JSON.stringify(result) }],
          ...(result.ok || ["CAS_CONFLICT", "STALE_SOURCE", "JOB_NOT_RUNNING", "STOPPED"].includes(result.code)
            ? { control: { terminate: true } }
            : {}),
        };
      },
    });
    const finish = defineTool({
      name: "finish_review",
      callers: MODEL_ONLY,
      description: "Complete successfully without writing memory.",
      parameters: obj({ outcome: lit("no_changes") }),
      execute: async () => {
        try {
          store.tx(() => complete(false));
        } catch (error) {
          outcome = undefined;
          throw error;
        }
        return { output: [{ type: "text" as const, text: "no_changes" }], control: { terminate: true } };
      },
    });
    const extension = defineExtension({ name: "memory_review", tools: [update, finish] });
    const policy = this.#d.policy((id, tool) => {
      try {
        return id === conversation && ["finish_review", "update_memory"].includes(tool) && valid();
      } catch {
        return false;
      }
    });
    const models = instrumentModels(runtime.models, {
      maxInputTokens: 128_000,
      maxOutputTokens: 1536,
      recorder: this.#d.recorder,
      resolveCall: (options) => {
        if (!providerSession || options.sessionId !== providerSession || !valid() || ++calls > 4)
          throw new Error("REVIEW_CALL_LIMIT");
        return {
          sessionId: job.session_id!,
          runId: job.id,
          purpose: "memory",
          agentId: job.agent_id,
          deadlines: { firstEventMs: 20_000, idleMs: 20_000, totalMs: 60_000 },
        };
      },
      beforeCall: () => {
        if (runtime.mode === "faux") runtime.arm();
      },
      syntheticPayload: runtime.mode === "faux",
      ...(this.#d.gatewayUrl ? { gatewayUrl: this.#d.gatewayUrl } : {}),
      ...(this.#d.fetchImpl ? { fetchImpl: this.#d.fetchImpl } : {}),
      scrub: (text) => runtime.scrub(text),
    });
    try {
      await executePrivateFork(this.#d.snapshots, this.#d.openStorage, {
        sourceTree: source.tree_id,
        sourceConversation: source.pi_conversation_id!,
        cut: payload.cut,
        id: `${job.id}_${job.attempt}`,
        model: { provider: payload.provider, modelId: payload.model },
        instructions: INSTRUCTIONS,
        input: "",
        extensions: [extension],
        policy,
        models,
        signal,
        allowedTools: ["update_memory", "finish_review"],
        prepare: async (fork, sessionId) => {
          conversation = String(fork.id);
          providerSession = sessionId;
          const sources: ReviewSource[] = [];
          for (const row of rows) {
            const entry = await fork.commit((tx) => tx.entry(Number(row.entry_id) as never), context);
            if (
              !entry ||
              !isInputData(entry.data) ||
              entry.data.role !== "user" ||
              entry.data.from ||
              entry.data.runId !== row.run_id
            )
              throw new Error("STALE_SOURCE");
            sources.push({
              runId: row.run_id,
              id: row.message_id,
              sessionId: row.session_id,
              agentId: row.agent_id,
              text: entry.data.text,
              createdAt: entry.data.at,
            });
          }
          authority = {
            agentId: job.agent_id,
            revision: lines.revision(),
            sources,
            jobId: job.id,
            validateSources: valid,
            commitOutcome: complete,
          };
          const memory = [...lines.lines("profile", null), ...lines.lines("agent", job.agent_id)].map((line) => ({
            ...line,
            protected: lines.reviewProtected(line.id),
          }));
          return JSON.stringify({
            purpose: "memory.review",
            revision: authority.revision,
            memory,
            sources: sources.map((s) => ({ sourceMessageId: s.id, text: s.text })),
          });
        },
      });
      if (
        !outcome ||
        !store.db.get("SELECT 1 FROM background_jobs WHERE id=? AND status IN ('succeeded','no_changes')", job.id)
      )
        throw new Error(lastDiagnostic);
      return outcome;
    } finally {
      await this.#d.recorder.drain(job.id);
      const usage = store.db.all(
        "SELECT provider,model,input_tokens,output_tokens,cached_tokens FROM steps WHERE run_id=?",
        job.id,
      );
      store.db.run(
        "UPDATE background_attempts SET provider=?,model=?,usage=? WHERE job_id=? AND attempt=?",
        payload.provider,
        payload.model,
        JSON.stringify(usage),
        job.id,
        job.attempt,
      );
      await this.#cleanTraces("run_id=?", job.id);
    }
  }
  async #cleanTraces(where: string, ...params: string[]): Promise<void> {
    const { store, blobs } = this.#d;
    const refs = store.db.all<{ payload_blob: string | null; response_blob: string | null }>(
      `SELECT payload_blob,response_blob FROM steps WHERE ${where}`,
      ...params,
    );
    store.db.run(`DELETE FROM steps WHERE ${where}`, ...params);
    for (const row of refs)
      for (const ref of [row.payload_blob, row.response_blob])
        if (ref && !store.db.get("SELECT 1 FROM steps WHERE payload_blob=? OR response_blob=?", ref, ref))
          await blobs.delete(ref);
  }
}
