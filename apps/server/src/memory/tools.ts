// The "memory" extension: history search, the profile docs as tools, and the prompt sections that carry them.
// search_history and history_context are read_internal, but what they return can come from chats that read outside
// content, so the calling session gains those chats' labels. The write tools are decided as `memory_write` when the user
// is behind the run, and as `write_internal` (a suggestion, not a write) when the run is going without them.

import type { JsonValue } from "@earendil-works/chord/json";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { arr, bool, int, nullable, num, obj, opt, str } from "@earendil-works/pi-schema";
import type { ActionClass, MemoryDoc, TaintLabel } from "@rei/protocol";
import { behaviorSettings, CONFIGLESS } from "../pi/behavior-settings.ts";
import { MODEL_AND_SCRIPTS } from "../pi/callers.ts";
import { policyTool, type ToolCatalog, type ToolPolicy } from "../pi/policy-ext.ts";
import { shownChildren } from "../pi/session-list.ts";
import { statusWord } from "../pi/session-tools.ts";
import { steadyText } from "../pi/steady-section.ts";
import { toJson } from "../pi/structured.ts";
import type { AppStore, RunRow, SessionRow } from "../store/store.ts";
import { replyText } from "../surfaces/text.ts";
import { HttpError } from "../util/errors.ts";
import { localDay, localDayRange } from "../util/time.ts";
import { formatMemoryDoc } from "./format.ts";
import { looksSecret, SECRET_REFUSAL } from "./guard.ts";
import type { MemoryService } from "./service.ts";

export const MEMORY_CONNECTOR = "memory";
const DAY_MS = 86_400_000;
const CONTEXT_CLIP = 1_500;

type ToolText = { output: { type: "text"; text: string }[]; isError?: true; structuredOutput?: JsonValue };
const ok = (text: string, structuredOutput?: unknown): ToolText => ({
  output: [{ type: "text", text }],
  ...(structuredOutput !== undefined ? { structuredOutput: toJson(structuredOutput) } : {}),
});
const fail = (text: string): ToolText => ({ isError: true, output: [{ type: "text", text }] });
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();
const day = (ms: number): string => localDay(ms);

export const MEMORY_NOTE = [
  "You keep a small memory of the user and can search every past chat.",
  '- Where things go: facts about the user go in the profile (doc: "profile", the default), which every agent sees. Your own standing instructions and working notes go in your agent notes (doc: "agent"), which only you see. If a fact would help any agent, it goes in the profile. What was said earlier is found with search_history.',
  "- Save durable facts and preferences in the turn the user states them (memory_add). Replace a saved line they correct (memory_replace) and confirm one they repeat (memory_confirm); check your context first to avoid duplicates. Lines in your context are labelled with the file they belong to.",
  "- Lines show when they were last confirmed: an old date means the fact may be out of date, so check before relying on it.",
  '- Search before you answer or ask when the user refers to earlier talk ("last time", "we decided"), names something you do not recognise, or when you are about to ask for something they may already have told you; use history_context to read around a hit. Skip it for self-contained requests.',
  "- Never save passwords, keys, codes or card numbers, and do not save passing details of one task. Search results can quote untrusted outside content.",
].join("\n");

/** The tools' view of the run in progress. */
interface RunFacts {
  /** The user is behind this run (see runs.direct). */
  direct: boolean;
  agentId: string;
  /** For replace and remove: the doc of the line. */
  doc: MemoryDoc;
  ownerAgent: string | null;
}

export interface MemoryToolsDeps {
  treeId: string;
  store: AppStore;
  memory: MemoryService;
  catalog: ToolCatalog;
}

/** An ISO date or time as epoch ms; a date alone is a day in the user's zone, and as an end of range covers the whole of it. */
function parseWhen(value: string | undefined, end: boolean): number | undefined | "bad" {
  if (value === undefined || value.trim() === "") return undefined;
  const v = value.trim();
  const range = localDayRange(v);
  if (range) return end ? range.end : range.start;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? "bad" : ms;
}

const SUGGESTED = "Suggested to the agent that started this session; it decides whether to save it.";

const roleWord = (kind: string, toolName: string | null): string =>
  kind === "user" ? "you" : kind === "tool" ? `tool ${toolName ?? ""}`.trim() : kind;

