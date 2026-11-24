// Code mode: the agent writes a short JavaScript program that calls its tools in a QuickJS sandbox, so multi-step work
// takes fewer model turns. Pi ships the engine (`pi-durable/codemode`, `pi-codemode`); this module wires it in: one
// sandbox per server process with Rei's limits, and the `codemode` tool's policy entry. The setting that turns it on is
// Settings > Runtime > Tools (`codeMode.enabled`); with it off, nothing here touches a tree.

import {
  type CodemodeRun,
  type CodemodeRunOptions,
  CodemodeSandbox,
  type CodemodeSandboxOptions,
} from "@earendil-works/pi-codemode";
import type { Agent, Extension, PromptSection, ToolRegistration } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import type { Logger } from "../util/log.ts";
import { policyTool, type ToolCatalog, type ToolPolicy } from "./policy-ext.ts";

export const CODEMODE_TOOL = "codemode";

/** What one server process allows scripts: the overall deadline (tool waits included), the VM heap, and scripts at once. */
export interface CodemodeLimits {
  timeoutMs: number;
  memoryLimitBytes: number;
  maxWorkers: number;
  /** Tokens the `codemode` section may spend on tool declarations; the eval sweeps it (REI_CODEMODE_INLINE_BUDGET). */
  inlineBudget?: number;
}

export const DEFAULT_CODEMODE_LIMITS: CodemodeLimits = {
  timeoutMs: 10 * 60_000,
  memoryLimitBytes: 128 * 1024 * 1024,
  maxWorkers: 4,
};

/** Estimated tokens the `codemode` prompt section may spend on tool declarations (the eval tunes it). */
export const CODEMODE_INLINE_BUDGET = 1500;

/** What a script over the concurrency limit fails with, at once. */
export const TOO_MANY_SCRIPTS = "Too many scripts are running; try again shortly.";

const SUMMARY_CHARS = 80;

/** The first line of the script that is code (not the `// @options` line), cut for the Trace and approval summaries. */
export function codemodeSummary(args: { code?: unknown }): string {
  const code = typeof args.code === "string" ? args.code : "";
  const line = code
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("// @options"));
  if (!line) return "Run a script";
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
}

/**
 * The `codemode` tool's policy: it only runs the model's script inside the sandbox, which can call nothing but tools,
 * and each of those is decided on its own. So the script's own call is `read_internal` and never asks.
 */
const CODEMODE_POLICY: ToolPolicy = {
  actionClass: "read_internal",
  connector: "codemode",
  operation: "run",
  summary: codemodeSummary,
};

/**
 * The sandbox with Rei's deadline on every durable run. Pi's `codemode` tool starts scripts through `start()`, which
 * takes its deadline only from the script's own `// @options: {"timeout_ms": …}` line (none: no deadline at all, and the
 * model may write any value). The `timeoutMs` the sandbox is made with applies to `execute()` only. So the limit is
 * applied here: the model can lower the deadline, never raise or drop it. A restart starts the clock again for the
 * attempt that replays the script (Pi stores a deadline only when the script set one).
 */
class BoundedSandbox extends CodemodeSandbox {
  readonly #limitMs: number;

  constructor(options: CodemodeSandboxOptions & { timeoutMs: number }) {
    super(options);
    this.#limitMs = options.timeoutMs;
  }

