// Full mode's view of what happened: runs with their steps, one step in full, a tool's pictures, and what a fork
// would leave behind. Reads the app store and the blob store; changes nothing.
import type {
  CapabilityChange,
  CapabilitySearchDetails,
  ForkPreviewResponse,
  RunTrace,
  ScriptCall,
  SessionTraceResponse,
  StepDetailResponse,
  StepSummary,
  ToolOutputPart,
  WebDocumentResponse,
  WebFetchDetails,
} from "@rei/protocol";
import type { BlobStore } from "./blobs/blob-store.ts";
import { inputAnsweredBy } from "./conversation/runs.ts";
import { mapModelError } from "./pi/errors.ts";
import { providerDisplayName } from "./providers/names.ts";
import { approvalWaitTimes } from "./store/approvals.ts";
import { type AppStore, toRun } from "./store/store.ts";
import { offeredToolChanges } from "./trace-tools.ts";
import { fromUtf8 } from "./util/encoding.ts";
import { HttpError, notFound } from "./util/errors.ts";

export const TRACE_PAGE = 30;
/** Strings longer than this in a step's detail are cut (and `truncated` is set). */
export const DETAIL_STRING_MAX = 200_000;

interface StepRow {
  id: string;
  run_id: string | null;
  session_id: string | null;
  type: string;
  pi_entry_id: string | null;
  provider: string | null;
  model: string | null;
  status: string;
  error_code: string | null;
  started_at: number;
  first_byte_ms: number | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  total_tokens: number | null;
  payload_blob: string | null;
  response_blob: string | null;
  side_effect: number;
  tool_name: string | null;
  action_class: string | null;
  decision: string | null;
  approval_id: string | null;
  summary: string | null;
  activity: string | null;
  tool_call_id: string | null;
  parent_step_id: string | null;
  usage_purpose: string | null;
  offered_tools: string | null;
  prefix_items: number | null;
  input_items: number | null;
}

export function toStep(r: StepRow, sessionId: string, providerNames: Record<string, string> = {}): StepSummary {
  const base: StepSummary = {
    id: r.id,
    runId: r.run_id,
    sessionId: r.session_id ?? sessionId,
    type: r.type === "tool.call" || r.type === "capabilities.changed" ? r.type : "llm.call",
    // A cancelled model call is recorded as "aborted".
    status: (r.status === "aborted" ? "cancelled" : r.status) as StepSummary["status"],
    startedAt: r.started_at,
    latencyMs: r.latency_ms,
    piEntryId: r.pi_entry_id,
    sideEffect: r.side_effect === 1,
  };
  if (r.type === "capabilities.changed") return { ...base, ...(r.summary ? { summary: r.summary } : {}) };
  if (r.type === "tool.call") {
    return {
      ...base,
      ...(r.tool_name ? { toolName: r.tool_name } : {}),
      ...(r.action_class ? { actionClass: r.action_class as StepSummary["actionClass"] } : {}),
      ...(r.decision ? { decision: r.decision as StepSummary["decision"] } : {}),
      approvalId: r.approval_id,
      ...(r.summary ? { summary: r.summary } : {}),
      ...(r.activity ? { activity: r.activity } : {}),
      ...(r.tool_call_id ? { toolCallId: r.tool_call_id } : {}),
      ...(r.parent_step_id ? { parentStepId: r.parent_step_id } : {}),
      ...(r.error_code ? { errorCode: r.error_code } : {}),
    };
  }
  return {
    ...base,
    ...(r.provider ? { provider: r.provider, providerName: providerDisplayName(providerNames, r.provider) } : {}),
    ...(r.model ? { model: r.model } : {}),
    firstByteMs: r.first_byte_ms,
    tokens: {
      input: r.input_tokens,
      output: r.output_tokens,
      cached: r.cached_tokens,
      reasoning: r.reasoning_tokens,
      total: r.total_tokens,
    },
    ...(r.input_items !== null && r.input_items !== undefined
      ? { prefix: { matched: r.prefix_items ?? null, items: r.input_items } }
      : {}),
    errorCode: r.error_code,
  };
}

