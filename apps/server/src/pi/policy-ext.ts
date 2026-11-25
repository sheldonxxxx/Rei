// Tool policy runs before dispatch. Supported connector calls can wait for approval in their original Pi run.

import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { Extension, HookApi, JsonObject, SignalKey, ToolRegistration } from "@earendil-works/pi-durable";
import { defineExtension, defineTool, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { str } from "@earendil-works/pi-schema";
import type { ActionClass, Approval, Grant, GrantLength, StepDecision, TaintLabel, TriggerAllow } from "@rei/protocol";
import { argsPreview, canonicalJson, canonicalProfile, type Decision, decide, isTainted } from "../policy/decision.ts";
import type { ApprovalDraft, ApprovalRow, ApprovalStore } from "../store/approvals.ts";
import type { AppStore, SessionRow } from "../store/store.ts";
import { sha256Hex } from "../util/encoding.ts";
import { Invalid } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import { APPROVAL_CHECKPOINT_MEMO, approvalRound } from "./approval-checkpoint.ts";
import { ApprovalWake } from "./signals.ts";
import type { StepRecorder } from "./steps.ts";
import { conciseArgumentError, type ToolFields, toolFields } from "./tool-arguments.ts";

/** What the policy needs to know about a tool; declared next to the tool. */
export interface ToolPolicy {
  actionClass: ActionClass;
  /** Require one-time approval independently of standing grants and trigger allowances. YOLO always runs automatically. */
  approvalOnce?: { reason: string; allowStandard?: boolean };
  /** Plugin configuration uses its own approval preview and permissions. */
  pluginConfiguration?: boolean;
  /** Public research grants cover these calls only. */
  webResearch?: (args: JsonObject) => boolean;
  /** Private browser typing can be approved for a site in this chat. */
  browserInput?: (args: JsonObject) => boolean;
  /**
   * Signal keys the call parks on, with no deadline, while it must not run yet (the browser's tools while the user controls
   * the window); undefined lets it go on. Asked right after the step is recorded and before any decision or approval, on
   * every pass of the gates, so it reads stored state only and answers the same each time.
   */
  parkOn?: (session: SessionRow, taskId: string) => SignalKey<unknown>[] | undefined;
  /** e.g. "sessions", "demo", "email"; with `operation` it names what a grant covers. */
  connector: string;
  operation: string;
  /**
   * What only the world can tell about this call (the browser's tools: the host of the page the window shows). Runs in the hook before the
   * decision, may be async, and its result is passed to `destination`, `classFor` and `summary` as `facts`. It must not
   * change anything; undefined (it threw, or there is nothing to learn) must be decided conservatively by those.
   */
  inspect?(args: unknown, session: SessionRow, context: Context, phase?: "execute"): Promise<unknown>;
  /** Opt in to durable inspect/execute binding (MCP). Missing facts fail closed. */
  binding?: (facts: any) => string | undefined;
  inspectionError?: (facts: any) => string | undefined;
  /** MCP profile decision, independent of chat profiles, standing grants and trigger allowances. */
  mcpPolicy?: (facts: any) => { automatic: boolean; authority: string };
  /** Fail closed even though the declared class is internal: the tool acts outside depending on the call (browser_type). */
  failClosed?: boolean;
  /** Who or where the call goes to, when it has a target. */
  destination?: (args: any, facts?: any) => string | null;
  /** One line for the approval card. */
  summary(args: unknown, facts?: unknown, session?: SessionRow): string;
  /** Labels the session gains when this (read_external) tool runs. */
  taint?: readonly TaintLabel[] | ((args: any, facts?: any) => readonly TaintLabel[]);
  /** What the approval card's arguments preview shows instead of the raw arguments (an MCP call: connector name, tool, arguments). */
  argsView?: (args: any, facts?: any) => unknown;
  /** A trigger's allow entry for this tool must name a destination (an MCP call: without one it would cover every connector). */
  allowNeedsDestination?: boolean;
  /**
   * The class this very call is decided as, given the session's labels; `actionClass` when absent. A tool that reads
   * outside content can be a send when the session holds private data (web_fetch: the URL can carry it out). The
   * declared `actionClass` still decides the taint a let-through call adds and whether the tool is fail closed.
   */
  classFor?: (args: any, taint: readonly TaintLabel[], facts?: any) => ActionClass;
  /**
   * Structured approval-card context (a trigger, skill or MCP provider), stored with the approval.
   * It runs before the decision on every call, and throws `Invalid` for a configure draft that is not
   * valid: the call is refused with that sentence and no card is made.
   */
  preview?: (args: any, facts: any, session: SessionRow) => Approval["preview"];
}

type ExecutionGuard = (
  name: string,
  args: JsonObject,
  memo: unknown,
  taskId: string,
  conversationId: string,
  context: Context,
) => Promise<{ facts: unknown; assert: () => void }>;

export class ToolCatalog {
  readonly #tools = new Map<string, ToolPolicy>();
  readonly #descriptions = new Map<string, string>();
  readonly #fields = new Map<string, ToolFields>();
  readonly approvalTools = new Map<string, Tool>();
  /** Installed by the central policy, used at the MCP execution boundary. */
  readonly executionGuards = new Map<string, ExecutionGuard>();
  async revalidate(
    treeId: string,
    name: string,
    args: JsonObject,
    memo: unknown,
    taskId: string,
    conversationId: string,
    context: Context = BACKGROUND_CONTEXT,
  ): ReturnType<ExecutionGuard> {
    const guard = this.executionGuards.get(treeId);
    if (!guard) throw new Error(REFUSED);
    return guard(name, args, memo, taskId, conversationId, context);
  }
  add(name: string, policy: ToolPolicy, description?: string): void {
    this.#tools.set(name, policy);
    if (description !== undefined) this.#descriptions.set(name, description);
  }
  /** The tool's description cut to its first sentence, for the allow lists of triggers. */
  describe(name: string): string {
    const text = (this.#descriptions.get(name) ?? name).replace(/\s+/g, " ").trim();
    const end = text.search(/[.!?](\s|$)/);
    const first = end >= 0 ? text.slice(0, end + 1) : text;
    return first.length > 140 ? `${first.slice(0, 139)}…` : first;
  }
  get(name: string): ToolPolicy | undefined {
    return this.#tools.get(name);
  }
  /** The tool's declared top-level fields, for argument error hints. */
  setFields(name: string, fields: ToolFields): void {
    this.#fields.set(name, fields);
  }
  fields(name: string): ToolFields | undefined {
    return this.#fields.get(name);
  }
  names(): string[] {
    return [...this.#tools.keys()];
  }
}

export const POLICY_EXTENSION = "policy";
/** The hook leaves this memo for every call it lets through; tools that act outside refuse to run without it. */
export const POLICY_MEMO = "rei:policy";

interface BoundMemo {
  version: 1;
  tool: string;
  taskId: string;
  sessionId: string;
  agentId: string;
  profile: string;
  origin: string;
  triggerId: string | null;
  binding: string;
  hash: string;
  args: string;
  via: string;
  taintBefore: TaintLabel[];
  taintAfter: TaintLabel[];
  authority?: string;
}

/** Bound hashes persist in approval rows rather than model-controlled arguments. */
export async function approvalHash(args: unknown, binding?: string, taint?: readonly TaintLabel[]): Promise<string> {
  return (
    await sha256Hex(
      canonicalJson(binding === undefined ? args : { args, binding, ...(taint ? { taint: [...taint].sort() } : {}) }),
    )
  ).slice(0, 32);
}

const STALE =
  "Refused: the tool definition or authorization changed, or its binding is missing. Nothing was executed; inspect the tool and request approval again.";

export const isInternal = (c: ActionClass): boolean => c === "read_internal" || c === "write_internal";

const REFUSED = "Refused: the approval policy did not run for this call, so it was not executed.";

/**
 * A Pi tool with its policy declaration. Registers the declaration in the catalog. A tool that is not read_internal or
 * write_internal is fail closed: its `execute` refuses unless the policy hook left its memo for this very call, so a
 * conversation that lost the policy extension gets a refusal, never a silent action. Such tools also run one after the
 * other, so a read's taint is on the session before a later send in the same round is decided.
 */
export function policyTool<P extends object>(
  catalog: ToolCatalog,
  policy: ToolPolicy,
  tool: ToolRegistration<P>,
): ToolRegistration<P> {
  catalog.add(tool.name, policy, tool.description);
  const fields = toolFields(tool.parameters);
  catalog.setFields(tool.name, fields);
  const registered = defineTool({
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        ...(tool.parameters as { properties?: Record<string, unknown> }).properties,
        // Kept short: it is repeated on every tool in every request; the full rule is the tool_activity section.
        _activity: str({ description: ACTIVITY_PARAM }),
      },
    },
    ...(!isInternal(policy.actionClass) || policy.failClosed ? { executionMode: "sequential" as const } : {}),
    execute: async (args, api, context) => {
      if (
        (!isInternal(policy.actionClass) || policy.failClosed) &&
        (await api.memo(POLICY_MEMO, context)) === undefined
      )
        return { isError: true, output: [{ type: "text", text: REFUSED }] };
      return tool.execute(executionArgs(args as JsonObject) as typeof args, api, context);
    },
  });
  if (policy.mcpPolicy) catalog.approvalTools.set(tool.name, registered);
  return registered;
}

/** Display metadata never reaches tool execution, policy decisions, argument hashes or remote connectors. */
function executionArgs(args: JsonObject): JsonObject {
  const { _activity, ...input } = args;
  return input;
}

function activityLabel(args: JsonObject): string | undefined {
  if (typeof args._activity !== "string") return undefined;
  return (
    args._activity
      .replace(/[\s\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, 120) || undefined
  );
}

export const ACTIVITY_PARAM = "Short label for the user, in their language (see tool_activity).";

export const ACTIVITY_NOTE =
  "For each tool call, provide _activity: a brief, plain-language label describing what you are doing, in the user's language. Use a few words, such as ‘Read the project settings’ or ‘Compare flight prices’. Do not include secrets or claim the action has succeeded. The app displays progress and completion status automatically.";

/** What the policy decided about one call of one tool in one session. */
export interface ToolEvaluation {
  /** The class the call was decided as (`classFor`, else the declared class). */
  actionClass: ActionClass;
  destination: string | null;
  operation: string;
  taint: TaintLabel[];
  grant: Grant | undefined;
  decision: Decision;
}

/** A trigger's run: its allow list counts like a grant, and a script's nested call that asks fails fast. */
const isTriggerSession = (session: Pick<SessionRow, "origin">): boolean => session.origin === "trigger";

/** The decision for a call: class, destination, matching grant and the policy function; the hook and redirects share it. */
export function evaluateTool(
  approvals: ApprovalStore,
  session: SessionRow,
  tool: ToolPolicy,
  args: JsonObject,
  facts?: unknown,
  grantValid: (grant: Grant) => boolean = () => true,
): ToolEvaluation {
  let destination: string | null = null;
  try {
    destination = tool.destination?.(args, facts) ?? null;
  } catch {
    destination = null;
  }
  const taint = JSON.parse(session.taint) as TaintLabel[];
  let actionClass = tool.actionClass;
  try {
    actionClass = tool.classFor?.(args, taint, facts) ?? tool.actionClass;
  } catch {
    actionClass = tool.actionClass;
  }
  const browserInput = actionClass === "send" && tool.browserInput?.(args) === true;
  const operation = browserInput ? "type" : tool.operation;
  if (tool.mcpPolicy) {
    const policy = tool.mcpPolicy(facts);
    const decision: Decision =
      actionClass === "credentials"
        ? decide({ actionClass, profile: "strict", grantMatches: false, taint })
        : policy.automatic
          ? { kind: "allow", via: "profile" }
          : { kind: "ask", lengths: ["once"], reason: "this connector's MCP profile requires approval of this call" };
    return { actionClass, destination, operation, taint, grant: undefined, decision };
  }
  const profile = canonicalProfile(session.profile);
  if (tool.approvalOnce) {
    return {
      actionClass,
      destination,
      operation,
      taint,
      grant: undefined,
      decision:
        profile === "yolo" || (profile === "standard" && tool.approvalOnce.allowStandard)
          ? { kind: "allow", via: "profile" }
          : { kind: "ask", lengths: ["once"], reason: tool.approvalOnce.reason },
    };
  }
  if (tool.pluginConfiguration) {
    return {
      actionClass,
      destination,
      operation,
      taint,
      grant: undefined,
      decision:
        profile === "yolo"
          ? { kind: "allow", via: "profile" }
          : { kind: "ask", lengths: ["once"], reason: "this changes an installed plugin" },
    };
  }
  const key = {
    connector: tool.connector,
    operation,
    destination,
    sessionId: session.id,
  };
  const web = tool.webResearch?.(args) === true;
  const found = approvals.findGrant({ ...key, agentId: session.agent_id });
  const grant =
    (found && grantValid(found) ? found : undefined) ?? (web ? approvals.findWebGrant(session.id) : undefined);
  const normal = decide({
    actionClass,
    profile,
    ...(web ? { scope: "web" } : browserInput ? { scope: "browser_site" } : {}),
    grantMatches: grant !== undefined,
    taint,
  });
  return { actionClass, destination, operation, taint, grant, decision: normal };
}

/** What an allow entry of a trigger can never cover. */
const NEVER_ALLOWED: readonly ActionClass[] = ["irreversible", "credentials", "configure"];

/** Whether the call is one a trigger's allow entries could cover (and so whether the card offers "Allow for this trigger"). */
export function allowable(actionClass: ActionClass, destination: string | null, taint: readonly TaintLabel[]): boolean {
  if (NEVER_ALLOWED.includes(actionClass)) return false;
  // A send from a run that read outside content and private data needs a fixed destination, so there is one to match.
  if (actionClass === "send" && isTainted(taint) && destination === null) return false;
  return true;
}

/** An allow entry of the trigger matches the call: the tool, and the destination when the entry names one. */
export function allowMatches(
  allow: readonly TriggerAllow[],
  tool: string,
  actionClass: ActionClass,
  destination: string | null,
  taint: readonly TaintLabel[],
  needsDestination = false,
): boolean {
  if (!allowable(actionClass, destination, taint)) return false;
  const tainted = actionClass === "send" && isTainted(taint);
  return allow.some(
    (a) =>
      a.tool === tool && (a.destination === undefined ? !tainted && !needsDestination : a.destination === destination),
  );
}

export const APPROVALS_NOTE = [
  "Some actions need the user's approval before they run.",
  "- When a tool result says it is waiting for approval, tell the user in one short sentence and end your turn. When it reports a denial, expiry, or cancellation, use any other results and respect that outcome. When a previous approval is no longer valid, inspect the current tool and request a fresh approval only if the call is still needed.",
  "- When summarizing several approval outcomes, name each action and its target or approval number. Use the result of that specific call and avoid referring to calls by position.",
  "- If a tool was interrupted and may have partially run, tell the user the outcome is uncertain. Do not repeat the action automatically.",
  "- When a message starts with [Approval #<n> approved], first make exactly the call it names, with the same arguments (for network access, run the command it names again). Then continue as the message says: carry on with your task, or if that call was the whole request, tell the user in one short sentence how it went.",
  "- If save_skill comes back as not done with a reason, correct what it names and call again.",
].join("\n");

export interface PolicyDeps {
  /** Internal executions have explicit job authority and a closed tool allowlist, independent of chat grants. */
  internalExecution?: { authorize(conversationId: string, tool: string): boolean };
  treeId: string;
  store: AppStore;
  approvals: ApprovalStore;
  catalog: ToolCatalog;
  log: Logger;
  /** How long a pending approval lives (config `approvalTtlMs`). */
  approvalTtlMs: number;
  /** Records every tool call as a trace step. */
  recorder?: StepRecorder;
  /** The allow list of a trigger: what its runs may do without asking; undefined when the trigger is gone. */
  triggerAllow?: (triggerId: string) => TriggerAllow[] | undefined;
}

export const blockedText = (n: number): string =>
  `Blocked: this needs the user's approval (#${n}). Tell the user in one short sentence and end your turn. Do not retry or work around it.`;

const safeView = (tool: ToolPolicy, args: JsonObject, facts: unknown): unknown => {
  try {
    return tool.argsView!(args, facts);
  } catch {
    return args;
  }
};

/** A call parked until a person decides: it holds no Pi invocation, and a wake runs its gates again. */
type Park = { sleep: { signals: SignalKey<unknown>[]; until?: number } };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The policy extension of one tree (it looks sessions up by this tree's conversation ids). Installed last in the
 * registry, so its hook runs after every other hook has settled the arguments it approves.
 */
export function createPolicyExtension(deps: PolicyDeps): Extension {
  const { store, approvals, catalog, log, recorder } = deps;

  // An approval records a definition-bound hash. Older/unbound approvals cannot confer MCP authority.
  const authorizationFor = async (
    binding: string | undefined,
    session: SessionRow,
    tool: ToolPolicy,
    args: JsonObject,
    facts: unknown,
  ): Promise<{ grantValid: (grant: Grant) => boolean }> => {
    if (tool.mcpPolicy || tool.approvalOnce) return { grantValid: () => false };
    if (binding === undefined) return { grantValid: () => true };
    const valid = new Set<string>();
    const candidate = evaluateTool(approvals, session, tool, args, facts);
    for (const grant of candidate.grant ? [candidate.grant] : []) {
      const row = approvals.row(grant.approvalId);
      if (!row || row.status !== "approved") continue;
      try {
        if (row.args_hash === (await approvalHash(JSON.parse(row.args_json), binding))) valid.add(grant.id);
      } catch {
        /* malformed persisted approvals never authorize */
      }
    }
    return { grantValid: (grant) => valid.has(grant.id) };
  };

  const planRead = async (
    call: ToolCall,
    session: SessionRow,
    run: { id: string; assigned_by: string | null },
  ): Promise<(ApprovalDraft & { callId: string }) | undefined> => {
    const tool = catalog.get(call.name);
    const schema = catalog.approvalTools.get(call.name);
    if (!tool?.mcpPolicy || !schema) return;
    try {
      const args = executionArgs(validateToolArguments(schema, call) as JsonObject);
      const facts = await tool.inspect?.(args, session, BACKGROUND_CONTEXT);
      const binding = tool.binding?.(facts);
      if (!binding) return;
      const { actionClass, destination, decision, taint } = evaluateTool(approvals, session, tool, args, facts);
      if (actionClass !== "read_external" || decision.kind !== "ask") return;
      const argsHash = await approvalHash(args, binding, taint);
      const preview = tool.preview?.(args, facts, session);
      return {
        session,
        runId: run.id,
        assignedBy: run.assigned_by,
        callId: call.id,
        tool: call.name,
        args,
        argsHash,
        connector: tool.connector,
        operation: tool.operation,
        actionClass,
        destination,
        summary: clip(tool.summary(args, facts, session), 300),
        argsPreview: argsPreview(tool.argsView ? safeView(tool, args, facts) : args),
        taint,
        lengths: ["once"],
        ttlMs: deps.approvalTtlMs,
        ...(preview ? { preview } : {}),
      };
    } catch {
      return undefined;
    }
  };

  /**
   * Parks the call while any approval under `key` (the approval ID, or the group ID for grouped reads) is pending, and
   * returns undefined once none is. SQLite holds the decision; the wake only says to look again. Pi runs every gate
   * again on each wake, registry publication and open, so this reads the same rows and gives the same answer each time.
   */
  const park = async (
    key: string,
    rows: () => ApprovalRow[],
    api: HookApi,
    context: Context,
  ): Promise<Park | undefined> => {
    const wake = await api.readSignal(ApprovalWake, key, context);
    const pending = rows().filter((row) => row.status === "pending");
    if (!pending.length) return undefined;
    if (wake !== undefined) {
      // The deadline came before a decision. (A delivered wake always follows a decision, so none finds a row pending.)
      if (!("expired" in wake)) log.warn("approval.woke_pending", { treeId: deps.treeId });
      for (const a of approvals.expirePending(pending.map((row) => row.id)))
        log.info("approval.expired", { approvalId: a.id, sessionId: a.sessionId });
      return undefined;
    }
    // Fixed at the first pass. Pi's clock and the app's may differ, so the remaining time carries over, not the instant.
    const remaining = Math.max(0, Math.min(...pending.map((row) => row.expires_at)) - store.clock.now());
    const until = await api.memo<number>(`rei.approval.until.${key}`, api.now() + remaining, context);
    return { sleep: { signals: [ApprovalWake.key(key)], until } };
  };

  const checkpoint = async (
    call: { id: string },
    session: SessionRow,
    run: { id: string; assigned_by: string | null },
    api: HookApi,
    context: Context,
    groupReads: boolean,
    onWait: (row: ApprovalRow) => void,
  ): Promise<ApprovalRow | Park | undefined> => {
    const saved = approvals.forTask(session.id, String(api.taskId));
    if (saved) {
      const current = () => {
        const row = approvals.row(saved.id);
        if (!row) throw new Error("This approval is no longer available.");
        return row;
      };
      const parked = await park(saved.id, () => [current()], api, context);
      if (parked) onWait(saved);
      return parked ?? current();
    }

    if (!groupReads) return;
    const round = await approvalRound(call.id, api, context);
    if (!round || round.calls.length === 1) return;
    const id = `${run.id}:${round.entryId}`;
    let rows = approvals.group(id);
    if (!rows.length) {
      const plans = await Promise.all(round.calls.map((call) => planRead(call, session, run)));
      if (!plans.every((plan) => plan !== undefined)) return;
      context.abortSignal?.throwIfAborted();
      rows = approvals.createGroup(id, plans);
    }
    const row = rows.find((row) => row.tool_call_id === call.id);
    if (!row) return;
    await api.memo(APPROVAL_CHECKPOINT_MEMO, row.id, context);
    const parked = await park(id, () => approvals.group(id), api, context);
    if (parked) onWait(row);
    return parked ?? approvals.row(row.id);
  };

  const revalidate: ExecutionGuard = async (name, args, memo, taskId, conversationId, context) => {
    const tool = catalog.get(name);
    const saved = memo as BoundMemo | undefined;
    const session = store.sessionByConversation(deps.treeId, conversationId);
    if (
      !tool?.binding ||
      !session ||
      !saved ||
      saved.version !== 1 ||
      saved.tool !== name ||
      saved.taskId !== taskId ||
      saved.args !== canonicalJson(args)
    )
      throw new Error(STALE);
    const facts = await tool.inspect?.(args, session, context, "execute");
    const once = saved.via.startsWith("once:") ? approvals.row(saved.via.slice(5)) : undefined;
    // The one-time grant binds the approval's labels. Dispatch still checks the live labels below.
    const hashTaint = once ? (JSON.parse(once.taint) as TaintLabel[]) : saved.taintBefore;
    if (
      !saved.binding ||
      tool.binding(facts) !== saved.binding ||
      saved.hash !== (await approvalHash(args, saved.binding, tool.mcpPolicy ? hashTaint : undefined))
    )
      throw new Error(STALE);
    if (saved.authority !== tool.mcpPolicy?.(facts).authority) throw new Error(STALE);
    const authority = await authorizationFor(saved.binding, session, tool, args, facts);
    // Synchronous and repeatable: run again after token acquisition, immediately before gateway fetch.
    const assert = () => {
      if (saved.authority !== tool.mcpPolicy?.(facts).authority) throw new Error(STALE);
      const current = store.sessionByConversation(deps.treeId, conversationId);
      if (
        !current ||
        current.id !== saved.sessionId ||
        current.agent_id !== saved.agentId ||
        current.profile !== saved.profile ||
        current.origin !== saved.origin ||
        current.trigger_id !== saved.triggerId ||
        canonicalJson(JSON.parse(current.taint)) !== canonicalJson(saved.taintAfter)
      )
        throw new Error(STALE);
      const evaluation = evaluateTool(
        approvals,
        { ...current, taint: JSON.stringify(saved.taintBefore) },
        tool,
        args,
        facts,
        authority.grantValid,
      );
      if (saved.via === "profile") {
        if (evaluation.decision.kind !== "allow" || evaluation.decision.via !== "profile") throw new Error(STALE);
      } else if (saved.via.startsWith("grant:")) {
        if (
          evaluation.decision.kind !== "allow" ||
          evaluation.decision.via !== "grant" ||
          saved.via !== `grant:${evaluation.grant?.id}`
        )
          throw new Error(STALE);
      } else if (saved.via.startsWith("trigger:")) {
        const list = current.trigger_id ? deps.triggerAllow?.(current.trigger_id) : undefined;
        if (
          tool.mcpPolicy ||
          tool.approvalOnce ||
          saved.via !== `trigger:${current.trigger_id}` ||
          !list ||
          !allowMatches(
            list,
            name,
            evaluation.actionClass,
            evaluation.destination,
            saved.taintBefore,
            tool.allowNeedsDestination === true,
          )
        )
          throw new Error(STALE);
      } else if (saved.via.startsWith("once:")) {
        const row = approvals.row(saved.via.slice(5));
        if (
          !row ||
          row.status !== "approved" ||
          row.grant_length !== "once" ||
          row.session_id !== current.id ||
          row.tool !== name ||
          row.args_hash !== saved.hash ||
          row.consumed_by !== taskId ||
          row.once_expires_at === null ||
          row.once_expires_at <= store.clock.now()
        )
          throw new Error(STALE);
      } else throw new Error(STALE);
    };
    assert();
    return { facts, assert };
  };
  catalog.executionGuards.set(deps.treeId, revalidate);

  /** Trace recording never gets in the way of a tool call: a failure is logged and the call goes on. */
  const trace = (what: string, fn: () => void): void => {
    if (!recorder) return;
    try {
      fn();
    } catch (error) {
      log.error("trace.tool_step_failed", { what, error: error instanceof Error ? error.name : "error" });
    }
  };
  const traceAsync = async (what: string, fn: () => Promise<void>): Promise<void> => {
    if (!recorder) return;
    try {
      await fn();
    } catch (error) {
      log.error("trace.tool_step_failed", { what, error: error instanceof Error ? error.name : "error" });
    }
  };

  return defineExtension({
    name: POLICY_EXTENSION,
    sections: [section("approvals", () => APPROVALS_NOTE), section("tool_activity", () => ACTIVITY_NOTE)],
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          if (deps.internalExecution)
            return deps.internalExecution.authorize(String(api.conversationId), call.name)
              ? undefined
              : { block: "Blocked: internal execution lacks authority for this tool." };
          const rawArgs = call.arguments as JsonObject;
          const args = executionArgs(rawArgs);
          const policyName = call.name;
          const policyArgs = args;
          const tool = catalog.get(policyName);
          const session = store.sessionByConversation(deps.treeId, String(api.conversationId));
          const oneLine = (facts?: unknown): string | null => {
            if (!tool) return null;
            try {
              return clip(tool.summary(policyArgs, facts, session), 300);
            } catch {
              return call.name;
            }
          };
          // The step is recorded before the decision (status running), then the decision is added to it.
          let step: string | undefined;
          trace("begin", () => {
            if (!session) return;
            step = recorder!.beginTool({
              sessionId: session.id,
              runId: store.runningRun(session.id)?.id,
              toolCallId: call.id,
              toolName: policyName,
              actionClass: tool?.actionClass ?? null,
              summary: oneLine(),
              activity: activityLabel(rawArgs),
              input: policyArgs,
              parentToolCallId: call.parent?.callId,
            });
          });
          const blocked = async (
            text: string,
            decision: StepDecision,
            class_: ActionClass,
            summary: string | null,
            approvalId?: string,
          ) => {
            trace("decide", () => {
              if (step)
                recorder!.decideTool(step, {
                  decision,
                  ...(approvalId ? { approvalId } : {}),
                  actionClass: class_,
                  summary,
                });
            });
            await traceAsync("finish", async () => {
              if (step)
                await recorder!.finishTool(step, {
                  status: "blocked",
                  isError: true,
                  output: [{ type: "text", text }],
                });
            });
            return { block: text };
          };

          const parkOn = session ? tool?.parkOn?.(session, String(api.taskId)) : undefined;
          if (parkOn) return { sleep: { signals: parkOn } };
          // A hook that runs again after a crash finds what it already decided to let through.
          const saved = await api.memo(POLICY_MEMO, context);
          if (saved !== undefined) {
            if (!tool?.binding) return undefined;
            try {
              await revalidate(call.name, args, saved, String(api.taskId), String(api.conversationId), context);
              return undefined;
            } catch {
              return blocked(STALE, "deny", tool.actionClass, oneLine());
            }
          }
          if (!tool) {
            log.warn("policy.undeclared_tool", { treeId: deps.treeId });
            const text = `Blocked: ${policyName} has no policy declaration, so it cannot run.`;
            await traceAsync("finish", async () => {
              if (step)
                await recorder!.finishTool(step, {
                  status: "blocked",
                  isError: true,
                  output: [{ type: "text", text }],
                });
            });
            return { block: text };
          }
          if (!session) return { block: "Blocked: this session is no longer available." };
          const running = store.runningRun(session.id);
          const retryRequest = running?.request_id.startsWith("approval:") ? running.request_id.slice(9) : undefined;
          const retryApproval = retryRequest ? approvals.row(retryRequest) : undefined;
          // Keep the binding for the retried task, including recovery. Later tasks need their own policy decisions.
          const retryId =
            retryApproval?.consumed_by && retryApproval.consumed_by !== String(api.taskId) ? undefined : retryRequest;
          // A script's nested call (`call.parent`) that needs approval parks on the single-task path like a direct call,
          // and its script waits on the promise, up to the script's deadline. Grouped reads stay direct-only: they read
          // the assistant entry, which holds no nested calls. A nested ask in a trigger session blocks at once with the
          // approval number and no checkpoint, so the script fails fast.
          const nestedBlocksAtOnce = call.parent !== undefined && isTriggerSession(session);
          const canCheckpoint = running !== undefined && retryId === undefined && !nestedBlocksAtOnce;
          const checkpointState = canCheckpoint
            ? await checkpoint(call, session, running, api, context, Boolean(tool.mcpPolicy) && !call.parent, (row) =>
                trace("decide", () => {
                  if (step)
                    recorder!.decideTool(step, {
                      decision: "ask",
                      approvalId: row.id,
                      actionClass: row.action_class as ActionClass,
                      summary: row.summary,
                    });
                }),
              )
            : undefined;
          if (checkpointState && "sleep" in checkpointState) return checkpointState;
          const authorize = async (checkpointed?: ApprovalRow): Promise<{ block: string } | Park | undefined> => {
            const current = store.getSessionRow(session.id);
            if (!current) return { block: "Blocked: this session is no longer available." };
            if (checkpointed && checkpointed.status !== "approved")
              return blocked(
                `Approval #${checkpointed.seq} was ${checkpointed.status}. This call did not run. Respect the decision and use any other results from this round.`,
                "deny",
                tool.actionClass,
                oneLine(),
                checkpointed.id,
              );
            let facts: unknown;
            try {
              facts = tool.inspect ? await tool.inspect(policyArgs, current, context) : undefined;
            } catch {
              facts = undefined; // the policy functions decide an unknown conservatively
            }
            const binding = tool.binding?.(facts);
            if (tool.binding && !binding)
              return blocked(
                tool.inspectionError?.(facts) ?? STALE,
                "deny",
                tool.actionClass,
                oneLine(facts),
                checkpointed?.id,
              );
            const resumeId = checkpointed?.id ?? (binding ? retryId : undefined);
            const approved = checkpointed ?? (resumeId ? retryApproval : undefined);
            // A configure card is computed before anything else; an invalid draft is refused here, with no card.
            let preview: Approval["preview"];
            if (tool.preview) {
              try {
                preview = tool.preview(policyArgs, facts, current);
              } catch (error) {
                if (!(error instanceof Invalid)) throw error;
                return blocked(
                  `Not done: ${error.message} Nothing was changed. Correct the call and try again.`,
                  "deny",
                  tool.actionClass,
                  oneLine(facts),
                );
              }
            }
            const authority = await authorizationFor(binding, current, tool, policyArgs, facts);
            const evaluated = evaluateTool(approvals, current, tool, policyArgs, facts, authority.grantValid);
            const { actionClass, destination, operation, taint, grant } = evaluated;
            const readTaint = (): readonly TaintLabel[] =>
              typeof tool.taint === "function" ? tool.taint(policyArgs, facts) : (tool.taint ?? ["external"]);
            let hashTaint = tool.mcpPolicy ? taint : undefined;
            // A read can make a sibling approval look stale by adding labels the sibling read would also add.
            // In that case validate the exact approved arguments and binding against the original labels.
            if (
              tool.mcpPolicy &&
              !checkpointed?.tool_task_id &&
              actionClass === "read_external" &&
              approved?.action_class === "read_external"
            ) {
              const recorded = JSON.parse(approved.taint) as TaintLabel[];
              const addedByRead = readTaint();
              if (
                recorded.every((label) => taint.includes(label)) &&
                taint.every((label) => recorded.includes(label) || addedByRead.includes(label))
              )
                hashTaint = recorded;
            }
            const hash = await approvalHash(args, binding, hashTaint);
            if (
              resumeId &&
              (approved?.status !== "approved" ||
                approved.tool !== call.name ||
                approved.args_hash !== hash ||
                ((tool.mcpPolicy || tool.approvalOnce) && approved.grant_length !== "once") ||
                (checkpointed && (approved.action_class !== actionClass || approved.destination !== destination)))
            ) {
              if (checkpointed) approvals.executionFinished(checkpointed.id, "needs_approval");
              return blocked(STALE, "deny", actionClass, oneLine(facts), checkpointed?.id);
            }

            let decision = evaluated.decision;
            // A trigger's run: its allow list counts like a grant (it is what the user approved for this trigger).
            const triggerId = current.origin === "trigger" ? current.trigger_id : null;
            let allowed = false;
            const mcpPolicy = tool.mcpPolicy?.(facts);
            const triggerMayAuthorize = !mcpPolicy && !tool.approvalOnce;
            if (decision.kind === "ask" && triggerId && triggerMayAuthorize) {
              const list = deps.triggerAllow?.(triggerId);
              if (
                list &&
                allowMatches(list, policyName, actionClass, destination, taint, tool.allowNeedsDestination === true)
              ) {
                allowed = true;
                decision = { kind: "allow", via: "grant" };
              }
            }
            const logFields = { sessionId: session.id, tool: call.name, actionClass, profile: session.profile };
            const summaryLine = oneLine(facts);

            const letThrough = async (via: string) => {
              if (
                tool.mcpPolicy &&
                canonicalJson(JSON.parse(store.getSessionRow(session.id)?.taint ?? "null")) !== canonicalJson(taint)
              )
                return blocked(STALE, "deny", actionClass, summaryLine);
              // A read of outside content taints the session before the content can reach the model.
              if (tool.actionClass === "read_external") store.addTaint(session.id, readTaint());
              if (binding) {
                const memo: BoundMemo = {
                  version: 1,
                  tool: call.name,
                  taskId: String(api.taskId),
                  sessionId: session.id,
                  agentId: current.agent_id,
                  profile: current.profile,
                  origin: current.origin,
                  triggerId: current.trigger_id,
                  binding,
                  hash,
                  args: canonicalJson(args),
                  via,
                  taintBefore: taint,
                  taintAfter: JSON.parse(store.getSessionRow(session.id)!.taint) as TaintLabel[],
                  ...(mcpPolicy ? { authority: mcpPolicy.authority } : {}),
                };
                await api.memo(POLICY_MEMO, { ...memo }, context);
              } else await api.memo(POLICY_MEMO, via, context);
              trace("decide", () => {
                if (step)
                  recorder!.decideTool(step, {
                    decision: via.startsWith("profile") ? "allow" : "granted",
                    actionClass,
                    ...(checkpointed ? { approvalId: checkpointed.id } : {}),
                    summary: summaryLine,
                  });
              });
              log.debug("policy.allowed", { ...logFields, via });
              return undefined;
            };

            if (decision.kind === "deny") {
              log.info("policy.denied", logFields);
              return blocked(`Blocked: ${decision.reason}`, "deny", actionClass, summaryLine, checkpointed?.id);
            }
            // Consume the exact resumed one-call token; a different approval cannot substitute for it.
            if (approved?.grant_length === "once") {
              const resumed = approvals.consumeOnce(session.id, call.name, hash, String(api.taskId), true, approved.id);
              if (!resumed) {
                if (checkpointed) approvals.executionFinished(checkpointed.id, "needs_approval");
                return blocked(STALE, "deny", actionClass, summaryLine, checkpointed?.id);
              }
              return letThrough(`once:${resumed.id}`);
            }
            if (decision.kind === "allow")
              return letThrough(
                allowed ? `trigger:${triggerId}` : decision.via === "grant" ? `grant:${grant?.id ?? ""}` : "profile",
              );
            if (checkpointed) {
              approvals.executionFinished(checkpointed.id, "needs_approval");
              return blocked(STALE, "deny", actionClass, summaryLine, checkpointed.id);
            }
            // ask: a one-time grant for exactly this call lets it through once (idempotent per task); else block.
            const once = approvals.consumeOnce(session.id, call.name, hash, String(api.taskId), binding !== undefined);
            if (once) {
              log.info("policy.one_time_grant_used", { ...logFields, approvalId: once.id });
              return letThrough(`once:${once.id}`);
            }
            const summary = summaryLine ?? call.name;
            context.abortSignal?.throwIfAborted();
            const made = approvals.findOrCreate({
              session,
              runId: running?.id ?? null,
              assignedBy: running?.assigned_by ?? null,
              tool: call.name,
              args,
              argsHash: hash,
              connector: tool.connector,
              operation,
              actionClass,
              destination,
              summary,
              argsPreview: argsPreview(tool.argsView ? safeView(tool, policyArgs, facts) : policyArgs),
              taint,
              lengths: [
                ...(decision.lengths as GrantLength[]),
                ...(triggerId && triggerMayAuthorize && allowable(actionClass, destination, taint)
                  ? (["trigger"] as const)
                  : []),
              ],
              ...(preview ? { preview } : {}),
              ttlMs: deps.approvalTtlMs,
              ...(canCheckpoint
                ? { taskId: String(api.taskId), ...(call.parent ? { parentCallId: call.parent.callId } : {}) }
                : {}),
            });
            log.info(made.created ? "approval.created" : "approval.reused", {
              ...logFields,
              approvalId: made.approval.id,
              number: made.number,
            });
            if (made.approval.resumesTool) {
              trace("decide", () => {
                if (step)
                  recorder!.decideTool(step, { decision: "ask", approvalId: made.approval.id, actionClass, summary });
              });
              const id = made.approval.id;
              const current = () => {
                const row = approvals.row(id);
                if (!row) throw new Error("This approval is no longer available.");
                return row;
              };
              return (await park(id, () => [current()], api, context)) ?? authorize(current());
            }
            return blocked(blockedText(made.number), "ask", actionClass, summary, made.approval.id);
          };
          return authorize(checkpointState);
        },
        // Every result the tool task writes: an executed call's ends its step as ok or error; one the Harness wrote itself
        // (not executed) ends it as not_executed with Pi's diagnostic code. A block keeps the step the hook ended. Steps
        // are keyed by the tool call, so a hook that runs again after a crash rewrites the same row.
        afterTool: async (call, harnessResult, api, context) => {
          const result = withConciseArgumentErrors(harnessResult, catalog.fields(call.name));
          const session = store.sessionByConversation(deps.treeId, String(api.conversationId));
          const code = harnessCode(result.diagnostics);
          if (session) {
            const approvalId =
              approvals.forTask(session.id, String(api.taskId))?.id ??
              (catalog.get(call.name)?.mcpPolicy
                ? await api.memo<string>(APPROVAL_CHECKPOINT_MEMO, context)
                : undefined);
            if (approvalId) {
              const outcome = code === "interrupted" ? "interrupted" : result.isError ? "failed" : "ran";
              approvals.executionFinished(approvalId, outcome);
              // A parked call can end without its gates deciding: a registry change that removed its tool ends it
              // `tool_unavailable`; a script's nested call is aborted with its script (deadline or Stop). Nothing is
              // left to approve, and the card of a script's call says why.
              const reason = call.parent && code === "aborted" ? "script_ended" : undefined;
              if (code !== undefined && approvals.cancelPending(approvalId, reason))
                log.info("approval.cancelled", { approvalId, sessionId: session.id, ...(reason ? { reason } : {}) });
            }
          }
          await traceAsync("finish", async () => {
            if (!session) return;
            if (code === "blocked") return;
            let step = store.db.get<{ id: string }>(
              "SELECT id FROM steps WHERE session_id = ? AND tool_call_id = ? AND type = 'tool.call'",
              session.id,
              call.id,
            )?.id;
            if (!step && code === undefined) return;
            step ??= recorder!.beginTool({
              sessionId: session.id,
              runId: store.runningRun(session.id)?.id,
              toolCallId: call.id,
              toolName: call.name,
              actionClass: catalog.get(call.name)?.actionClass ?? null,
              summary: null,
              activity: activityLabel(call.arguments as JsonObject),
              input: executionArgs(call.arguments as JsonObject),
              parentToolCallId: call.parent?.callId,
            });
            await recorder!.finishTool(step, {
              status: code === undefined ? (result.isError ? "error" : "ok") : "not_executed",
              isError: result.isError === true,
              output: result.output ?? [],
              ...(code !== undefined ? { errorCode: code } : {}),
              ...(code === undefined && result.details !== undefined ? stepDetails(call.name, result.details) : {}),
            });
          });
          return result === harnessResult ? undefined : result;
        },
      }),
    ],
  });
}

