import type { Extension } from "@earendil-works/pi-durable";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { AppStore, SessionRow } from "../store/store.ts";
import { MODEL_AND_SCRIPTS, MODEL_ONLY } from "./callers.ts";
import { policyTool, type ToolCatalog, type ToolPolicy } from "./policy-ext.ts";
import { type ChildSession, shownChildren } from "./session-list.ts";
import { steadyText } from "./steady-section.ts";

type ToolText = { output: { type: "text"; text: string }[]; isError?: true };
const ok = (text: string): ToolText => ({ output: [{ type: "text", text }] });
const fail = (text: string): ToolText => ({ isError: true, output: [{ type: "text", text }] });

/** What the session tools ask of the control plane (the Pi adapter implements it). Results are text for the model. */
export interface SessionHost {
  startSession(input: {
    caller: SessionRow;
    callId: string;
    brief: string;
    title?: string;
    agent?: string;
  }): Promise<ToolText>;
  messageSession(input: { caller: SessionRow; callId: string; sessionId: string; text: string }): Promise<ToolText>;
  cancelSession(input: { caller: SessionRow; sessionId: string }): Promise<ToolText>;
  listSessions(caller: SessionRow): ToolText;
}

/** The host is wired after the tree manager exists. */
export interface SessionHostRef {
  current: SessionHost | undefined;
}

export const DELEGATION_NOTE = [
  "In this home chat, you can run work in separate worker sessions.",
  "- Use start_session with a clear brief for substantial multi-step work (research, long writing, anything that takes many steps). Answer small requests directly.",
  "- After starting a session, tell the user in one sentence what you started and end your turn. Do not do the same work yourself, and do not check on it while it runs: it works on its own and posts one report back to this chat when it finishes, which starts your next turn. A session whose run fails posts no report: it shows as failed, and reports once a Continue finishes the work.",
  "- Use list_sessions, message_session and cancel_session when the user asks about a session you started, or wants to change or cancel it.",
  "- Workers using your agent share your sandbox workspace; a worker using another agent uses that agent's workspace, so include the context it needs in the brief.",
  "Reports arrive as messages that start with [Session report]. The user sees each report only as a one-line notice (the session finished, with a link), not its result, so your reply is how they hear the answer:",
  "- Always make it self-contained. When the answer is short (a fact or two), give it directly in a sentence or two, as if you had looked it up yourself. When it is longer, give the points that matter most for the user's request and mention that the full result is in the session; do not paste the whole result.",
  "- Add more only to connect it to earlier conversation, flag problems or gaps, or ask for a decision.",
  "- Call dismiss_event when nothing in the result is worth the user's attention (for example a routine check that found no change, or the user cancelled or replaced the request): the notice stays and you stay silent.",
].join("\n");

export const DELEGATION_OWN_NOTE = [
  "In this home chat, you can run work in separate worker sessions using your own agent.",
  "- Use start_session with a clear brief for substantial multi-step work (research, long writing, anything that takes many steps). Answer small requests directly.",
  "- After starting a session, tell the user in one sentence what you started and end your turn. Do not do the same work yourself, and do not check on it while it runs: it works on its own and posts one report back to this chat when it finishes, which starts your next turn. A session whose run fails posts no report: it shows as failed, and reports once a Continue finishes the work.",
  "- Use list_sessions, message_session and cancel_session when the user asks about a session you started, or wants to change or cancel it.",
  "- Workers share your sandbox workspace, so include the context it needs in the brief.",
  "Reports arrive as messages that start with [Session report]. The user sees each report only as a one-line notice (the session finished, with a link), not its result, so your reply is how they hear the answer:",
  "- Always make it self-contained. When the answer is short (a fact or two), give it directly in a sentence or two, as if you had looked it up yourself. When it is longer, give the points that matter most for the user's request and mention that the full result is in the session; do not paste the whole result.",
  "- Add more only to connect it to earlier conversation, flag problems or gaps, or ask for a decision.",
  "- Call dismiss_event when nothing in the result is worth the user's attention (for example a routine check that found no change, or the user cancelled or replaced the request): the notice stays and you stay silent.",
].join("\n");

