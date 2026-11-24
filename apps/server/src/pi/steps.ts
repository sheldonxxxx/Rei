import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ActionClass, CapabilityChange, StepDecision, UsagePurpose } from "@rei/protocol";
import { type BlobStore, blobRefFor } from "../blobs/blob-store.ts";
import type { Db } from "../db/db.ts";
import { normalizeUsage, recordUsageForCompletedStep, type UsageEvidence } from "../usage/accounting.ts";
import type { Clock } from "../util/clock.ts";
import { sha256Hex, utf8 } from "../util/encoding.ts";
import { newId } from "../util/ids.ts";
import type { Logger } from "../util/log.ts";
import type { Deadlines } from "./model-config.ts";

export type DeadlineKind = "first_event" | "idle" | "total";

/** One model call, from the moment the request is prepared to the end of its stream (trace step type `llm.call`). */
export class StepHandle {
  readonly id: string;
  readonly startedAt: number;
  readonly deadlines: Deadlines;
  /** Set by the gateway fetch when it cut the call off. */
  deadline: DeadlineKind | undefined;
  /** Set by the gateway fetch when the gateway could not be reached. */
  gatewayDown = false;
  /** HTTP error status of the most recent attempt, even when the SDK loses it. */
  httpErrorStatus: number | undefined;
  usageEvidence: UsageEvidence | null | undefined;
  firstByteMs: number | undefined;
  /** Aborts whatever request of this step is in flight (the total deadline uses it). */
  abortInFlight: ((reason: unknown) => void) | undefined;
  totalTimer: ReturnType<typeof setTimeout> | undefined;
  totalStartedAt: number | undefined;
  #recorder: StepRecorder;

  constructor(recorder: StepRecorder, id: string, startedAt: number, deadlines: Deadlines) {
    this.#recorder = recorder;
    this.id = id;
    this.startedAt = startedAt;
    this.deadlines = deadlines;
  }

  /** Stores the exact payload pi-ai hands to the provider, before the request leaves. */
  async capture(payload: unknown): Promise<void> {
    await this.#recorder.capture(this.id, payload);
  }

  finish(status: "ok" | "error" | "aborted", message?: AssistantMessage, errorCode?: string): void {
    if (this.totalTimer !== undefined) clearTimeout(this.totalTimer);
    this.#recorder.finish(this, status, message, errorCode);
  }
}

/** Sessions whose last request is kept to measure prompt reuse; the oldest is forgotten first. */
const LAST_ITEMS_KEPT = 500;

/**
 * One hash per request item, in order: first everything outside the item list (model, tools, system prompt, cache key),
 * then each input item. The provider's prompt cache can only reuse the run of leading items that did not change.
 */
export function requestItemHashes(payload: unknown): Promise<string[]> | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const listKey = ["input", "messages", "contents"].find((k) => Array.isArray(p[k]));
  if (!listKey) return undefined;
  const { [listKey]: list, ...head } = p;
  // Serialized now, before any await: the payload is the live object the provider request is sent from.
  const texts = [head, ...(list as unknown[])].map((v) => JSON.stringify(v) ?? "");
  return Promise.all(texts.map(async (t) => (await sha256Hex(t)).slice(0, 24)));
}