/** What a script gets from search_history: the hits the text lists, in the same order, and the note above them. */
const SearchHistoryOutput = obj({
  hits: arr(
    obj({
      rank: int({ description: "1-based position in the list." }),
      messageId: str({ description: "Pass to history_context." }),
      sessionId: str(),
      sessionTitle: str(),
      agentId: str(),
      agentName: nullable(str()),
      kind: StringEnum(["user", "assistant", "report", "tool"]),
      toolName: nullable(str({ description: "For kind tool: the tool whose result matched." })),
      createdAt: num({ description: "Epoch milliseconds." }),
      date: str({ description: "Local day, YYYY-MM-DD." }),
      snippet: str(),
      related: bool({ description: "true: a possible lead, not a match for the words asked." }),
    }),
  ),
  note: str({ description: "How far to trust the hits; also the message for an empty search." }),
});

/** What a script gets from history_context: the window of messages in order, the one asked for marked. */
const HistoryContextOutput = obj({
  sessionId: str(),
  title: str(),
  messages: arr(
    obj({
      id: str(),
      role: str({ description: "user, assistant or report." }),
      fromOtherSession: bool({ description: "A user-role message sent by another session, not typed by the user." }),
      createdAt: num({ description: "Epoch milliseconds." }),
      date: str({ description: "Local day, YYYY-MM-DD." }),
      text: str({ description: "Cut at 1,500 characters, as in the text output." }),
      target: bool({ description: "The message history_context was asked about." }),
    }),
  ),
});