/** Kept separate from the session-management extension, which only home conversations select. */
export function createSessionRoleExtension(treeId: string, store: AppStore): Extension {
  return defineExtension({
    name: "session_context",
    sections: [
      section("session_role", (input) => {
        const caller = store.sessionByConversation(treeId, String(input.conversationId));
        if (!caller) return undefined;
        if (caller.origin === "home") {
          const delegation = store.agentCapabilities(caller.agent_id).delegation;
          return delegation === "off"
            ? "This is your home chat. Talk with the user and complete requests directly using your tools. Worker delegation is disabled for this agent."
            : "This is your home chat. Talk with the user, coordinate your workers, and use their reports to answer the user.";
        }
        // A fork of a worker remains a worker even though its origin is now 'fork'.
        if (caller.origin === "spawned" || caller.depth > 0)
          return "This is a worker session. Complete the assigned brief yourself using your tools. Do not delegate to another session. Your final answer is the result; assigned runs report it back to the home chat automatically. State what you completed and any remaining limitations.";
        return "Complete the task yourself in this chat using your tools. Session delegation is available only in your agent's home chat.";
      }),
    ],
  });
}

const STATUS_WORD: Record<string, string> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  idle: "idle",
  waiting_for_user: "waiting for you",
};
export const statusWord = (status: string): string => STATUS_WORD[status] ?? status;

/**
 * The session tools and prompt sections, built for one tree: the closure knows the tree id, and a call resolves its
 * session from (tree id, Pi conversation id), since conversation ids are only unique within one tree file.
 */
export function createSessionExtension(
  treeId: string,
  store: AppStore,
  hostRef: SessionHostRef,
  catalog: ToolCatalog,
): Extension {
  const internal = (
    actionClass: "read_internal" | "write_internal",
    operation: string,
    summary: ToolPolicy["summary"],
  ): ToolPolicy => ({ actionClass, connector: "sessions", operation, summary });
  const callerOf = (conversationId: unknown): SessionRow | undefined =>
    store.sessionByConversation(treeId, String(conversationId));
  const withCaller = async (
    conversationId: unknown,
    run: (caller: SessionRow, host: SessionHost) => ToolText | Promise<ToolText>,
  ): Promise<ToolText> => {
    const host = hostRef.current;
    const caller = callerOf(conversationId);
    if (!host || !caller) return fail("This session is no longer available, so sessions cannot be managed from it.");
    if (caller.origin !== "home")
      return fail("Only an agent's home chat can manage worker sessions. Complete the task here yourself.");
    try {
      return await run(caller, host);
    } catch (error) {
      return fail(error instanceof Error && error.message ? error.message : "The session could not be managed.");
    }
  };

  const startSession = policyTool(
    catalog,
    internal(
      "write_internal",
      "session.start",
      (a: { brief: string }) => `Start a session: ${titleFromBrief(a.brief)}`,
    ),
    {
      name: "start_session",
      callers: MODEL_ONLY,
      description:
        "Start a separate session that works on a task in the background and reports back to this chat when it finishes. Use it for substantial multi-step work; it returns at once. Give a self-contained brief: the session cannot see this chat.",
      parameters: obj({
        brief: str({ description: "What the session should do, with all the context it needs." }),
        title: opt(str({ description: "A short title. Default: the first line of the brief." })),
        agent: opt(str({ description: "Agent id or name to run it. Default: your own agent." })),
      }),
      // Safe to run again after a crash because the spawn key (this session + this call id) makes it start one session at most.
      replay: "safe",
      execute: (args, api) =>
        withCaller(api.conversationId, (caller, host) =>
          host.startSession({
            caller,
            callId: api.callId,
            brief: args.brief,
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.agent !== undefined ? { agent: args.agent } : {}),
          }),
        ),
    },
  );

  const messageSession = policyTool(
    catalog,
    internal("write_internal", "session.message", (a: { session_id: string }) => `Message session ${a.session_id}`),
    {
      name: "message_session",
      callers: MODEL_ONLY,
      description:
        "Send a message to a session you started. If it is running, your message steers it after its current tool round. It reports back when it finishes.",
      parameters: obj({ session_id: str(), text: str() }),
      replay: "safe",
      execute: (args, api) =>
        withCaller(api.conversationId, (caller, host) =>
          host.messageSession({ caller, callId: api.callId, sessionId: args.session_id, text: args.text }),
        ),
    },
  );

  const cancelSession = policyTool(
    catalog,
    internal("write_internal", "session.cancel", (a: { session_id: string }) => `Cancel session ${a.session_id}`),
    {
      name: "cancel_session",
      callers: MODEL_ONLY,
      description: "Stop the work a session you started is doing.",
      parameters: obj({ session_id: str() }),
      replay: "safe",
      execute: (args, api) =>
        withCaller(api.conversationId, (caller, host) => host.cancelSession({ caller, sessionId: args.session_id })),
    },
  );

  const listSessions = policyTool(
    catalog,
    internal("read_internal", "session.list", () => "List your sessions"),
    {
      name: "list_sessions",
      callers: MODEL_AND_SCRIPTS,
      description: "List the sessions you started: id, title, status and the summary of the last report.",
      parameters: obj({}),
      replay: "safe",
      execute: (_args, api) => withCaller(api.conversationId, (caller, host) => host.listSessions(caller)),
    },
  );

  return defineExtension({
    name: "sessions",
    namespace: { name: "sessions", description: "Sessions you started, and chats you can read." },
    tools: [startSession, messageSession, cancelSession, listSessions],
    sections: [
      section("delegation", (input) => {
        const caller = callerOf(input.conversationId);
        if (caller?.origin !== "home") return undefined;
        return store.agentCapabilities(caller.agent_id).delegation === "own" ? DELEGATION_OWN_NOTE : DELEGATION_NOTE;
      }),
      // The sessions this one started, so "the hotel session" can be resolved without a tool call.
      section("sessions", (input) => {
        try {
          const caller = callerOf(input.conversationId);
          if (!caller) return undefined;
          return sessionsText(store.childrenOf(caller.id), caller.origin === "home");
        } catch {
          return undefined;
        }
      }),
    ],
  });
}