export class StepRecorder {
  readonly #pending = new Map<Promise<void>, string | undefined>();
  async drain(runId?: string): Promise<void> {
    await Promise.allSettled(
      [...this.#pending].filter(([, id]) => runId === undefined || id === runId).map(([promise]) => promise),
    );
  }
  readonly #db: Db;
  /** The item hashes of each session's last model request (per usage purpose), to count the reused prefix. */
  readonly #lastItems = new Map<string, string[]>();
  /** Trace payloads (step bodies, breakdowns, screenshots): content-addressed, redactable. */
  readonly #traceBlobs: BlobStore;
  readonly #clock: Clock;
  readonly #log: Logger;

  constructor(db: Db, traceBlobs: BlobStore, clock: Clock, log: Logger) {
    this.#db = db;
    this.#traceBlobs = traceBlobs;
    this.#clock = clock;
    this.#log = log;
  }

  begin(info: {
    sessionId: string | undefined;
    runId: string | undefined;
    provider: string;
    model: string;
    contextWindow?: number | undefined;
    purpose: UsagePurpose;
    agentId?: string | undefined;
    deadlines: Deadlines;
    /** The tool names the request offers, for the Trace. */
    offeredTools?: readonly string[] | undefined;
    /** Which of them are deferred tools search_capabilities loaded, for the context breakdown. */
    loadedTools?: readonly string[] | undefined;
  }): StepHandle {
    const now = this.#clock.now();
    const id = newId("stp", now);
    this.#db.run(
      "INSERT INTO steps (id, run_id, session_id, type, provider, model, status, started_at, side_effect, usage_purpose, usage_agent_id) VALUES (?, ?, ?, 'llm.call', ?, ?, 'running', ?, 0, ?, ?)",
      id,
      info.runId ?? null,
      info.sessionId ?? null,
      info.provider,
      info.model,
      now,
      info.purpose,
      info.agentId ?? "",
    );
    this.#db.run(
      "UPDATE steps SET context_window = ?, offered_tools = ?, loaded_tools = ? WHERE id = ?",
      info.contextWindow ?? null,
      info.offeredTools ? JSON.stringify(info.offeredTools) : null,
      info.loadedTools ? JSON.stringify(info.loadedTools) : null,
      id,
    );
    // The one line that ties a step to its run in the logs; the step's gateway and egress lines carry only stepId.
    this.#log.debug("step.started", {
      stepId: id,
      runId: info.runId,
      sessionId: info.sessionId,
      model: info.model,
      purpose: info.purpose,
    });
    return new StepHandle(this, id, now, info.deadlines);
  }

  async capture(stepId: string, payload: unknown): Promise<void> {
    // Serialized inside onPayload: the object is the live reference pi-ai sends from.
    const bytes = utf8(JSON.stringify(payload));
    const hashing = requestItemHashes(payload);
    const ref = await blobRefFor(bytes);
    const items = hashing ? await hashing : undefined;
    const row = this.#db.get<{ session_id: string | null; usage_purpose: string | null }>(
      "SELECT session_id, usage_purpose FROM steps WHERE id=?",
      stepId,
    );
    if (!row) return;
    this.#db.run("UPDATE steps SET payload_blob = ? WHERE id = ?", ref, stepId);
    if (items && row.session_id) {
      const key = `${row.session_id}:${row.usage_purpose ?? ""}`;
      const before = this.#lastItems.get(key);
      let matched = 0;
      if (before)
        while (matched < before.length && matched < items.length && before[matched] === items[matched]) matched++;
      this.#lastItems.delete(key);
      this.#lastItems.set(key, items);
      if (this.#lastItems.size > LAST_ITEMS_KEPT) this.#lastItems.delete(this.#lastItems.keys().next().value!);
      this.#db.run(
        "UPDATE steps SET prefix_items = ?, input_items = ? WHERE id = ?",
        before ? matched : null,
        items.length,
        stepId,
      );
    }
    await this.#traceBlobs.put(bytes);
    if (!this.#db.get("SELECT 1 FROM steps WHERE id=?", stepId)) await this.#dropUnused(ref);
  }

  finish(
    step: StepHandle,
    status: "ok" | "error" | "aborted",
    message: AssistantMessage | undefined,
    errorCode: string | undefined,
  ): void {
    const now = this.#clock.now();
    const u = message?.usage;
    const recorded = this.#db.transaction(() => {
      if (!this.#db.get("SELECT 1 FROM steps WHERE id = ? AND usage_accounted_at IS NULL", step.id)) return false;
      this.#db.run(
        `UPDATE steps SET status = ?, error_code = ?, latency_ms = ?, first_byte_ms = ?, input_tokens = ?, output_tokens = ?,
           cached_tokens = ?, reasoning_tokens = ?, total_tokens = ? WHERE id = ?`,
        status,
        errorCode ?? null,
        now - step.startedAt,
        step.firstByteMs ?? null,
        u?.input ?? null,
        u?.output ?? null,
        u?.cacheRead ?? null,
        u?.reasoning ?? null,
        u?.totalTokens ?? null,
        step.id,
      );
      const tokens = normalizeUsage(message, step.usageEvidence);
      this.#db.run(
        "UPDATE steps SET context_input = ?, context_cached = ?, context_output = ? WHERE id = ?",
        tokens.inputTotal,
        tokens.inputCached,
        tokens.outputTotal,
        step.id,
      );
      recordUsageForCompletedStep(this.#db, step.id, now, tokens);
      return true;
    });
    if (!recorded) return;
    this.#log.debug("step.finished", {
      stepId: step.id,
      status,
      errorCode: errorCode ?? null,
      latencyMs: now - step.startedAt,
    });
    // The response goes to a blob of its own (the trace shows it next to the request); a failure to store it loses only that.
    if (message) {
      const pending = this.#storeResponse(step.id, message)
        .catch(() => undefined)
        .finally(() => this.#pending.delete(pending));
      this.#pending.set(
        pending,
        this.#db.get<{ run_id: string | null }>("SELECT run_id FROM steps WHERE id=?", step.id)?.run_id ?? undefined,
      );
    }
  }

  /** Removes a blob written for a step that is gone, unless another step holds the same bytes (blobs are content-addressed). */
  async #dropUnused(ref: string): Promise<void> {
    const used =
      this.#db.get("SELECT 1 FROM steps WHERE payload_blob = ? OR response_blob = ? LIMIT 1", ref, ref) ??
      this.#db.get("SELECT 1 FROM step_images WHERE blob = ? LIMIT 1", ref);
    if (!used) await this.#traceBlobs.delete(ref);
  }

  async #storeResponse(stepId: string, message: AssistantMessage): Promise<void> {
    const bytes = utf8(JSON.stringify(message));
    const ref = await blobRefFor(bytes);
    // The chat may have been deleted while the blob was written: then nobody refers to it.
    if (!this.#db.get("SELECT 1 FROM steps WHERE id = ?", stepId)) return;
    this.#db.run("UPDATE steps SET response_blob = ? WHERE id = ?", ref, stepId);
    await this.#traceBlobs.put(bytes);
    if (!this.#db.get("SELECT 1 FROM steps WHERE id=?", stepId)) await this.#dropUnused(ref);
  }

  /** Links the newest finished model call of a run to the Pi entry it produced. */
  linkEntry(runId: string, entryId: string): void {
    this.#db.run(
      "UPDATE steps SET pi_entry_id = ? WHERE id = (SELECT id FROM steps WHERE run_id = ? AND type = 'llm.call' AND status = 'ok' ORDER BY started_at DESC, id DESC LIMIT 1)",
      entryId,
      runId,
    );
  }

  // ---- tool calls (trace step type `tool.call`; the policy extension records them) ---------------------------------------

  /** What each running tool step was called with, until it finishes (the payload blob is written once, with the output). */
  readonly #inputs = new Map<string, unknown>();

  /** The row of a tool call, made when the policy extension first sees the call (idempotent: a replayed hook finds it). Returns the step id. */
  beginTool(info: {
    sessionId: string;
    runId: string | undefined;
    toolCallId: string;
    toolName: string;
    actionClass: ActionClass | null;
    summary: string | null;
    activity?: string | undefined;
    input: unknown;
    /** The tool call id of the `codemode` call this call was made under (Pi's `call.parent.callId`), for a nested call. */
    parentToolCallId?: string | undefined;
  }): string {
    const found = this.#db.get<{ id: string }>(
      "SELECT id FROM steps WHERE session_id = ? AND tool_call_id = ? AND type = 'tool.call'",
      info.sessionId,
      info.toolCallId,
    );
    if (found) {
      this.#inputs.set(found.id, info.input);
      return found.id;
    }
    // A nested call whose script's step is missing still records, without a parent. One with a parent joins its run, so
    // a script and its calls are always paged together.
    const parent = info.parentToolCallId
      ? this.#db.get<{ id: string; run_id: string | null }>(
          "SELECT id, run_id FROM steps WHERE session_id = ? AND tool_call_id = ? AND type = 'tool.call'",
          info.sessionId,
          info.parentToolCallId,
        )
      : undefined;
    const now = this.#clock.now();
    const id = newId("stp", now);
    this.#db.run(
      "INSERT INTO steps (id, run_id, session_id, type, status, started_at, side_effect, tool_name, action_class, summary, tool_call_id, activity, parent_step_id) VALUES (?, ?, ?, 'tool.call', 'running', ?, 0, ?, ?, ?, ?, ?, ?)",
      id,
      parent?.run_id ?? info.runId ?? null,
      info.sessionId,
      now,
      info.toolName,
      info.actionClass,
      info.summary,
      info.toolCallId,
      info.activity ?? null,
      parent?.id ?? null,
    );
    this.#inputs.set(id, info.input);
    return id;
  }

  /** A capability change a running run saw: one finished step with what came, went or changed. */
  async recordCapabilityChange(info: { sessionId: string; runId: string; change: CapabilityChange }): Promise<void> {
    const { change } = info;
    const parts = [
      change.added.length ? `${change.added.length} added` : "",
      change.removed.length ? `${change.removed.length} removed` : "",
      change.changed.length ? `${change.changed.length} changed` : "",
    ].filter(Boolean);
    const summary = `${change.connectors.join(", ")}: tools ${parts.join(", ")}`;
    const payload = await this.#traceBlobs.put(utf8(JSON.stringify(change)));
    const now = this.#clock.now();
    this.#db.run(
      "INSERT INTO steps (id, run_id, session_id, type, status, started_at, latency_ms, side_effect, summary, payload_blob) VALUES (?, ?, ?, 'capabilities.changed', 'ok', ?, 0, 0, ?, ?)",
      newId("stp", now),
      info.runId,
      info.sessionId,
      now,
      summary,
      payload,
    );
  }

  /** What the policy decided. A call that was let through and whose class acts outside the box counts as a side effect. */
  decideTool(
    stepId: string,
    info: { decision: StepDecision; approvalId?: string; actionClass: ActionClass; summary: string | null },
  ): void {
    const ran = info.decision === "allow" || info.decision === "granted";
    const acts =
      info.actionClass === "write_external" || info.actionClass === "send" || info.actionClass === "irreversible";
    this.#db.run(
      "UPDATE steps SET decision = ?, approval_id = ?, action_class = ?, summary = ?, side_effect = ? WHERE id = ?",
      info.decision,
      info.approvalId ?? null,
      info.actionClass,
      info.summary,
      ran && acts ? 1 : 0,
      stepId,
    );
  }

  /** Ends a tool step with its output (images become blobs of their own). Safe to repeat. */
  async finishTool(
    stepId: string,
    result: {
      status: "ok" | "error" | "blocked" | "not_executed";
      isError: boolean;
      output: readonly { type: string; text?: unknown; data?: unknown; mimeType?: unknown }[];
      /** Why a not-executed call did not run (Pi's diagnostic code). */
      errorCode?: string;
      /** The tool's structured result details, kept for the Trace (a search's query, candidates and loads). */
      details?: unknown;
    },
  ): Promise<void> {
    const row = this.#db.get<{ started_at: number; latency_ms: number | null }>(
      "SELECT started_at, latency_ms FROM steps WHERE id = ?",
      stepId,
    );
    if (!row) return;
    const parts: ({ type: "text"; text: string } | { type: "image"; index: number; mimeType: string })[] = [];
    let index = 0;
    for (const p of result.output) {
      if (p.type === "text" && typeof p.text === "string") parts.push({ type: "text", text: p.text });
      else if (p.type === "image" && typeof p.data === "string" && typeof p.mimeType === "string") {
        const bytes = fromBase64(p.data);
        if (!bytes) continue;
        const blob = await this.#traceBlobs.put(bytes);
        if (!this.#db.get("SELECT 1 FROM steps WHERE id = ?", stepId)) return void (await this.#dropUnused(blob));
        this.#db.run(
          "INSERT OR REPLACE INTO step_images (step_id, idx, blob, mime) VALUES (?, ?, ?, ?)",
          stepId,
          index,
          blob,
          p.mimeType,
        );
        parts.push({ type: "image", index, mimeType: p.mimeType });
        index++;
      }
    }
    const payload = await this.#traceBlobs.put(
      utf8(
        JSON.stringify({
          input: this.#inputs.get(stepId) ?? null,
          output: parts,
          isError: result.isError,
          ...(result.details !== undefined ? { details: result.details } : {}),
        }),
      ),
    );
    this.#inputs.delete(stepId);
    if (!this.#db.get("SELECT 1 FROM steps WHERE id = ?", stepId)) return void (await this.#dropUnused(payload));
    this.#db.run(
      "UPDATE steps SET status = ?, latency_ms = ?, payload_blob = ?, error_code = COALESCE(?, error_code) WHERE id = ?",
      result.status,
      row.latency_ms ?? this.#clock.now() - row.started_at,
      payload,
      result.errorCode ?? null,
      stepId,
    );
  }

  /**
   * The tool result entry Pi wrote for a call: links the step to it, and ends a step the hook never finished (invalid
   * arguments, an interrupted call). A result with no step at all gets one.
   */
  async linkToolEntry(info: {
    sessionId: string;
    runId: string | undefined;
    toolCallId: string;
    toolName: string;
    entryId: string;
    isError: boolean;
    content: readonly { type: string; text?: unknown; data?: unknown; mimeType?: unknown }[];
  }): Promise<void> {
    let step = this.#db.get<{ id: string; status: string }>(
      "SELECT id, status FROM steps WHERE session_id = ? AND tool_call_id = ? AND type = 'tool.call'",
      info.sessionId,
      info.toolCallId,
    );
    if (!step) {
      step = {
        id: this.beginTool({
          sessionId: info.sessionId,
          runId: info.runId,
          toolCallId: info.toolCallId,
          toolName: info.toolName,
          actionClass: null,
          summary: null,
          input: null,
        }),
        status: "running",
      };
    }
    this.#db.run("UPDATE steps SET pi_entry_id = ? WHERE id = ?", info.entryId, step.id);
    if (step.status === "running")
      await this.finishTool(step.id, {
        status: info.isError ? "error" : "ok",
        isError: info.isError,
        output: info.content,
      });
  }

  /** Links the model call that issued tool calls to its entry (the final reply's call is linked by `linkEntry`). */
  linkModelEntry(runId: string, entryId: string): void {
    this.#db.run(
      "UPDATE steps SET pi_entry_id = ? WHERE id = (SELECT id FROM steps WHERE run_id = ? AND type = 'llm.call' AND status IN ('ok', 'running') AND pi_entry_id IS NULL ORDER BY started_at DESC, id DESC LIMIT 1)",
      entryId,
      runId,
    );
  }
}

function fromBase64(data: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}