/**
 * The result details a tool's step keeps for the Trace: a search's query, candidates and loads; a fetch's page facts; a
 * script's calls (name, arguments, status, duration, error), so Inspect lists them after the nested steps are paged away.
 * The script's temp-file path for a cut output stays out: it is a host path.
 */
function stepDetails(toolName: string, details: unknown): { details?: unknown } {
  if (toolName === "search_capabilities" || toolName === "web_fetch") return { details };
  if (toolName === "codemode" && typeof details === "object" && details !== null) {
    const calls = (details as { calls?: unknown }).calls;
    if (Array.isArray(calls)) return { details: { calls } };
  }
  return {};
}

/**
 * The Harness's invalid_arguments diagnostics without pi-ai's echo of the whole argument JSON, plus a hint naming the
 * tool's fields when one is missing or unknown. Any other result is returned as it is.
 */
export function withConciseArgumentErrors<R extends { diagnostics?: readonly { code?: string; message?: string }[] }>(
  result: R,
  fields: ToolFields | undefined,
): R {
  const diagnostics = result.diagnostics;
  if (!diagnostics?.some((d) => d.code === "invalid_arguments" && typeof d.message === "string")) return result;
  return {
    ...result,
    diagnostics: diagnostics.map((d) =>
      d.code === "invalid_arguments" && typeof d.message === "string"
        ? { ...d, message: conciseArgumentError(d.message, fields) }
        : d,
    ),
  };
}

/** Diagnostic codes of the results the Harness writes itself, without running the tool. */
export const NOT_EXECUTED_CODES = new Set([
  "blocked",
  "tool_unavailable",
  "invalid_arguments",
  "interrupted",
  "restart_limit",
  "aborted",
  "abandoned",
]);

/** The Harness's code when it wrote this result itself (the call did not execute); undefined for an executed call. */
export function harnessCode(diagnostics: readonly { code?: string }[] | undefined): string | undefined {
  return diagnostics?.find((d) => d.code !== undefined && NOT_EXECUTED_CODES.has(d.code))?.code;
}
