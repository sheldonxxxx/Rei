import type { StepDecision, StepSummary, StepTokens } from "@rei/protocol";
import { CLASS_LABEL } from "./policy.ts";

/** "0.8 s", "2.3 s", "1 min 4 s"; a step still running has none yet. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "…";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

const n = (v: number | null | undefined) => (v === null || v === undefined ? "?" : v.toLocaleString());

/** "1,234 → 321 tokens" */
export function tokenLine(t: StepTokens | undefined): string {
  if (!t || (t.input === null && t.output === null)) return t?.total != null ? `${n(t.total)} tokens` : "";
  return `${n(t.input)} → ${n(t.output)} tokens`;
}

export const DECISION_LABEL: Record<StepDecision, string> = {
  allow: "allowed",
  granted: "granted",
  ask: "asked you",
  deny: "denied",
};

/** The one-line description of a step, as in the chat's step rows: "Model · gpt-6.1-sol · 1,234 → 321 tokens · 2.3 s". */
export function stepLine(s: StepSummary): string {
  const time = s.status === "running" ? "running…" : duration(s.latencyMs);
  if (s.type === "llm.call") {
    return ["Model", s.model, tokenLine(s.tokens), time, s.status === "error" ? "failed" : ""]
      .filter(Boolean)
      .join(" · ");
  }
  if (s.type === "capabilities.changed") return s.summary ?? "Connector tools changed";
  const decision = s.decision
    ? s.status === "blocked" && s.decision === "ask"
      ? "waiting for you"
      : DECISION_LABEL[s.decision]
    : "";
  return [
    s.toolName ?? "tool",
    s.actionClass ? s.actionClass : "",
    decision,
    time,
    s.status === "error" ? "failed" : "",
    s.status === "not_executed" ? "not run" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Tone of a step row: approvals and denials use the approval colours. */
export function stepTone(s: StepSummary): "normal" | "ask" | "deny" | "error" {
  if (s.decision === "deny") return "deny";
  if (s.status === "blocked" || s.decision === "ask") return "ask";
  if (s.status === "error" || s.status === "not_executed") return "error";
  return "normal";
}

export const actionClassLabel = (c: StepSummary["actionClass"]) => (c ? CLASS_LABEL[c] : "");

// ---- reading a recorded provider request or response, whatever shape the provider used -------------------------------------

export interface ContextMessage {
  role: string;
  text: string;
  /** Tool calls the message made, as "name(args)". */
  calls: string[];
  /** The message held something that isn't text (an image, a file). */
  other: number;
  /** A system message sent after the conversation began: Pi's change to a prompt section, shown where it was sent. */
  update?: boolean;
  /** Thinking the message carried (pi's thinking parts), kept apart from its text. */
  reasoning?: string;
}

export interface SectionChange {
  name: string;
  change: "updated" | "removed";
  body: string;
}

const CHANGE = /^(Updated|Removed) system prompt section "([^"]+)"(?::\n\n|\.)/;

/**
 * Pi frames a later system message as `Updated system prompt section "x":\n\n<text>` or `Removed system prompt section "x".`
 * (several can share one message). Text that doesn't start that way comes back as one unnamed change.
 */