/**
 * The Knowledge page a knowledge_* step touched, for the chat's page chip: a write remembers it (knowledge_calls), a
 * read or browse names it in its summary. The title is the page's current one.
 */
function withPage(db: AppStore["db"], r: StepRow, step: StepSummary): StepSummary {
  if (r.tool_name === "web_fetch") return withWebPage(db, r, step);
  if (!r.tool_name?.startsWith("knowledge_")) return step;
  const remembered =
    r.tool_call_id && r.session_id
      ? db.get<{ page_id: string | null }>(
          "SELECT page_id FROM knowledge_calls WHERE key = ?",
          `${r.session_id}:${r.tool_call_id}`,
        )?.page_id
      : null;
  const id = remembered ?? /Knowledge (?:page|under) ([A-Za-z0-9_-]+)$/.exec(r.summary ?? "")?.[1];
  if (!id) return step;
  const page = db.get<{ title: string; trashed_at: number | null }>(
    "SELECT title, trashed_at FROM knowledge_pages WHERE id = ?",
    id,
  );
  return page ? { ...step, page: { id, title: page.title, trashed: page.trashed_at !== null } } : step;
}

/** The page a web_fetch step read, for the chat's chip: its title and host (kept after the stored copy expires). */
function withWebPage(db: AppStore["db"], r: StepRow, step: StepSummary): StepSummary {
  if (!r.tool_call_id || !r.session_id) return step;
  const call = db.get<{ title: string; url: string }>(
    "SELECT title, url FROM web_calls WHERE key = ?",
    `${r.session_id}:${r.tool_call_id}`,
  );
  if (!call) return step;
  let host: string;
  try {
    host = new URL(call.url).hostname;
  } catch {
    return step;
  }
  return { ...step, web: { title: call.title, host } };
}

/** The newest 30 runs of a session before `before` (a run id), with their steps. */
export function sessionTrace(
  store: AppStore,
  sessionId: string,
  before?: string,
  providerNames: Record<string, string> = {},
): SessionTraceResponse {
  const session = store.getSession(sessionId);
  if (!session) throw notFound("That session does not exist.");
  const db = store.db;
  // The runs of the session, newest first (the registry holds every run of an open tree's sessions).
  const everyRun = store.runs.forSession(sessionId);
  let rows = [...everyRun].reverse();
  if (before !== undefined && before !== "") {
    const at = rows.findIndex((r) => r.id === before);
    if (at < 0) throw new HttpError(400, "bad_request", "before is not a run of this session.");
    rows = rows.slice(at + 1);
  }
  rows = rows.slice(0, TRACE_PAGE + 1);
  const more = rows.length > TRACE_PAGE;
  const page = rows.slice(0, TRACE_PAGE);
  const waitTimes = approvalWaitTimes(
    db,
    page.filter((r) => r.ended_at !== null).map((r) => r.id),
  );
  const steps =
    page.length === 0
      ? []
      : db.all<StepRow>(
          "SELECT * FROM steps WHERE run_id IN (SELECT value FROM json_each(?)) ORDER BY started_at, id",
          JSON.stringify(page.map((r) => r.id)),
        );
  const byRun = new Map<string, StepSummary[]>();
  for (const s of steps) {
    const list = byRun.get(s.run_id!) ?? [];
    list.push(withPage(db, s, toStep(s, sessionId, providerNames)));
    byRun.set(s.run_id!, list);
  }
  // A failed run the user went on from (Continue): the next run of the session is a continue. It has its own trace.
  const continuedRuns = new Set(
    everyRun.flatMap((r, i) => (r.kind === "continue" && i > 0 ? [everyRun[i - 1]!.id] : [])),
  );
  const runs: RunTrace[] = page.map((r) => {
    const list = byRun.get(r.id) ?? [];
    const llm = list.filter((s) => s.type === "llm.call");
    const durationMs = r.ended_at === null ? null : r.ended_at - r.started_at;
    const approvalWaitMs = Math.min(Math.max(0, durationMs ?? 0), waitTimes.get(r.id) ?? 0);
    return {
      run: toRun(r),
      // A continue has no input of its own: it belongs under the message whose reply it went on with.
      triggerMessageId: (r.kind === "input" ? r : inputAnsweredBy(everyRun, r))?.user_message_id ?? null,
      ...(r.status === "failed" && continuedRuns.has(r.id) ? { continued: true as const } : {}),
      steps: list,
      totals: {
        modelCalls: llm.length,
        toolCalls: list.filter((s) => s.type === "tool.call").length,
        tokens: llm.reduce((n, s) => n + (s.tokens?.total ?? 0), 0),
        durationMs,
        ...(approvalWaitMs > 0 ? { approvalWaitMs } : {}),
      },
    };
  });
  return { session, runs, next: more ? page[page.length - 1]!.id : null };
}