/** Kept separate from `sessions` so a home chat with worker delegation off can still dismiss trigger events. */
export function createHomeEventsExtension(treeId: string, store: AppStore, catalog: ToolCatalog): Extension {
  const callerOf = (conversationId: unknown): SessionRow | undefined =>
    store.sessionByConversation(treeId, String(conversationId));
  const dismissEvent = policyTool(
    catalog,
    {
      actionClass: "write_internal",
      connector: "sessions",
      operation: "event.dismiss",
      summary: () => "Keep a background event silent",
    },
    {
      name: "dismiss_event",
      callers: MODEL_ONLY,
      description:
        "Choose not to send the user a message for the current background event, because nothing in it is worth their attention (the one-line notice that a session finished stays). Only for a home-chat turn started by a session or trigger result. No notification or reply is published, even if you produce final text afterward. Does not dismiss direct user messages.",
      parameters: obj({}),
      replay: "safe",
      execute: async (_args, api) => {
        const caller = callerOf(api.conversationId);
        if (caller?.origin !== "home") return fail("Only the home assistant can dismiss background events.");
        const run = store.runningRun(caller.id);
        if (!run) return fail("There is no running event.");
        try {
          await store.dismissEvent(caller.id, run.id);
          return ok("Event dismissed. Finish this turn; no reply or notification will be published.");
        } catch (error) {
          return fail(error instanceof Error ? error.message : "Could not dismiss this event.");
        }
      },
    },
  );
  return defineExtension({
    name: "home_events",
    namespace: { name: "sessions", description: "Sessions you started, and chats you can read." },
    tools: [dismissEvent],
  });
}

/**
 * The sessions a chat started, newest first: every unfinished one and the latest finished ones. A home chat always
 * shows the section (a placeholder before its first session) so the first one is a small patch, not a prompt re-send.
 */
export function sessionsText(children: readonly ChildSession[], home: boolean): string | undefined {
  const { shown, hidden } = shownChildren(children);
  if (shown.length === 0) return home ? steadyText(undefined, "No sessions started yet.") : undefined;
  return [
    "Sessions you started, newest first (id, title, status):",
    ...shown.map((c) => `- ${c.id} "${c.title}" ${statusWord(c.status)}`),
    ...(hidden > 0 ? [`(${hidden} older finished sessions not shown; use list_sessions.)`] : []),
  ].join("\n");
}

/** The title a spawned session gets when the model gave none: the brief's first line, at most 60 characters. */
export function titleFromBrief(brief: string): string {
  const line =
    brief
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .find((l) => l !== "") ?? "";
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line || "Session";
}
