import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { liveSurface, surfaceDirectives } from "./faux-surfaces.ts";

/**
 * Test-only model (`REI_MODEL_MODE=faux`). The reply depends on directives in the last user message:
 *   [len=N]    a reply of about N characters (default 240)
 *   [error]    a failed call with a non-retryable error
 *   [error-once]  like [error] the first time this factory sees that message (a Continue then succeeds)
 *   [empty]    an empty reply
 *   [md]       a markdown sample (headings, lists, code, a table), for working on the PWA
 *   /demo ui, /demo form, /demo ui bad, /demo live  surface scenarios (see faux-surfaces.ts)
 *   /demo trigger  calls create_trigger for a daily 09:00 prompt trigger named "Morning check" (the card to approve);
 *              /demo skill: calls save_skill with a small sample skill (its card)
 *   /demo codemode  calls the codemode tool with a script that loops over two list_sessions calls and prints one line
 *              (needs Code mode on, in Settings > Runtime > Tools, and a home chat, where list_sessions is offered)
 *   [spawn]    calls start_session with the rest of the message as the brief; [spawn: <brief>] with that brief (a brief
 *              may hold other directives, so the child can stream a long reply). After the tool result: one short sentence
 *   [list]     calls list_sessions
 *   [loop]     calls list_sessions again after every result, forever (the loop guard stops it)
 *   [tool: <name> <JSON args>]  calls that tool (several directives run one after the other); a tool that is not
 *              offered is loaded with search_capabilities first. After the last result: "I need your approval for
 *              that." when it was blocked, else a short line quoting the result
 *   [call: <name> <JSON args>]  like [tool: …] but made as written, even when the tool is not offered
 *   an input "[Approval #n approved] Make exactly this call again now, then ...: <tool> <json>" calls exactly that
 *   an input "[Approval #n approved] Network access to HOST is allowed now. Run the command ...: <command>" runs it with bash
 *   an input "[Approval #n denied|expired] ..." gets a one-sentence acknowledgement
 * A session report (input starting with "[Session report]") gets a short reply naming the session; when it carries a
 * "Memory suggestions: ..." line, the model first saves each suggestion with the memory tools.
 * Anything else is answered with a short echo, then filler.
 */
export interface FauxOptions {
  tokensPerSecond?: number;
}

type AnyMessage = { role: string; content?: unknown };

export function lastUserText(messages: readonly AnyMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) return last.content.map((c: { text?: string }) => c.text ?? "").join("");
  return "";
}

const MARKDOWN_SAMPLE = [
  "Here's a quick overview of **Pi Durable** sessions and how a reply is made.",
  "",
  "## How a turn runs",
  "",
  "1. The PWA posts your message with a `requestId`.",
  "2. The server submits it to the session's tree, *idempotently*.",
  "3. The model streams its answer back through the gateway.",
  "",
  "Things worth knowing:",
  "",
  "- Every call has a deadline: **120 s** to the first event, 30 s between events.",
  "- A crash mid-reply is recovered on restart, without duplicates.",
  "- Docs live at https://example.com/docs/pi-durable.",
  "",
  "```ts",
  "const sent = await api.sendMessage(sessionId, requestId, text);",
  "console.log(sent.runId); // same id on every resend",
  "```",
  "",
  "> Tip: resending with the same `requestId` never starts a second run.",
  "",
  "| Tier | Model | Use |",
  "| --- | --- | --- |",
  "| fast | gpt-6-luna | quick answers |",
  "| standard | gpt-6.1-sol | most chats |",
  "",
  "中文也可以：这是一个**混合**语言的段落。",
].join("\n");