export function createMemoryExtension(deps: MemoryToolsDeps): Extension {
  const { treeId, store, memory, catalog } = deps;
  const memoryBehavior = () => behaviorSettings(store, CONFIGLESS).memory;
  const callerOf = (conversationId: unknown): SessionRow | undefined =>
    store.sessionByConversation(treeId, String(conversationId));
  const runningRun = (sessionId: string): RunRow | undefined => store.runningRun(sessionId);

  /** The message that started the run (for an approval re-run, the message before it, which is what the user actually said). */
  const sourceOf = (session: SessionRow, run: RunRow | undefined): { sessionId: string; messageId: string } | null => {
    if (!run) return null;
    if (run.kind === "input") return { sessionId: session.id, messageId: run.user_message_id };
    // A continue has no input of its own: the input of the run it continues is what the user said.
    const input = store.runs
      .forSession(session.id)
      .filter((r) => r.kind === "input" && r.created_at <= run.created_at)
      .at(-1);
    return input ? { sessionId: session.id, messageId: input.user_message_id } : null;
  };

  const factsFor = (args: { id?: string; doc?: string }, session: SessionRow): RunFacts => {
    const run = runningRun(session.id);
    const line = typeof args.id === "string" ? memory.lines.line(args.id) : undefined;
    const doc: MemoryDoc = line ? line.doc : args.doc === "agent" ? "agent" : "profile";
    return { direct: run ? run.direct === 1 : true, agentId: session.agent_id, doc, ownerAgent: line?.agentId ?? null };
  };
  const inspect = async (args: unknown, session: SessionRow): Promise<RunFacts> =>
    factsFor((args ?? {}) as { id?: string; doc?: string }, session);

  const writePolicy = (operation: string, summary: ToolPolicy["summary"]): ToolPolicy => ({
    actionClass: "memory_write",
    connector: MEMORY_CONNECTOR,
    operation,
    inspect,
    // Without facts (the inspection failed) it is decided as a write the user is behind: the stricter reading.
    classFor: (_a, _t, facts?: RunFacts): ActionClass => (facts?.direct === false ? "write_internal" : "memory_write"),
    destination: (_a, facts?: RunFacts) =>
      facts?.doc === "agent" ? `agent:${facts.ownerAgent ?? facts.agentId}` : "profile",
    summary,
  });
  const readPolicy = (operation: string, summary: ToolPolicy["summary"]): ToolPolicy => ({
    actionClass: "read_internal",
    connector: MEMORY_CONNECTOR,
    operation,
    summary,
  });

  /** Runs a write tool for the caller; an HttpError (the rules) goes back to the model as the tool's error. */
  const withWriter = (
    conversationId: unknown,
    run: (session: SessionRow, active: RunRow | undefined, direct: boolean) => ToolText,
  ): ToolText => {
    const session = callerOf(conversationId);
    if (!session) return fail("This session is no longer available.");
    const active = runningRun(session.id);
    try {
      return run(session, active, active ? active.direct === 1 : false);
    } catch (error) {
      if (error instanceof HttpError) return fail(error.message);
      throw error;
    }
  };

  /** A line the caller may change: any profile line, or a line of its own agent's notes. */
  const editable = (id: string, session: SessionRow) => {
    const line = memory.lines.line(id);
    if (!line)
      return { error: fail(`There is no saved line [${id}]. Lines are listed in your context with their ids.`) };
    if (line.doc === "agent" && line.agentId !== session.agent_id)
      return { error: fail("That line is in another agent's notes; you can only change your own.") };
    return { line };
  };

  const docParam = opt(
    StringEnum(["profile", "agent"], {
      description:
        "profile: about the user, shared by every agent (default). agent: your own standing notes and instructions.",
    }),
  );

  const memoryAdd = policyTool(
    catalog,
    writePolicy("write", (a: { text: string }) => `Save to memory: ${clip(flat(String(a.text ?? "")), 120)}`),
    {
      name: "memory_add",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Use when the user states a durable fact or preference about themselves or how they want things done; save it in that turn without being asked. Saves one short line: one fact per line, under 500 characters. Check your context for an existing line first (replace or confirm it instead). Never passwords, keys, codes or card numbers.",
      parameters: obj({ text: str({ description: "The fact, as a short sentence." }), doc: docParam }),
      replay: "safe",
      execute: async (args, api) =>
        withWriter(api.conversationId, (session, run, direct) => {
          if (looksSecret(args.text)) return fail(SECRET_REFUSAL);
          const doc = (args.doc ?? "profile") as MemoryDoc;
          if (!direct) {
            memory.lines.suggest({ doc, agentId: session.agent_id, op: "add", text: args.text, sessionId: session.id });
            return ok(SUGGESTED);
          }
          const { line } = memory.lines.add(
            { doc, agentId: session.agent_id, text: args.text },
            {
              by: "agent",
              sessionId: session.id,
              source: sourceOf(session, run),
              chip: { sessionId: session.id, runId: run?.id ?? null },
              agentOf: session.agent_id,
            },
          );
          return ok(`Saved [${line.id}].`);
        }),
    },
  );

  const memoryReplace = policyTool(
    catalog,
    writePolicy(
      "write",
      (a: { id: string; text: string }) => `Change memory [${a.id}] to: ${clip(flat(String(a.text ?? "")), 120)}`,
    ),
    {
      name: "memory_replace",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Replace the text of a saved line (by its id, like m12) because the user corrected or updated it. Counts as confirming it today.",
      parameters: obj({
        id: str({ description: "The line id, for example m12." }),
        text: str(),
        doc: docParam,
      }),
      replay: "safe",
      execute: async (args, api) =>
        withWriter(api.conversationId, (session, run, direct) => {
          if (looksSecret(args.text)) return fail(SECRET_REFUSAL);
          const found = editable(args.id, session);
          if (found.error) return found.error;
          if (args.doc !== undefined && args.doc !== found.line.doc)
            return fail(
              `[${args.id}] is in the ${found.line.doc === "profile" ? "profile" : "agent notes"}, not the ${args.doc === "profile" ? "profile" : "agent notes"}.`,
            );
          if (!direct) {
            memory.lines.suggest({
              doc: found.line.doc,
              agentId: found.line.agentId,
              op: "replace",
              lineId: found.line.id,
              text: args.text,
              sessionId: session.id,
            });
            return ok(SUGGESTED);
          }
          const { line } = memory.lines.replace(found.line.id, args.text, {
            by: "agent",
            sessionId: session.id,
            source: sourceOf(session, run),
            chip: { sessionId: session.id, runId: run?.id ?? null },
            agentOf: session.agent_id,
          });
          return ok(`Replaced [${line.id}].`);
        }),
    },
  );

  const memoryRemove = policyTool(
    catalog,
    writePolicy("write", (a: { id: string }) => `Remove memory [${a.id}]`),
    {
      name: "memory_remove",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Remove a saved line (by its id, like m12) that is no longer true or that the user asked you to forget.",
      parameters: obj({ id: str({ description: "The line id, for example m12." }) }),
      replay: "safe",
      execute: async (args, api) =>
        withWriter(api.conversationId, (session, run, direct) => {
          const found = editable(args.id, session);
          if (found.error) return found.error;
          if (!direct) {
            memory.lines.suggest({
              doc: found.line.doc,
              agentId: found.line.agentId,
              op: "remove",
              lineId: found.line.id,
              sessionId: session.id,
            });
            return ok(SUGGESTED);
          }
          memory.lines.remove(found.line.id, {
            by: "agent",
            sessionId: session.id,
            source: sourceOf(session, run),
            chip: { sessionId: session.id, runId: run?.id ?? null },
            agentOf: session.agent_id,
          });
          return ok(`Removed [${found.line.id}].`);
        }),
    },
  );

  // A confirm only moves a date, so it is an internal write and silent: no chip, no approval.
  const memoryConfirm = policyTool(
    catalog,
    {
      actionClass: "write_internal",
      connector: MEMORY_CONNECTOR,
      operation: "confirm",
      summary: (a: { id: string }) => `Confirm memory [${a.id}]`,
    },
    {
      name: "memory_confirm",
      callers: MODEL_AND_SCRIPTS,
      description:
        "The user repeated or showed that a saved line is still true: move its confirmed date to today (by its id, like m12). Use it instead of adding the same fact again.",
      parameters: obj({ id: str({ description: "The line id, for example m12." }) }),
      replay: "safe",
      execute: async (args, api) =>
        withWriter(api.conversationId, (session, _run, direct) => {
          const found = editable(args.id, session);
          if (found.error) return found.error;
          // Only the user restating a fact confirms it; a session working on a brief has not heard it from them.
          if (!direct) return ok("Not confirmed: only a conversation with the user confirms a fact.");
          memory.lines.confirm(found.line.id, { by: "agent", sessionId: session.id });
          return ok(`Confirmed [${found.line.id}].`);
        }),
    },
  );

  const searchHistory = policyTool(
    catalog,
    readPolicy("search", (a: { query: string }) => `Search history: ${clip(String(a.query ?? ""), 80)}`),
    {
      name: "search_history",
      callers: MODEL_AND_SCRIPTS,
      description:
        'Use before answering when the user refers to earlier work or talk ("last time", "as before", "we decided"), names something you do not recognise, or when you are about to ask for something they may already have told you. Searches everything the user has said and every reply and report in all chats and sessions, plus long tool results. Matches words (names, codes, numbers) and meaning, in any language. Optional from/to are ISO dates (2026-09-01); optional agent (a name or id) limits it to one agent\'s chats. Returns up to 8 hits with the message id; use history_context to read around one. In a script it returns { hits: [{ messageId, snippet, kind, date, related, ... }], note }.',
      parameters: obj({
        query: str({ description: "What to look for." }),
        from: opt(str({ description: "Earliest date, ISO (2026-09-01)." })),
        to: opt(str({ description: "Latest date, ISO (2026-09-30)." })),
        agent: opt(str({ description: "Only this agent's chats (its name or id). Default: every agent's." })),
      }),
      structuredOutputSchema: SearchHistoryOutput,
      replay: "safe",
      execute: async (args, api) => {
        const session = callerOf(api.conversationId);
        if (!session) return fail("This session is no longer available.");
        const from = parseWhen(args.from, false);
        const to = parseWhen(args.to, true);
        if (from === "bad" || to === "bad") return fail("from and to must be ISO dates, like 2026-09-01.");
        if (args.query.trim() === "") return fail("Give something to search for.");
        const agents = store.listAgents();
        let agentId: string | undefined;
        if (args.agent !== undefined && args.agent.trim() !== "") {
          const wanted = args.agent.trim().toLowerCase();
          const found =
            agents.find((a) => a.id.toLowerCase() === wanted) ?? agents.find((a) => a.name.toLowerCase() === wanted);
          if (!found)
            return fail(
              `There is no agent "${clip(flat(args.agent), 60)}". Agents: ${agents.map((a) => a.name).join(", ")}.`,
            );
          agentId = found.id;
        }
        let hits;
        try {
          const source = sourceOf(session, runningRun(session.id));
          hits = (
            await memory.search({
              query: args.query,
              ...(source ? { excludeMessageId: source.messageId } : {}),
              ...(agentId !== undefined ? { agentId } : {}),
              ...(from !== undefined ? { from } : {}),
              ...(to !== undefined ? { to } : {}),
              limit: memoryBehavior().historyHits,
            })
          ).slice(0, memoryBehavior().historyHits);
        } catch (error) {
          if (error instanceof HttpError) return fail(error.message);
          throw error;
        }
        if (hits.length === 0) {
          const none =
            "No sufficiently relevant matches in history. This does not prove the fact was never discussed; try a more specific query if needed.";
          return ok(none, { hits: [], note: none });
        }
        // Reading what other chats held brings their labels along (the user's own words carry none).
        const labels = new Set<TaintLabel>();
        for (const h of hits) for (const l of h.taint) labels.add(l);
        if (labels.size > 0) store.addTaint(session.id, [...labels]);
        const note = hits.every((h) => h.relevance === "related")
          ? "No sufficiently relevant matches. Possible leads follow; read history_context and verify the requested fact before answering. If absent, say you do not know."
          : "Search candidates follow, not verified answers. Read history_context to verify the requested fact; possible leads may not contain it.";
        return ok(
          [
            note,
            ...hits.map(
              (h, i) =>
                `${i + 1}. ${h.relevance === "related" ? "[Possible lead] " : ""}${day(h.createdAt)} · ${agents.length > 1 ? `${agents.find((a) => a.id === h.agentId)?.name ?? "?"} · ` : ""}"${clip(flat(h.sessionTitle), 60)}" · ${roleWord(h.kind, h.toolName)}: ${h.snippet} [message ${h.messageId}]`,
            ),
          ].join("\n"),
          {
            hits: hits.map((h, i) => ({
              rank: i + 1,
              messageId: h.messageId,
              sessionId: h.sessionId,
              sessionTitle: h.sessionTitle,
              agentId: h.agentId,
              agentName: agents.find((a) => a.id === h.agentId)?.name ?? null,
              kind: h.kind,
              toolName: h.toolName,
              createdAt: h.createdAt,
              date: day(h.createdAt),
              snippet: h.snippet,
              related: h.relevance === "related",
            })),
            note,
          },
        );
      },
    },
  );

  const historyContext = policyTool(
    catalog,
    readPolicy("context", (a: { message_id: string }) => `Read history around ${a.message_id}`),
    {
      name: "history_context",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Use after search_history, before relying on a hit: reads the messages around one (its id), in that chat, a few before and after, in order. In a script it returns { sessionId, title, messages: [{ id, role, text, target, ... }] }.",
      parameters: obj({
        message_id: str({ description: "The id from a search_history hit." }),
        before: opt(int({ minimum: 0, maximum: 10, description: "Messages before it (default 2)." })),
        after: opt(int({ minimum: 0, maximum: 10, description: "Messages after it (default 2)." })),
      }),
      structuredOutputSchema: HistoryContextOutput,
      replay: "safe",
      execute: async (args, api) => {
        const session = callerOf(api.conversationId);
        if (!session) return fail("This session is no longer available.");
        const hit = store.db.get<{ session_id: string }>(
          "SELECT session_id FROM history_entries WHERE message_id = ? OR (message_id IS NULL AND 'a:' || run_id = ?) LIMIT 1",
          args.message_id,
          args.message_id,
        );
        if (!hit || !store.getSessionRow(hit.session_id) || !store.reader) return fail("No such message.");
        const page = await store.reader.around(hit.session_id, args.message_id);
        const target = page?.items[page.at];
        if (!page || !target || target.internal) return fail("No such message.");
        const before = Math.max(0, Math.min(10, args.before ?? 2));
        const after = Math.max(0, Math.min(10, args.after ?? 2));
        const all = page.items.filter(
          (m) => !m.internal && (m.role === "user" || m.role === "assistant" || m.role === "report"),
        );
        const at = all.findIndex((m) => m.id === target.id);
        const window = at < 0 ? [target] : all.slice(Math.max(0, at - before), at + after + 1);
        const owner = store.getSessionRow(hit.session_id)!;
        const contextText = (m: (typeof window)[number]): string =>
          clip(
            m.role === "report" && m.report
              ? `${m.report.title} ${m.report.outcome}: ${m.report.summary}`
              : replyText(m.text, m.parts),
            CONTEXT_CLIP,
          );
        const labels = new Set<TaintLabel>();
        const lines = window.map((m) => {
          const own = m.role === "user" && !m.from;
          if (!own) for (const l of JSON.parse(owner.taint) as TaintLabel[]) labels.add(l);
          const who = m.role === "user" ? (m.from ? "from another session" : "you") : m.role;
          return `${m.id === target.id ? "> " : ""}[${m.id}] ${who} (${day(m.createdAt)}): ${contextText(m)}`;
        });
        if (labels.size > 0) store.addTaint(session.id, [...labels]);
        return ok(`Chat "${clip(flat(owner.title), 60)}":\n${lines.join("\n")}`, {
          sessionId: hit.session_id,
          title: owner.title,
          messages: window.map((m) => ({
            id: m.id,
            role: m.role,
            fromOtherSession: m.role === "user" && !!m.from,
            createdAt: m.createdAt,
            date: day(m.createdAt),
            text: contextText(m),
            target: m.id === target.id,
          })),
        });
      },
    },
  );

  return defineExtension({
    name: "memory",
    namespace: { name: "memory", description: "The user's memory notes and the history of past chats." },
    tools: [searchHistory, historyContext, memoryAdd, memoryReplace, memoryRemove, memoryConfirm],
    sections: [
      section("memory", (input) => {
        try {
          return `${MEMORY_NOTE}${identityText(store, callerOf(input.conversationId)?.agent_id)}`;
        } catch {
          return MEMORY_NOTE;
        }
      }),
      section("profile", (input) => {
        try {
          if (!memoryBehavior().injectProfile) return undefined;
          const caller = callerOf(input.conversationId);
          if (!caller) return undefined;
          return steadyText(profileText(memory, caller.agent_id, store.clock.now()), "No saved profile or notes yet.");
        } catch {
          return undefined;
        }
      }),
      section("recent", (input) => {
        try {
          if (!memoryBehavior().injectRecent) return undefined;
          const caller = callerOf(input.conversationId);
          if (!caller) return undefined;
          return steadyText(recentText(store, caller, store.clock.now()), "No recent activity in your other sessions.");
        } catch {
          return undefined;
        }
      }),
    ],
  });
}

