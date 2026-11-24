// Drives one conversation through the HTTP API and measures it. It works on a `Client` over a real URL (a deployed stack
// with a real model) or over the in-process test server (the faux model); it needs nothing but the public API.
import {
  type Approval,
  CSRF_HEADER,
  type KnowledgePageDetail,
  type LibraryFile,
  type Message,
  type Run,
  type RunTrace,
  SESSION_COOKIE,
  type StepDetailResponse,
} from "@rei/protocol";
import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";
import { contextBreakdown } from "../../src/usage/context-breakdown.ts";
import { Client } from "../../test/helpers/client.ts";
import {
  knowledgePages,
  libraryFiles,
  MARK,
  MEMORY_LINES,
  type Outcome,
  ROOT_PAGE,
  type Scenario,
  type SeedIds,
} from "./scenarios.ts";

export type Arm = "off" | "on";

let tokenizer: Tiktoken | undefined;
const countTokens = (text: string): number => {
  tokenizer ??= new Tiktoken(o200k);
  return tokenizer.encode(text, [], []).length;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ok<T>(what: string, reply: Promise<{ status: number; body: unknown }>): Promise<T> {
  const r = await reply;
  if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body as T;
}

/** A client for a deployed stack: signs in with the password, never printing it. */
export async function liveClient(url: string, password: string): Promise<Client> {
  const base = url.replace(/\/$/, "");
  const client = new Client((path, init) =>
    fetch(base + path, { ...init, headers: { origin: base, ...init?.headers } }),
  );
  await ok("login", client.post("/api/auth/login", { password }));
  return client;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures

async function upload(client: Client, name: string, text: string): Promise<LibraryFile> {
  const form = new FormData();
  form.set("file", new File([text], name, { type: "text/plain" }));
  const headers: Record<string, string> = { [CSRF_HEADER]: "1" };
  if (client.cookie) headers.cookie = `${SESSION_COOKIE}=${client.cookie}`;
  const res = await client.fetcher("/api/files", { method: "POST", headers, body: form });
  if (res.status >= 300) throw new Error(`upload ${name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { file: LibraryFile }).file;
}

/** Puts the scenarios' library files, Knowledge pages and memory note on the server. */
export async function seed(client: Client): Promise<SeedIds> {
  const ids: SeedIds = { files: new Map(), pages: new Map(), created: { files: [], pages: [], memory: [] } };
  for (const f of libraryFiles()) {
    const file = await upload(client, f.name, f.text);
    ids.files.set(f.name, {
      id: file.id,
      versionId: file.current.versionId,
    });
    ids.created.files.push(file.id);
  }
  for (const p of knowledgePages()) {
    const page = await ok<KnowledgePageDetail>(
      `page ${p.title}`,
      client.post("/api/knowledge/pages", {
        title: p.title,
        description: p.description,
        body: p.body,
        parentId: p.parent === null ? null : ids.pages.get(p.parent)!,
        ...(p.tags.length ? { metadata: { tags: p.tags } } : {}),
      }),
    );
    const id = page.page.id;
    ids.pages.set(p.title, id);
    ids.created.pages.push(id);
  }
  for (const text of MEMORY_LINES) {
    const r = await ok<{ line: { id: string } }>(
      "memory line",
      client.post("/api/memory/lines", { doc: "profile", text }),
    );
    ids.created.memory.push(r.line.id);
  }
  return ids;
}

const HARD = { body: { confirm: true } };

/** Removes one library file for good: Trash first, then the permanent delete. */
async function dropFile(client: Client, id: string): Promise<void> {
  await client.call("PATCH", `/api/files/${id}`, { body: { trashed: true } });
  await client.call("DELETE", `/api/files/${id}`, HARD);
}

/** Removes one Knowledge page for good: Trash first, then the permanent delete. */
async function dropPage(client: Client, id: string): Promise<void> {
  await client.call("POST", `/api/knowledge/pages/${id}/trash`);
  await client.call("DELETE", `/api/knowledge/pages/${id}`, HARD);
}

/** Removes what `seed` made, by the ids it recorded. */
export async function cleanup(client: Client, ids: SeedIds): Promise<void> {
  for (const id of ids.created.files) await dropFile(client, id);
  for (const id of [...ids.created.pages].reverse()) await dropPage(client, id);
  for (const id of ids.created.memory) await client.call("DELETE", `/api/memory/lines/${id}`);
}

/**
 * Removes fixtures a killed run left behind, and only those: library files whose name starts with the fixture marker,
 * and the fixture root page with everything under it (live or in Trash). Nothing else on the server is touched.
 * `dryRun` only lists them.
 */
export async function purge(client: Client, dryRun = false): Promise<{ files: string[]; pages: string[] }> {
  const files: string[] = [];
  const fileList = await ok<{ files: { id: string; name: string }[] }>("files", client.get("/api/files"));
  for (const f of fileList.files) if (f.name.startsWith(`${MARK}-`)) files.push(f.id);

  const live = await ok<{ pages: { id: string; parentId: string | null; title: string }[] }>(
    "tree",
    client.get("/api/knowledge/tree"),
  );
  const trashed = await ok<{ pages: { id: string; parentId: string | null; title: string }[] }>(
    "trash",
    client.get("/api/knowledge/trash"),
  );
  const all = [...live.pages, ...trashed.pages];
  const under = new Set(all.filter((p) => p.parentId === null && p.title === ROOT_PAGE).map((p) => p.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) {
      if (!p.parentId || !under.has(p.parentId) || under.has(p.id)) continue;
      under.add(p.id);
      grew = true;
    }
  }
  const pages = [...under];
  if (!dryRun) {
    for (const id of files) await dropFile(client, id);
    for (const id of pages.reverse()) await dropPage(client, id);
  }
  return { files, pages };
}

export async function setCodeMode(client: Client, on: boolean): Promise<void> {
  await ok("behavior", client.call("PUT", "/api/settings/behavior", { body: { codeMode: { enabled: on } } }));
}

// ---------------------------------------------------------------------------------------------------------------------
// One run

export interface RunMetrics {
  scenario: string;
  arm: Arm;
  /** Model name from the first model call. */
  model: string;
  success: boolean;
  failures: string[];
  answer: string;
  /** Model calls over the whole conversation, continuations after approvals included. */
  turns: number;
  /**
   * Prompt tokens summed over the calls: what the provider read, cached or not. The provider reports uncached input
   * and cached input separately (a second call over the same prefix shows a small input and a large cached count).
   */
  inputTokens: number;
  /** The uncached part of `inputTokens`: what the calls paid full price for. */
  uncachedTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Each model call's reported tokens. */
  calls: { input: number | null; cached: number | null; output: number | null }[];
  /** Cached share of the prompt tokens over the calls; null when no call reported tokens. */
  cacheShare: number | null;
  /** o200k estimates from the first call's request: everything the model is given before any work (prompt included). */
  firstCall: { total: number; toolDefinitions: number; prompt: number; codemodeSection: number };
  /** The last call's prompt tokens as the provider reported them (cached included): how large the context grew. */
  lastCallTokens: number;
  /** Wall time from sending the message to the end of the run, in ms. */
  wallMs: number;
  approvals: { asked: number; decided: number };
  /** The approval cards, so a run can be graded again offline. */
  approvalCards: Outcome["approvals"];
  /** Calls of the `codemode` tool. */
  scripts: number;
  /** Tool calls made by scripts. */
  nestedCalls: number;
  /** Tool calls made directly by the model, `codemode` excluded. */
  directCalls: number;
  scriptFailures: Record<string, number>;
  /** The first line of each failed script's output, for the write-up. */
  scriptErrors: string[];
  hitLimit: boolean;
}

export const failureKind = (text: string): string => {
  if (/timed out|deadline/i.test(text)) return "timeout";
  if (/out of memory|memory limit/i.test(text)) return "memory";
  if (/too many scripts/i.test(text)) return "concurrency";
  if (/SyntaxError/.test(text)) return "syntax";
  if (/ReferenceError|TypeError|RangeError|is not defined|is not a function|Cannot read/.test(text)) return "runtime";
  if (/approval|denied|blocked|not allowed|does not exist/i.test(text)) return "tool_refused";
  return "other";
};

interface Step {
  id: string;
  type: string;
  status: string;
  toolName?: string;
  toolCallId?: string;
  parentStepId?: string | null;
  tokens?: { input: number | null; output: number | null; cached: number | null };
  model?: string;
}

async function stepsOf(
  client: Client,
  sessionId: string,
): Promise<{ steps: Step[]; approvalWaitMs: number; wallMs: number }> {
  const steps: Step[] = [];
  let approvalWaitMs = 0;
  let wallMs = 0;
  let cursor: string | null = null;
  do {
    const page: { runs: RunTrace[]; next: string | null } = await ok(
      "trace",
      client.get(`/api/sessions/${sessionId}/trace${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`),
    );
    for (const run of page.runs) {
      steps.push(...run.steps);
      approvalWaitMs += run.totals.approvalWaitMs ?? 0;
      wallMs += run.totals.durationMs ?? 0;
    }
    cursor = page.next;
  } while (cursor);
  return { steps, approvalWaitMs, wallMs };
}

const outputText = (detail: StepDetailResponse): string =>
  (detail.tool?.output ?? []).map((o) => ("text" in o ? o.text : "")).join("\n");

/**
 * o200k estimates of one model call's request. A real provider's request is split by the context breakdown. The faux
 * model's request holds the prompt sections but no tool definitions: then the prompt is the sections' text and the
 * tool definitions count as 0 (the `codemode` section is measured in both).
 */
async function breakdownOf(client: Client, stepId: string): Promise<Breakdown> {
  const detail = await ok<StepDetailResponse>("step", client.get(`/api/steps/${stepId}`));
  const request = detail.llm?.request;
  const b = contextBreakdown(request, new Set(detail.llm?.tools?.added?.map((t: { name: string }) => t.name) ?? []));
  if (b) {
    const of = (id: string) => b.categories.find((c) => c.id === id)?.estimatedTokens ?? 0;
    return {
      total: b.estimatedTokens,
      toolDefinitions: of("tools") + of("loaded_tools"),
      prompt: of("prompt") + of("capabilities") + of("skills"),
      codemodeSection: 0,
    };
  }
  const sections = ((request as { messages?: { sections?: Record<string, string> }[] } | undefined)?.messages?.[0]
    ?.sections ?? {}) as Record<string, string>;
  const prompt = Object.values(sections).reduce((n, t) => n + countTokens(String(t)), 0);
  return {
    total: prompt,
    toolDefinitions: 0,
    prompt,
    codemodeSection: sections.codemode ? countTokens(sections.codemode) : 0,
  };
}

interface Breakdown {
  total: number;
  toolDefinitions: number;
  prompt: number;
  codemodeSection: number;
}

export interface RunOptions {
  /** The text to send: the scenario's prompt, or (faux) its directives. */
  text: string;
  /** Gives up on a run that has not finished after this long. */
  timeoutMs: number;
  /** The faux model cannot write an answer: take the last tool result as the answer. */
  answerFromTools?: boolean;
}

/** Sends `text` in a new chat, approves every card the way a user who agrees would, and measures. */
export async function runOnce(client: Client, scenario: Scenario, arm: Arm, options: RunOptions): Promise<RunMetrics> {
  const started = Date.now();
  const sessionId = (await ok<{ session: { id: string } }>("new chat", client.post("/api/sessions", {}))).session.id;
  await ok(
    "send",
    client.post(`/api/sessions/${sessionId}/messages`, { requestId: crypto.randomUUID(), text: options.text }),
  );
  let decided = 0;
  const seen = new Set<string>();
  let detail: { messages: Message[]; runs: Run[] };
  for (;;) {
    if (Date.now() - started > options.timeoutMs)
      throw new Error(`${scenario.id}/${arm}: no result in ${options.timeoutMs} ms`);
    const pending = (await ok<{ approvals: Approval[] }>("approvals", client.get("/api/approvals"))).approvals as {
      id: string;
      sessionId: string;
    }[];
    for (const a of pending.filter((p) => p.sessionId === sessionId)) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      await ok("approve", client.post(`/api/approvals/${a.id}/decide`, { decision: "approve", length: "once" }));
      decided++;
    }
    detail = await ok<{ messages: Message[]; runs: Run[] }>("session", client.get(`/api/sessions/${sessionId}`));
    const busy = detail.runs.some((r: { status: string }) => r.status === "queued" || r.status === "running");
    if (detail.runs.length > 0 && !busy && pending.every((p) => p.sessionId !== sessionId)) break;
    await sleep(150);
  }
  const wallMs = Date.now() - started;

  const messages = detail.messages;
  let answer = messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
  const approvals = messages.flatMap((m) =>
    m.approval
      ? [
          {
            tool: m.approval.tool,
            status: m.approval.status,
            summary: m.approval.summary,
            execution: m.approval.execution,
          },
        ]
      : [],
  );
  const { steps } = await stepsOf(client, sessionId);
  const tools = steps.filter((s) => s.type === "tool.call");
  if (options.answerFromTools && tools.length > 0) {
    // What the model got back last: the script's output with Code mode, else the last tool's.
    const last =
      tools.filter((t) => t.toolName === "codemode").at(-1) ?? tools.filter((t) => !t.toolCallId?.includes("/")).at(-1);
    if (last) answer = outputText(await ok<StepDetailResponse>("step", client.get(`/api/steps/${last.id}`)));
  }
  const outcome: Outcome = { answer, approvals };
  const failures = scenario.check(outcome);
  const runFailed = detail.runs.some((r: { status: string }) => r.status === "failed");
  if (runFailed) failures.push(`run failed: ${detail.runs.find((r) => r.status === "failed")?.error?.message ?? ""}`);

  const llm = steps.filter((s) => s.type === "llm.call");
  const scriptSteps = tools.filter((s) => s.toolName === "codemode");
  // Pi names a nested call `<script call id>/<key>`.
  const isNested = (s: Step) => Boolean(s.parentStepId) || Boolean(s.toolCallId?.includes("/"));
  const nested = tools.filter((s) => s.toolName !== "codemode" && isNested(s));
  const direct = tools.filter((s) => s.toolName !== "codemode" && !isNested(s));
  const sum = (pick: (s: Step) => number | null | undefined) => llm.reduce((n, s) => n + (pick(s) ?? 0), 0);
  const uncachedTokens = sum((s) => s.tokens?.input);
  const cachedTokens = sum((s) => s.tokens?.cached);
  const inputTokens = uncachedTokens + cachedTokens;
  const lastReported = llm.at(-1)?.tokens;
  const scriptFailures: Record<string, number> = {};
  const scriptErrors: string[] = [];
  for (const s of scriptSteps) {
    const text = outputText(await ok<StepDetailResponse>("step", client.get(`/api/steps/${s.id}`)));
    if (s.status === "ok" && !/^\s*(Error|Uncaught)\b/.test(text)) continue;
    const kind = failureKind(text);
    scriptFailures[kind] = (scriptFailures[kind] ?? 0) + 1;
    scriptErrors.push(
      text
        .split("\n")
        .find((l) => l.trim() !== "")
        ?.slice(0, 200) ?? "(empty)",
    );
  }
  const empty: Breakdown = { total: 0, toolDefinitions: 0, prompt: 0, codemodeSection: 0 };
  const firstCall = llm[0] ? await breakdownOf(client, llm[0].id) : empty;
  const lastCall = llm.at(-1) ? await breakdownOf(client, llm.at(-1)!.id) : empty;
  return {
    scenario: scenario.id,
    arm,
    model: llm[0]?.model ?? "",
    success: failures.length === 0,
    failures,
    answer,
    turns: llm.length,
    inputTokens,
    uncachedTokens,
    outputTokens: sum((s) => s.tokens?.output),
    cachedTokens,
    calls: llm.map((c) => ({
      input: c.tokens?.input ?? null,
      cached: c.tokens?.cached ?? null,
      output: c.tokens?.output ?? null,
    })),
    cacheShare: inputTokens > 0 ? Number((cachedTokens / inputTokens).toFixed(3)) : null,
    firstCall,
    lastCallTokens: lastReported ? (lastReported.input ?? 0) + (lastReported.cached ?? 0) : lastCall.total,
    wallMs,
    approvals: { asked: approvals.length, decided },
    approvalCards: approvals,
    scripts: scriptSteps.length,
    nestedCalls: nested.length,
    directCalls: direct.length,
    scriptFailures,
    scriptErrors,
    hitLimit: messages.some((m) => /model calls|limit/i.test(m.text) && m.role === "notice"),
  };
}