export function sectionChanges(text: string): SectionChange[] {
  const out: SectionChange[] = [];
  let rest = text.trim();
  while (rest) {
    const m = CHANGE.exec(rest);
    if (!m) {
      out.push({ name: "", change: "updated", body: rest });
      break;
    }
    const after = rest.slice(m[0].length);
    // The body runs to the next framing line, or to the end.
    const next = /\n\n(?:Updated|Removed) system prompt section "[^"]+"(?::\n\n|\.)/.exec(after);
    const body = m[1] === "Removed" ? "" : (next ? after.slice(0, next.index) : after).trim();
    out.push({ name: m[2]!, change: m[1] === "Removed" ? "removed" : "updated", body });
    rest = (m[1] === "Removed" ? after : next ? after.slice(next.index) : "").trim();
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Text out of a content value: a string, or parts like `{type:"text",text}`. Thinking parts are kept apart as reasoning. */
function contentText(c: unknown): { text: string; other: number; calls: string[]; reasoning: string } {
  if (typeof c === "string") return { text: c, other: 0, calls: [], reasoning: "" };
  if (!Array.isArray(c)) return { text: "", other: 0, calls: [], reasoning: "" };
  const text: string[] = [];
  const calls: string[] = [];
  const reasoning: string[] = [];
  let other = 0;
  for (const p of c) {
    if (!isObj(p)) continue;
    if (p.type === "thinking" && typeof p.thinking === "string") reasoning.push(p.thinking);
    else if (typeof p.text === "string") text.push(p.text);
    else if (typeof p.content === "string") text.push(p.content);
    else if (
      (p.type === "tool_use" || p.type === "toolCall" || p.type === "function_call") &&
      typeof p.name === "string"
    )
      calls.push(`${p.name}(${JSON.stringify(p.input ?? p.arguments ?? {})})`);
    else if (p.type === "tool_result" && Array.isArray(p.content)) text.push(contentText(p.content).text);
    else other++;
  }
  return { text: text.join("\n"), other, calls, reasoning: reasoning.join("\n") };
}

/** A Responses reasoning item: its readable text is in `summary`, or in `content` on some gateways. */
function reasoningItem(m: Record<string, unknown>): ContextMessage {
  const summary = Array.isArray(m.summary)
    ? m.summary.map((s) => (isObj(s) && typeof s.text === "string" ? s.text : "")).filter(Boolean)
    : [];
  const readable = [...summary, contentText(m.content).text].filter(Boolean).join("\n");
  // Encrypted reasoning cannot be read here; say so instead of showing an empty row.
  const text = readable || (m.encrypted_content ? "Encrypted reasoning (not readable here)." : "");
  return { role: "reasoning", text, calls: [], other: 0 };
}

function oneMessage(m: unknown): ContextMessage | null {
  if (!isObj(m)) return null;
  if (m.type === "reasoning") return reasoningItem(m);
  const role = typeof m.role === "string" ? m.role : typeof m.type === "string" ? m.type : "message";
  const c = contentText(m.content ?? m.output ?? m.text);
  const calls = [...c.calls];
  if (Array.isArray(m.tool_calls)) {
    for (const t of m.tool_calls) {
      const f = isObj(t) && isObj(t.function) ? t.function : null;
      if (f && typeof f.name === "string")
        calls.push(`${f.name}(${typeof f.arguments === "string" ? f.arguments : JSON.stringify(f.arguments ?? {})})`);
    }
  }
  if (m.type === "function_call" && typeof m.name === "string")
    calls.push(`${m.name}(${typeof m.arguments === "string" ? m.arguments : JSON.stringify(m.arguments ?? {})})`);
  if (m.type === "function_call_output" && typeof m.output === "string")
    return { role: "tool", text: m.output, calls, other: c.other };
  return {
    role: m.role === "tool" ? "tool" : role,
    text: c.text,
    calls,
    other: c.other,
    ...(c.reasoning ? { reasoning: c.reasoning } : {}),
  };
}

export interface RequestView {
  /** The system prompt, when the request carries one. */
  system: string | null;
  messages: ContextMessage[];
  tools: { name: string; description: string; schema: unknown }[];
  /** Nothing recognisable: the Raw tab has the whole thing. */
  recognised: boolean;
}

/** The request as sent, read for people: system prompt, messages in order, tool definitions. Understands chat-completions, responses and messages-style bodies. */
export function describeRequest(req: unknown): RequestView {
  if (!isObj(req)) return { system: null, messages: [], tools: [], recognised: false };
  let system: string | null = null;
  if (typeof req.system === "string") system = req.system;
  else if (Array.isArray(req.system)) system = contentText(req.system).text;
  else if (typeof req.instructions === "string") system = req.instructions;
  const list = Array.isArray(req.messages)
    ? req.messages
    : Array.isArray(req.input)
      ? req.input
      : typeof req.input === "string"
        ? [{ role: "user", content: req.input }]
        : [];
  const messages: ContextMessage[] = [];
  for (const m of list) {
    const cm = oneMessage(m);
    if (!cm) continue;
    const isSystem = cm.role === "system" || cm.role === "developer";
    // Only system messages ahead of the conversation are the prompt; later ones are updates and stay where they were sent.
    if (isSystem && messages.length === 0) system = system === null ? cm.text : `${system}\n\n${cm.text}`;
    else messages.push(isSystem ? { ...cm, role: "system", update: true } : cm);
  }
  const tools = (Array.isArray(req.tools) ? req.tools : []).flatMap((t) => {
    if (!isObj(t)) return [];
    const f = isObj(t.function) ? t.function : t;
    return typeof f.name === "string"
      ? [
          {
            name: f.name,
            description: typeof f.description === "string" ? f.description : "",
            schema: f.parameters ?? f.input_schema ?? f.schema ?? null,
          },
        ]
      : [];
  });
  return { system, messages, tools, recognised: system !== null || messages.length > 0 || tools.length > 0 };
}

export interface ResponseView {
  text: string;
  /** The model's reasoning, shown apart from the answer. Empty when the response carried none. */
  reasoning: string;
  calls: string[];
  recognised: boolean;
}

/** The model's answer as text, reasoning and tool calls; an SSE stream (a string) is shown as written. */
export function describeResponse(res: unknown): ResponseView {
  if (typeof res === "string") return { text: res, reasoning: "", calls: [], recognised: true };
  if (!isObj(res)) return { text: "", reasoning: "", calls: [], recognised: false };
  const texts: string[] = [];
  const reasoning: string[] = [];
  const calls: string[] = [];
  const take = (m: unknown) => {
    const cm = oneMessage(m);
    if (!cm) return;
    if (cm.role === "reasoning") {
      if (cm.text) reasoning.push(cm.text);
      return;
    }
    if (cm.text) texts.push(cm.text);
    if (cm.reasoning) reasoning.push(cm.reasoning);
    calls.push(...cm.calls);
  };
  if (Array.isArray(res.choices)) for (const c of res.choices) take(isObj(c) ? c.message : null);
  if (Array.isArray(res.content)) take({ role: "assistant", content: res.content });
  // Output items carry the reasoning too, so they are read even when `output_text` gives the answer.
  if (Array.isArray(res.output)) for (const o of res.output) take(o);
  if (typeof res.output_text === "string" && texts.length === 0) texts.push(res.output_text);
  if (isObj(res.message)) take(res.message);
  if (typeof res.text === "string" && texts.length === 0) texts.push(res.text);
  return {
    text: texts.join("\n\n"),
    reasoning: reasoning.join("\n\n"),
    calls,
    recognised: texts.length > 0 || calls.length > 0 || reasoning.length > 0,
  };
}

/**
 * Splits a long system prompt into its sections: `<name>...</name>` blocks (how prompt sections are tagged), else markdown
 * headings ("# Memory", "## Tools"). A prompt with neither comes back as one untitled section.
 */
export function systemSections(text: string): { title: string | null; body: string }[] {
  const tagged: { title: string | null; body: string }[] = [];
  let last = 0;
  const re = /^<([A-Za-z_][\w-]*)>[ \t]*\n?([\s\S]*?)\n?<\/\1>[ \t]*$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(last, m.index).trim();
    if (before) tagged.push({ title: null, body: before });
    tagged.push({ title: m[1]!, body: m[2]!.trim() });
    last = m.index + m[0].length;
  }
  if (tagged.length > 0) {
    const rest = text.slice(last).trim();
    if (rest) tagged.push({ title: null, body: rest });
    return tagged;
  }
  const out: { title: string | null; lines: string[] }[] = [{ title: null, lines: [] }];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    const h = !fenced && /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (h) out.push({ title: h[1]!, lines: [] });
    else out[out.length - 1]!.lines.push(line);
  }
  return out
    .map((x) => ({ title: x.title, body: x.lines.join("\n").trim() }))
    .filter((x) => x.title !== null || x.body !== "");
}

/** Friendly labels for app-owned sections; unknown headings and historical untagged text stay readable. */
export function promptSectionLabel(name: string): string {
  const labels: Record<string, string> = {
    instructions: "Agent instructions",
    clock: "Date and time",
    session_role: "Session role",
    delegation: "Delegation",
    sessions: "Worker sessions",
    sandbox: "Sandbox",
    browser: "Browser",
    web: "Web",
    connectors: "Connectors",
    approvals: "Approvals",
    skills: "Skills",
    skill_saving: "Saving skills",
    memory: "Memory",
    profile: "Profile",
    recent: "Recent history",
    components: "Response components",
    triggers: "Triggers",
    trigger_run: "Trigger run",
    tool_activity: "Tool activity",
    untrusted_content: "Untrusted content",
  };
  return labels[name] ?? name;
}