/**
 * Who the model is, so it can narrow search_history to its own chats. Only the caller's own agent is named: listing the
 * other agents here would change every conversation's prompt (and break its cache) whenever any agent is created or
 * renamed. search_history's error for an unknown agent lists the agents instead. Empty when the agent is unknown.
 */
export function identityText(store: AppStore, agentId: string | undefined): string {
  const me = agentId === undefined ? undefined : store.getAgent(agentId);
  if (!me) return "";
  return `\nYou are ${me.name} (agent id ${me.id}). search_history covers every agent's chats; pass agent (a name or id, e.g. agent: "${me.name}" for your own) to narrow it. An unknown name returns the list of agents.`;
}

/** The always-in-context docs: the profile, then the agent's own notes. Undefined when both are empty. */
export function profileText(memory: MemoryService, agentId: string, now: number): string | undefined {
  const parts = [
    formatMemoryDoc("profile", memory.lines.lines("profile", null), now),
    formatMemoryDoc("agent", memory.lines.lines("agent", agentId), now),
  ].filter(Boolean);
  return parts.length === 0 ? undefined : parts.join("\n");
}

/**
 * Up to 8 other recent sessions of the caller's agent (not home chats), newest first: id, date, title, status and one
 * line of what came of it. Sessions the caller started and lists in its sessions section are left out.
 */
