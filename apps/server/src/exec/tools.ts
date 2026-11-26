// The sandbox tools: Pi Durable's read, write, edit and bash, running in the exec backend, each declared in the
// tool catalog like every other tool. bash adds the proxy variables (carrying the run's token), a timeout and an outer
// deadline, and tells the model about network access it was refused.

import type { Extension, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import type { SandboxNetworkMode } from "@rei/protocol";
import { MODEL_AND_SCRIPTS } from "../pi/callers.ts";
import { policyTool, type ToolCatalog, type ToolPolicy } from "../pi/policy-ext.ts";
import type { AppStore, RunRow } from "../store/store.ts";
import type { ExecBackend } from "./backend.ts";
import { blockNote, type EgressService } from "./egress.ts";

export const SANDBOX_CONNECTOR = "sandbox";
export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TIMEOUT_S = 600;
/** The outer deadline is the command's own timeout plus this, for the connection to answer at all. */
export const DEADLINE_MARGIN_S = 15;

export const DEADLINE_TEXT = "The sandbox did not answer in time; the command may or may not have run.";
export const LOST_TEXT =
  "The connection to the sandbox broke; the command may or may not have run. Check before running it again.";

type ToolText = { output: { type: "text"; text: string }[]; isError?: true };
const fail = (text: string): ToolText => ({ isError: true, output: [{ type: "text", text }] });

export interface ExecToolsDeps {
  treeId: string;
  store: AppStore;
  backend: Pick<ExecBackend, "cwd" | "ready" | "reset">;
  egress: EgressService;
  catalog: ToolCatalog;
  /** `host:port` of the egress proxy as the sandbox reaches it; unset: no proxy variables, so no network. */
  proxy?: string | undefined;
  /** Test hook: the outer deadline margin. */
  deadlineMarginS?: number;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The command's timeout in seconds: the default when none is given, at most the cap; anything invalid goes on to Pi to refuse. */
export function effectiveTimeout(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return DEFAULT_TIMEOUT_S;
  return Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, MAX_TIMEOUT_S) : timeout;
}

const BASH_PARAMETERS = obj({
  command: str({ description: "Bash command to execute" }),
  timeout: opt(num({ description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_S}, at most ${MAX_TIMEOUT_S})` })),
});

/** What the agent is told about its network, by its sandbox network mode (see SandboxNetworkMode). */
const NETWORK_NOTE: Record<SandboxNetworkMode, string> = {
  block: "Sandbox programs cannot access the network in Block mode.",
  whitelist:
    "Sandbox programs can reach only whitelisted sites through the proxy configured in bash, on ports 80 and 443. A local-network hostname requires both a name entry and an address entry.",
  any: "Sandbox programs can reach any site on ports 80 and 443 through the proxy configured in bash, including your local network, without approval.",
};

export function sandboxNote(cwd: string, mode: SandboxNetworkMode = "block"): string {
  return [
    "You have a sandbox: a Linux machine with bash, python3, git, curl, jq, ripgrep, uv and npm, used through the read, write, edit and bash tools.",
    `Your working directory is ${cwd}. It is this agent's workspace: every chat and worker of this agent reads and writes the same files, so a file may have changed since you last looked. Read it again before you edit it, and don't overwrite or delete files you didn't create. The workspace is kept when a chat is deleted and removed only when the agent is deleted. Everything else in the sandbox is read-only, except small temporary areas (such as /tmp) that are cleared when the sandbox restarts, so keep anything you need in the workspace.`,
    "You may install Python packages with uv and Node.js packages with npm. Install them into the workspace (for example a uv virtual environment or a project's node_modules), because nothing can be installed system-wide.",
    `${NETWORK_NOTE[mode]} When a command is refused for that reason, tell the user and end your turn.`,
    `A bash command stops after ${DEFAULT_TIMEOUT_S} seconds unless you pass a timeout (at most ${MAX_TIMEOUT_S} seconds); each command is its own shell, so nothing but files carries over between commands.`,
  ].join("\n");
}

export function createExecExtension(deps: ExecToolsDeps): Extension {
  const { treeId, store, backend, egress, catalog } = deps;
  const margin = deps.deadlineMarginS ?? DEADLINE_MARGIN_S;
  const internal = (
    actionClass: "read_internal" | "write_internal",
    operation: string,
    summary: ToolPolicy["summary"],
  ): ToolPolicy => ({ actionClass, connector: SANDBOX_CONNECTOR, operation, summary });
  const runningRun = (conversationId: unknown): RunRow | undefined => {
    const session = store.sessionByConversation(treeId, String(conversationId));
    return session ? store.runningRun(session.id) : undefined;
  };

  /** Before every call: the sandbox answers and the workspace exists; otherwise an ordinary tool error for the model. */
  const ready = async (conversationId?: unknown): Promise<ToolText | undefined> => {
    try {
      const caller =
        conversationId !== undefined ? store.sessionByConversation(treeId, String(conversationId)) : undefined;
      if (caller && store.agentCapabilities?.(caller.agent_id)?.sandbox === false)
        return fail("Sandbox access is disabled for this agent.");
      await backend.ready(treeId);
      // A sandbox read/bash can see another session's files. Carry its labels before returning data or issuing egress.
      const owner = store.db.get<{ agent_id: string }>(
        "SELECT agent_id FROM sessions WHERE tree_id = ? LIMIT 1",
        treeId,
      );
      if (owner) {
        if (!caller && store.agentCapabilities?.(owner.agent_id)?.sandbox === false)
          return fail("Sandbox access is disabled for this agent.");
        const labels = store.db
          .all<{ taint: string }>("SELECT taint FROM sessions WHERE agent_id = ?", owner.agent_id)
          .flatMap((r) => JSON.parse(r.taint));
        for (const session of store.treeSessions(treeId)) store.addTaint(session.id, labels);
      }
      return undefined;
    } catch (error) {
      return fail(error instanceof Error && error.message ? error.message : "The sandbox is not available right now.");
    }
  };
  const guarded = <P extends object>(tool: ToolRegistration<P>): ToolRegistration<P> => ({
    ...tool,
    execute: async (args, api, context) => (await ready(api.conversationId)) ?? tool.execute(args, api, context),
  });

  const read = policyTool(
    catalog,
    internal("read_internal", "read", (a: { path: string }) => `Read ${a.path}`),
    guarded({ ...(createReadTool() as ToolRegistration), replay: "safe", callers: MODEL_AND_SCRIPTS }),
  );
  const write = policyTool(
    catalog,
    internal("write_internal", "write", (a: { path: string }) => `Write ${a.path}`),
    guarded({ ...(createWriteTool() as ToolRegistration), callers: MODEL_AND_SCRIPTS }),
  );
  const edit = policyTool(
    catalog,
    internal("write_internal", "edit", (a: { path: string }) => `Edit ${a.path}`),
    guarded({ ...(createEditTool() as ToolRegistration), callers: MODEL_AND_SCRIPTS }),
  );

  const bashTool = createBashTool({
    prepare: async (execution, api) => {
      execution.env.GIT_TERMINAL_PROMPT = "0";
      const run = runningRun(api.conversationId);
      if (!deps.proxy || !run) return;
      const url = `http://run:${await egress.issue(run.id)}@${deps.proxy}`;
      for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) execution.env[name] = url;
      execution.env.NO_PROXY = "localhost,127.0.0.1";
      execution.env.no_proxy = "localhost,127.0.0.1";
      // Node 24's built-in fetch reads the proxy variables only when told to (npm and uv already do).
      execution.env.NODE_USE_ENV_PROXY = "1";
    },
  });
  const bash = policyTool(
    catalog,
    internal("write_internal", "bash", (a: { command: string }) => `Run: ${clip(a.command, 200)}`),
    {
      ...bashTool,
      callers: MODEL_AND_SCRIPTS,
      description: `Execute a bash command in the sandbox, in your working directory. Returns combined stdout and stderr (the last 2000 lines or 50KB; the rest is saved to a file). The command stops after ${DEFAULT_TIMEOUT_S} seconds unless you pass a timeout in seconds (at most ${MAX_TIMEOUT_S}).`,
      parameters: BASH_PARAMETERS,
      // Run commands sequentially so each command reports its own network denials.
      executionMode: "sequential",
      execute: async (args, api, context) => {
        const unavailable = await ready(api.conversationId);
        if (unavailable) return unavailable;
        const run = runningRun(api.conversationId);
        const timeout = effectiveTimeout(args.timeout);
        const mark = run ? egress.mark(run.id) : 0;
        const noteBlocks = () => {
          if (!run) return;
          const notes = egress.blocksSince(run.id, mark).map(blockNote);
          if (notes.length === 0) return;
          const had = api.retainedOutput().text;
          api.output(`${had === "" || had.endsWith("\n") ? "" : "\n"}${notes.join("\n")}\n`);
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const inner = bashTool.execute({ ...args, ...(timeout !== undefined ? { timeout } : {}) }, api, context).then(
            // Pi's built-in bash never parks, and this wrapper must not: it only passes the result through.
            (value) => ({ kind: "done" as const, value: value as ToolExecutionResult }),
            (error: unknown) => ({ kind: "error" as const, error }),
          );
          const deadline = new Promise<{ kind: "deadline" }>((resolve) => {
            timer = setTimeout(
              () => resolve({ kind: "deadline" }),
              ((timeout !== undefined && Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT_S) + margin) * 1000,
            );
          });
          const outcome = await Promise.race([inner, deadline]);
          if (outcome.kind === "done") {
            noteBlocks();
            return outcome.value;
          }
          noteBlocks();
          if (outcome.kind === "deadline") {
            // The call is stuck on a connection that does not answer: drop it (that ends the command's ssh session) and report.
            backend.reset();
            throw new Error(DEADLINE_TEXT);
          }
          const message = outcome.error instanceof Error ? outcome.error.message : "";
          if (/pi-env connection (lost|timed out)/.test(message)) throw new Error(LOST_TEXT);
          throw outcome.error;
        } finally {
          clearTimeout(timer);
        }
      },
    },
  );

  return defineExtension({
    name: "sandbox",
    namespace: { name: "sandbox", description: "Files and shell commands in your sandbox." },
    tools: [read, write, edit, bash],
    sections: [section("sandbox", () => sandboxNote(backend.cwd(treeId), store.networkModeOfTree(treeId)))],
  });
}