/** Cuts every string over the limit; returns the value and whether anything was cut. */
function cutStrings(value: unknown, state: { truncated: boolean }): unknown {
  if (typeof value === "string") {
    if (value.length <= DETAIL_STRING_MAX) return value;
    state.truncated = true;
    return `${value.slice(0, DETAIL_STRING_MAX)}…`;
  }
  if (Array.isArray(value)) return value.map((v) => cutStrings(v, state));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cutStrings(v, state)]));
  return value;
}

/** Bytes as JSON when they are JSON, else as the text they are (a server-sent-events stream, say). */
function parseStored(bytes: Uint8Array): unknown {
  const text = fromUtf8(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function stepDetail(
  store: AppStore,
  blobs: BlobStore,
  stepId: string,
  providerNames: Record<string, string> = {},
): Promise<StepDetailResponse> {
  const row = store.db.get<StepRow>("SELECT * FROM steps WHERE id = ?", stepId);
  const sessionId = row?.session_id ?? (row?.run_id ? store.getRun(row.run_id)?.session_id : undefined);
  if (!row || !sessionId || !store.getSession(sessionId)) throw notFound("That step does not exist.");
  const state = { truncated: false };
  let payloadBytes = 0;
  const read = async (ref: string | null): Promise<unknown> => {
    if (!ref) return undefined;
    const bytes = await blobs.get(ref);
    if (!bytes) return undefined;
    payloadBytes += bytes.length;
    return parseStored(bytes);
  };
  // Other steps' payloads, read to compare offered tools; they do not count toward this step's payload size.
  const readQuiet = async (ref: string | null): Promise<unknown> => {
    const bytes = ref ? await blobs.get(ref) : undefined;
    return bytes ? parseStored(bytes) : undefined;
  };
  const out: StepDetailResponse = {
    step: withPage(store.db, row, toStep(row, sessionId, providerNames)),
    payloadBytes: 0,
    truncated: false,
  };
  if (row.type === "capabilities.changed") {
    out.change = (await read(row.payload_blob)) as CapabilityChange;
  } else if (row.type === "tool.call") {
    const payload = (await read(row.payload_blob)) as
      | { input?: unknown; output?: ToolOutputPart[]; isError?: boolean; details?: unknown }
      | undefined;
    out.tool = {
      input: cutStrings(payload?.input ?? null, state),
      output: (cutStrings(payload?.output ?? [], state) as ToolOutputPart[]) ?? [],
      isError: payload?.isError === true,
      ...(row.tool_name === "search_capabilities" && payload?.details && typeof payload.details === "object"
        ? { discovery: cutStrings(payload.details, state) as CapabilitySearchDetails }
        : {}),
      ...(row.tool_name === "web_fetch" && payload?.details && typeof payload.details === "object"
        ? { fetch: cutStrings(payload.details, state) as WebFetchDetails }
        : {}),
      ...(row.tool_name === "codemode" && Array.isArray((payload?.details as { calls?: unknown } | undefined)?.calls)
        ? { script: { calls: cutStrings((payload!.details as { calls: unknown[] }).calls, state) as ScriptCall[] } }
        : {}),
    };
  } else {
    const request = await read(row.payload_blob);
    const response = await read(row.response_blob);
    const tools = await offeredToolChanges(store, readQuiet, row, request);
    const errorText = (response as { errorMessage?: unknown } | null)?.errorMessage;
    out.llm = {
      request: cutStrings(request ?? null, state),
      response: cutStrings(response ?? null, state),
      ...(row.status === "error" && typeof errorText === "string" ? { error: mapModelError(errorText) } : {}),
      ...(tools ? { tools } : {}),
    };
  }
  out.payloadBytes = payloadBytes;
  out.truncated = state.truncated;
  return out;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** A picture from a tool's output. Only raster image types are served (never SVG). */
export async function stepImage(
  store: AppStore,
  blobs: BlobStore,
  stepId: string,
  index: number,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
  const row = store.db.get<{ blob: string; mime: string; session_id: string | null; run_id: string | null }>(
    "SELECT i.blob, i.mime, s.session_id, s.run_id FROM step_images i JOIN steps s ON s.id = i.step_id WHERE i.step_id = ? AND i.idx = ?",
    stepId,
    index,
  );
  const sessionId = row?.session_id ?? (row?.run_id ? store.getRun(row.run_id)?.session_id : undefined);
  if (!row || !sessionId || !store.getSession(sessionId)) throw notFound("That picture does not exist.");
  const bytes = await blobs.get(row.blob);
  if (!bytes) throw notFound("That picture does not exist.");
  return { bytes, mime: IMAGE_TYPES.has(row.mime) ? row.mime : "application/octet-stream" };
}

/**
 * The readable copy a web_fetch step read, for people to look at; it never goes back to the model. Only while the agent
 * of the step's session still stores it (the copy may since have been fetched again: `fetchedAt` says when).
 */
export function stepWebDocument(store: AppStore, stepId: string): WebDocumentResponse {
  const gone = "That page is no longer stored.";
  const row = store.db.get<{ session_id: string | null; tool_name: string | null; tool_call_id: string | null }>(
    "SELECT session_id, tool_name, tool_call_id FROM steps WHERE id = ?",
    stepId,
  );
  if (row?.tool_name !== "web_fetch" || !row.session_id || !row.tool_call_id) throw notFound(gone);
  const session = store.getSessionRow(row.session_id);
  if (!session) throw notFound(gone);
  const doc = store.db.get<{
    title: string;
    final_url: string;
    text: string;
    note: string | null;
    quality: string;
    extractor: string;
    fetched_at: number;
    expires_at: number;
  }>(
    `SELECT d.title, d.final_url, d.text, d.note, d.quality, d.extractor, d.fetched_at, d.expires_at
       FROM web_calls c JOIN web_documents d ON d.id = c.document_id
      WHERE c.key = ? AND d.agent_id = ?`,
    `${row.session_id}:${row.tool_call_id}`,
    session.agent_id,
  );
  if (!doc) throw notFound(gone);
  return {
    title: doc.title,
    url: doc.final_url,
    text: doc.text,
    ...(doc.note !== null ? { note: doc.note } : {}),
    quality: doc.quality,
    extractor: doc.extractor,
    fetchedAt: doc.fetched_at,
    expiresAt: doc.expires_at,
  };
}

/** The tool steps a fork at this point would not undo: they ran after the cut and acted outside the box. */
export function forkPreview(
  store: AppStore,
  sessionId: string,
  cut: { entry: string | null; after: number; edited: boolean },
  providerNames: Record<string, string> = {},
): ForkPreviewResponse {
  if (!store.getSessionRow(sessionId)) throw notFound("That session does not exist.");
  const edit = cut.edited === true;
  const rows = store.db.all<StepRow>(
    "SELECT * FROM steps WHERE session_id = ? AND type = 'tool.call' AND side_effect = 1 ORDER BY started_at, id",
    sessionId,
  );
  const later = rows.filter((r) => {
    if (cut.entry !== null && r.pi_entry_id !== null) return Number(r.pi_entry_id) > Number(cut.entry);
    return edit ? r.started_at >= cut.after : r.started_at > cut.after;
  });
  return { laterEffects: later.map((r) => toStep(r, sessionId, providerNames)) };
}