export function recentText(store: AppStore, caller: { id: string; agent_id: string }, now: number): string | undefined {
  const since = now - 7 * DAY_MS;
  const all = store.listSessions();
  // A fork sees its source only up to the fork point, so the sessions it was branched from stay out of the digest.
  const ancestors = new Set<string>();
  for (
    let at = all.find((s) => s.id === caller.id)?.forkedFrom?.sessionId;
    at && !ancestors.has(at);
    at = all.find((s) => s.id === at)?.forkedFrom?.sessionId
  )
    ancestors.add(at);
  const listed = new Set(shownChildren(store.childrenOf(caller.id)).shown.map((c) => c.id));
  const sessions = all
    .filter(
      (s) =>
        s.id !== caller.id &&
        s.agentId === caller.agent_id &&
        !ancestors.has(s.id) &&
        !listed.has(s.id) &&
        s.origin !== "home" &&
        s.updatedAt >= since,
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
    .slice(0, 8);
  if (sessions.length === 0) return undefined;
  const lines = sessions.map((s) => {
    const result = s.parentSessionId ? store.lastReportFrom(s.parentSessionId, s.id)?.summary : undefined;
    const one = clip(flat(result && result.trim() !== "" ? result : s.preview), 120);
    return `- ${s.id} ${day(s.updatedAt)} "${clip(flat(s.title), 80)}" ${statusWord(s.status)}${one === "" ? "" : `: ${one}`}`;
  });
  return ["Recent activity in your other sessions, newest first (read one with read_chat):", ...lines].join("\n");
}