  override start(code: string, options: CodemodeRunOptions): CodemodeRun {
    return super.start(code, {
      ...options,
      timeoutMs: Math.min(options.timeoutMs ?? Number.POSITIVE_INFINITY, this.#limitMs),
    });
  }
}

/**
 * What a script of one conversation may see of the tools its agent has. The tools themselves come from Pi
 * (`agent.callable`: every enabled tool that lists `"tools"` among its `callers`); this narrows them per conversation.
 */
export interface ScriptScope {
  /** Whether the conversation's agent may use the tool. A script sees no other tool, and so cannot call it. */
  visible(conversationId: unknown, toolName: string): boolean;
}

/** `_activity` is the label the model gives a call for the user; a script's calls are labelled by the script's row. */
function withoutActivity(tool: ToolRegistration): ToolRegistration {
  const parameters = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
  if (!parameters.properties || !("_activity" in parameters.properties)) return tool;
  const { _activity, ...properties } = parameters.properties;
  const required = parameters.required?.filter((name) => name !== "_activity");
  return {
    ...tool,
    parameters: { ...parameters, properties, ...(required ? { required } : {}) },
  } as ToolRegistration;
}

/**
 * The agent as a script sees it: only the callable tools its agent may use, without `_activity` in their declarations.
 * Pi builds the start data of a script (the `codemode` section, `ALL_TOOLS`, `searchTools()`, `describeTool()`) from
 * `agent.callable`, and has no per-conversation filter for the callers of a tool (`AgentState.tools` is stored state
 * that would have to follow every connector and setting change), so the `codemode` tool and section look at this view
 * instead. Blocking at call time (the policy's connector check) stays as the second line.
 */
function scriptView(agent: Agent, scope: ScriptScope, conversationId: unknown): Agent {
  return {
    ...agent,
    callable: agent.callable.filter((tool) => scope.visible(conversationId, tool.name)).map(withoutActivity),
  } as Agent;
}

/** The tool's api, but `agent()` resolves to the script's view of the agent. */
function scriptApi<A extends { conversationId: unknown; agent(context: never): Promise<Agent> }>(
  api: A,
  scope: ScriptScope,
): A {
  return new Proxy(api, {
    get(target, property) {
      if (property === "agent")
        return async (context: never) => scriptView(await target.agent(context), scope, target.conversationId);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The `codemode` section, rendered from the script's view of the agent. */
function scriptSection(base: PromptSection, scope: ScriptScope): PromptSection {
  return {
    ...base,
    render: (input, context) =>
      base.render({ ...input, agent: scriptView(input.agent, scope, input.conversationId) }, context),
  };
}

/** The sandbox of one server process and the scripts it admits. */
export class CodemodeRuntime {
  readonly #limits: CodemodeLimits;
  readonly #log: Logger;
  #sandbox: BoundedSandbox | undefined;
  #workers = 0;
  readonly #exits = new Set<Promise<void>>();

  constructor(limits: CodemodeLimits, log: Logger) {
    this.#limits = limits;
    this.#log = log;
  }

  /** Workers that were started and have not exited yet. */
  get workers(): number {
    return this.#workers;
  }

  /** Resolves once every worker started so far has exited. */
  async idle(): Promise<void> {
    while (this.#exits.size > 0) await Promise.allSettled([...this.#exits]);
  }

  /** Made at first use, so a server with code mode off never loads the engine. */
  get sandbox(): CodemodeSandbox {
    this.#sandbox ??= new BoundedSandbox({
      timeoutMs: this.#limits.timeoutMs,
      memoryLimitBytes: this.#limits.memoryLimitBytes,
      // Counted when a worker is about to start and released when it actually exits, which can be after the script ends.
      acquireWorker: () => {
        if (this.#workers >= this.#limits.maxWorkers) throw new Error(TOO_MANY_SCRIPTS);
        this.#workers += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.#workers -= 1;
        };
      },
      onWorkerStarted: (exited) => {
        this.#log.debug("codemode.worker_started", { workers: this.#workers });
        const tracked = exited.finally(() => {
          this.#exits.delete(tracked);
          this.#log.debug("codemode.worker_exited", { workers: this.#workers });
        });
        this.#exits.add(tracked);
        tracked.catch(() => undefined);
      },
    });
    return this.#sandbox;
  }

  /**
   * The `codemode` extension for one tree, with its tool declared in the catalog. `models: false`: a script's model
   * calls would skip Rei's usage, purpose and Trace attribution. Pi's internal tools exist only with models, so the
   * `codemode` tool is the only one registered; every tool the extension brings goes through `policyTool` anyway, so
   * none can reach the policy hook undeclared. What a script sees of the other tools is `scope`'s view of the session's
   * agent: the same tools `search_capabilities` shows it, with no `_activity` in their declarations.
   */
  extension(catalog: ToolCatalog, scope: ScriptScope): Extension {
    const base = createCodemodeExtension({
      sandbox: this.sandbox,
      models: false,
      inlineBudget: this.#limits.inlineBudget ?? CODEMODE_INLINE_BUDGET,
    });
    const tools = (base.tools ?? []).map((tool) => {
      const scoped = {
        ...tool,
        execute: (args: never, api: never, context: never) =>
          (tool.execute as (args: never, api: never, context: never) => unknown)(args, scriptApi(api, scope), context),
      };
      return policyTool(catalog, CODEMODE_POLICY, scoped as never) as ToolRegistration;
    });
    const sections = (base.sections ?? []).map((section) => scriptSection(section, scope));
    return { ...base, tools, sections };
  }

  /** Aborts running scripts and waits for their workers to exit. Their calls replay from Pi's journal after a restart. */
  async close(): Promise<void> {
    const sandbox = this.#sandbox;
    if (!sandbox) return;
    await sandbox.close();
    await this.idle();
  }
}