/** `[spawn]` or `[spawn: <brief>]`; the brief may contain brackets of its own (they are matched). */
export function parseSpawn(prompt: string): { brief: string } | undefined {
  const start = prompt.indexOf("[spawn");
  if (start < 0) return undefined;
  const after = prompt[start + "[spawn".length];
  if (after === "]") {
    const brief = (prompt.slice(0, start) + prompt.slice(start + "[spawn]".length)).replace(/\s+/g, " ").trim();
    return { brief: brief || "Work on the task." };
  }
  if (after !== ":") return undefined;
  let depth = 1;
  let i = start + "[spawn:".length;
  const from = i;
  for (; i < prompt.length; i++) {
    if (prompt[i] === "[") depth++;
    else if (prompt[i] === "]" && --depth === 0) break;
  }
  const brief = prompt.slice(from, i).trim();
  return { brief: brief || "Work on the task." };
}

const toolResultText = (message: AnyMessage | undefined): string => {
  const content = message?.content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content.map((c: { type?: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : "")).join("");
};

export interface ToolDirective {
  name: string;
  args: Record<string, unknown>;
  /** `[call: …]`: made as written, even when the tool is not offered (no search_capabilities first). */
  direct?: true;
}

/** The end (exclusive) of the JSON object that starts at `start` in `text`, or -1. */
function jsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Every `[tool: <name> <JSON args>]` and `[call: <name> <JSON args>]` in a message, in order. */
export function parseToolDirectives(prompt: string): ToolDirective[] {
  const out: ToolDirective[] = [];
  const re = /\[(tool|call):\s*([A-Za-z0-9_.-]+)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const from = m.index + m[0].length;
    let args: Record<string, unknown> = {};
    if (prompt[from] === "{") {
      const end = jsonEnd(prompt, from);
      if (end < 0) continue;
      try {
        args = JSON.parse(prompt.slice(from, end)) as Record<string, unknown>;
      } catch {
        continue;
      }
      re.lastIndex = end;
    }
    out.push({ name: m[2]!, args, ...(m[1] === "call" ? { direct: true as const } : {}) });
  }
  return out;
}

/** An approval re-run input: the exact call it names. */
export function parseApprovalInput(prompt: string): ToolDirective | undefined {
  if (!prompt.startsWith("[Approval #") || !/approved\]/.test(prompt.slice(0, 40))) return undefined;
  // Network access that was approved: run the bash command it names again.
  const network =
    /Network access to \S+ is allowed now\. Run the command that needed it again[^:\n]*:\s*([\s\S]+)$/.exec(prompt);
  if (network) return { name: "bash", args: { command: network[1]!.trim() } };
  const m = /Make exactly this call again now[^:\n]*:\s*([A-Za-z0-9_.-]+)\s*(\{[\s\S]*\})\s*$/.exec(prompt);
  if (!m) return undefined;
  try {
    return { name: m[1]!, args: JSON.parse(m[2]!) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

/** A report's "Memory suggestions: ..." line: the faux model saves every one of them, as a parent that takes the advice would. */
export function parseMemorySuggestions(prompt: string): ToolDirective[] {
  const line = /^Memory suggestions: (.*)\. Decide whether to save them/m.exec(prompt)?.[1];
  if (line === undefined) return [];
  const out: ToolDirective[] = [];
  for (const part of line.split(/(?<=[")]); (?=add to |replace \[|remove \[)/)) {
    const add = /^add to (?:profile|agent notes): "([\s\S]*)"$/.exec(part);
    if (add) {
      out.push({
        name: "memory_add",
        args: { text: add[1]!, ...(part.startsWith("add to agent") ? { doc: "agent" } : {}) },
      });
      continue;
    }
    const replace = /^replace \[(\w+)\] with "([\s\S]*?)" \(now /.exec(part);
    if (replace) {
      out.push({ name: "memory_replace", args: { id: replace[1]!, text: replace[2]! } });
      continue;
    }
    const remove = /^remove \[(\w+)\]/.exec(part);
    if (remove) out.push({ name: "memory_remove", args: { id: remove[1]! } });
  }
  return out;
}

/** The script `/demo codemode` runs: two calls of a harmless read tool in a loop, one line of output. */
export const CODEMODE_DEMO_SCRIPT = [
  "let total = 0;",
  "for (let round = 1; round <= 2; round++) {",
  "  const listing = await tools.list_sessions({});",
  "  total += listing.length;",
  "}",
  'console.log("Listed my sessions twice; " + total + " characters read in all.");',
].join("\n");

/** The calls behind `/demo trigger`, `/demo skill` and `/demo codemode`, for trying the cards and the pages. */
export function demoDirectives(prompt: string): ToolDirective[] {
  const out: ToolDirective[] = [];
  if (/\/demo trigger\b/.test(prompt)) {
    out.push({
      name: "create_trigger",
      args: {
        name: "Morning check",
        start: { kind: "schedule", schedule: { kind: "daily", times: ["09:00"] } },
        action: { kind: "prompt", prompt: "Check my notes for anything due today and report one line." },
        report: "on_change",
      },
    });
  }
  if (/\/demo codemode\b/.test(prompt))
    // `direct`: made as written. With Code mode off the call fails like any call of an unknown tool.
    out.push({
      name: "codemode",
      args: { code: CODEMODE_DEMO_SCRIPT, _activity: "Check my sessions twice" },
      direct: true,
    });
  if (/\/demo skill\b/.test(prompt)) {
    out.push({
      name: "save_skill",
      args: {
        name: "weekly-summary",
        description:
          "Write a short weekly summary of what was done. Use when asked for a weekly update or a status summary.",
        body: "# Weekly summary\n\n1. Ask for or look up what was done this week.\n2. Group it by project; keep each group to two lines.\n3. End with one line on what is next.\n\nIf there is nothing to report for a project, leave it out instead of writing filler.",
      },
    });
  }
  return out;
}

/** The directives a message holds: an approval re-run is one call; a spawn brief's own directives belong to the child. */
export function directivesOf(prompt: string): ToolDirective[] {
  const approval = parseApprovalInput(prompt);
  if (approval) return [approval];
  if (prompt.startsWith("[Session report]")) return parseMemorySuggestions(prompt);
  if (parseSpawn(prompt) || prompt.startsWith("[Session report]")) return [];
  return [...parseToolDirectives(prompt), ...demoDirectives(prompt), ...surfaceDirectives(prompt)];
}

/** The tools offered at the end of a transcript: the system messages' tool changes, replayed in order. */
export function offeredTools(messages: readonly AnyMessage[]): Set<string> {
  const offered = new Set<string>();
  for (const m of messages) {
    if (m.role !== "system") continue;
    const sys = m as { toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };
    for (const t of sys.toolsAdded ?? []) offered.add(t.name);
    for (const t of sys.toolsRemoved ?? []) offered.delete(t.name);
  }
  return offered;
}

type CallMade = { name: string; args: unknown };
const isLoadOf = (call: CallMade | undefined, name: string): boolean => {
  const load = (call?.args as { load?: unknown } | undefined)?.load;
  return call?.name === SEARCH_CAPABILITIES && Array.isArray(load) && load.length === 1 && load[0] === name;
};

/**
 * The next call of a turn: the first directive not yet made, matched against the calls made so far. A directive whose
 * tool is not offered is reached the way a model reaches it: search_capabilities loads it first, once.
 */
export function nextDirective(
  directives: readonly ToolDirective[],
  made: readonly CallMade[],
  offered: ReadonlySet<string>,
): ToolDirective | undefined {
  let i = 0;
  for (const d of directives) {
    const loaded = isLoadOf(made[i], d.name) && d.name !== SEARCH_CAPABILITIES;
    if (loaded) i++;
    if (made[i]?.name === d.name) {
      i++;
      continue;
    }
    if (i < made.length) {
      i++; // another call took this directive's place (positional, as before)
      continue;
    }
    if (d.direct || loaded || offered.size === 0 || offered.has(d.name)) return d;
    return { name: SEARCH_CAPABILITIES, args: { load: [d.name] } };
  }
  return undefined;
}

/** The tool calls the assistant made after the last user message. */
function callsThisTurn(messages: readonly AnyMessage[]): CallMade[] {
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
  return messages
    .slice(lastUserIndex + 1)
    .filter((m) => m.role === "assistant" && Array.isArray(m.content))
    .flatMap((m) => m.content as { type: string; name?: string; arguments?: unknown }[])
    .filter((c) => c.type === "toolCall")
    .map((c) => ({ name: String(c.name), args: c.arguments }));
}

export function fauxReplyText(prompt: string): string {
  if (/\[md\]/.test(prompt)) return MARKDOWN_SAMPLE;
  const len = /\[len=(\d{1,6})\]/.exec(prompt)?.[1];
  const target = len ? Math.min(200_000, Number(len)) : 240;
  const clean = prompt
    .replace(/\[[a-z]+(=\d+)?\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const head = `Echo: ${clean.slice(0, 60)}. `;
  let text = head;
  let n = 1;
  while (text.length < target) text += `Part ${n++} of the reply. `;
  return text.slice(0, target);
}

const SEARCH_CAPABILITIES = "search_capabilities";

export function createFaux(options: FauxOptions = {}): FauxProviderHandle {
  return fauxProvider({ tokensPerSecond: options.tokensPerSecond ?? 60 });
}

/** A reply factory; `armFaux` queues one before every call so the provider never runs out of scripted answers. */
export function fauxFactory(): (ctx: { messages: readonly AnyMessage[] }) => AssistantMessage {
  const failedOnce = new Set<string>();
  return (ctx) => {
    const prompt = lastUserText(ctx.messages);
    if (prompt.startsWith('{"purpose":"memory.review"'))
      return fauxAssistantMessage(
        [fauxToolCall("finish_review", { outcome: "no_changes" }, { id: `review-${ctx.messages.length}` })],
        { stopReason: "toolUse" },
      );
    if (
      (prompt.startsWith("[Trigger result]") || prompt.startsWith("[Session report]")) &&
      prompt.includes("[dismiss-event]")
    ) {
      const results = ctx.messages
        .slice(ctx.messages.map((m) => m.role).lastIndexOf("user") + 1)
        .filter((m) => m.role === "toolResult");
      if (!results.length)
        return fauxAssistantMessage([fauxToolCall("dismiss_event", {}, { id: `dismiss-${ctx.messages.length}` })], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage(fauxText("This final text must stay internal."));
    }
    if (prompt.startsWith("[Trigger result]")) {
      const title = /"([^"\n]*)"/.exec(prompt)?.[1] ?? "your background check";
      const report = prompt
        .split("\n\n")
        .slice(1)
        .join("\n\n")
        .replace(/^\[Trigger "[^"\n]*"\]\s*/, "");
      return fauxAssistantMessage(fauxText(`Update from "${title}": ${report.slice(0, 180)}`));
    }
    // Pi appends section updates as system messages, so the last real message is the last one that is not a system one.
    const last = [...ctx.messages].reverse().find((m) => m.role !== "system");
    if (/\[loop\]/.test(prompt) && !prompt.startsWith("[Session report]")) {
      return fauxAssistantMessage([fauxToolCall("list_sessions", {}, { id: `loop-${ctx.messages.length}` })], {
        stopReason: "toolUse",
      });
    }
    // `/demo live`: start a worker, then show a progress surface it feeds (its id comes from start_session's result).
    if (/\/demo live\b/.test(prompt) && !prompt.startsWith("[Session report]")) {
      const made = callsThisTurn(ctx.messages);
      if (made.length === 0)
        return fauxAssistantMessage(
          [
            fauxToolCall(
              "start_session",
              { brief: "Research Kyoto hotels [len=6000]", title: "Kyoto research" },
              { id: `live-${ctx.messages.length}` },
            ),
          ],
          { stopReason: "toolUse" },
        );
      if (made.length === 1 && last?.role === "toolResult") {
        const id = /\((ses_[A-Za-z0-9_-]+)\)/.exec(toolResultText(last))?.[1];
        if (id)
          return fauxAssistantMessage(
            [fauxToolCall("show_surface", liveSurface(id) as never, { id: `live-${ctx.messages.length}` })],
            { stopReason: "toolUse" },
          );
      }
      if (last?.role === "toolResult")
        return fauxAssistantMessage(fauxText("I started the research; progress shows above."));
    }
    const directives = directivesOf(prompt);
    const made = callsThisTurn(ctx.messages);
    const offered = offeredTools(ctx.messages);
    if (prompt.includes("[tool round]") && directives.length > 1) {
      const missing = [...new Set(directives.filter((d) => !offered.has(d.name)).map((d) => d.name))];
      if (!made.length && missing.length)
        return fauxAssistantMessage([fauxToolCall(SEARCH_CAPABILITIES, { load: missing })], { stopReason: "toolUse" });
      if (made.every((call) => call.name === SEARCH_CAPABILITIES))
        return fauxAssistantMessage(
          directives.map((d, i) => fauxToolCall(d.name, d.args as never, { id: `round-${ctx.messages.length}-${i}` })),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(fauxText("I reviewed all the tool results."));
    }
    const next = nextDirective(directives, made, offered);
    if (next) {
      return fauxAssistantMessage(
        [fauxToolCall(next.name, next.args as never, { id: `tool-${ctx.messages.length}` })],
        { stopReason: "toolUse" },
      );
    }
    if (last?.role === "toolResult") {
      const said = toolResultText(last).replace(/\s+/g, " ").trim();
      if (/Approval #\d+ was (denied|expired|cancelled)\./.test(said))
        return fauxAssistantMessage(fauxText("I skipped the action after the approval ended."));
      if (said.includes("was interrupted and may have partially run"))
        return fauxAssistantMessage(fauxText("The action was interrupted and may have run."));
      if (/Tool call blocked|Blocked:|needs the user's approval \(#\d+\)/.test(said))
        return fauxAssistantMessage(fauxText("I need your approval for that."));
      return fauxAssistantMessage(fauxText(`Done. ${said.slice(0, 200)}`));
    }
    if (/^\[Approval #\d+ (denied|expired)\]/.test(prompt)) {
      return fauxAssistantMessage(fauxText("Understood, I will not do that."));
    }
    if (prompt.startsWith("[Session report]")) {
      const title = /"([^"]*)"/.exec(prompt)?.[1] ?? "the session";
      const outcome = /\)\s+(completed|failed|cancelled)/.exec(prompt)?.[1] ?? "finished";
      return fauxAssistantMessage(fauxText(`Noted: the session "${title}" ${outcome}.`));
    }
    const spawn = parseSpawn(prompt);
    if (spawn) {
      return fauxAssistantMessage(
        [fauxToolCall("start_session", { brief: spawn.brief }, { id: `spawn-${ctx.messages.length}` })],
        { stopReason: "toolUse" },
      );
    }
    if (/\[list\]/.test(prompt)) {
      return fauxAssistantMessage([fauxToolCall("list_sessions", {}, { id: `list-${ctx.messages.length}` })], {
        stopReason: "toolUse",
      });
    }
    if (/\[error-once\]/.test(prompt) && !failedOnce.has(prompt)) {
      failedOnce.add(prompt);
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "faux model failure (418)" });
    }
    if (/\[error\]/.test(prompt)) {
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "faux model failure (418)" });
    }
    if (/\[empty\]/.test(prompt)) return fauxAssistantMessage(fauxText(""));
    return fauxAssistantMessage(fauxText(fauxReplyText(prompt)));
  };
}

export function armFaux(faux: FauxProviderHandle, factory: ReturnType<typeof fauxFactory>): void {
  faux.appendResponses([factory as never]);
}
