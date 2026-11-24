// Who may call a built-in tool: the model, scripts that code mode runs (Pi's `tools` caller), or both. Every built-in
// tool names its callers explicitly, so a new tool is a decision, not a default (test/tool-callers.test.ts fails for
// a tool with none). The reasons are in docs/code-mode.md.

/** Pi's `callers` of a tool: `"model"` is the model's own tool calls, `"tools"` is nested calls (scripts). */
export type ToolCallers = readonly ("model" | "tools")[];

/**
 * Only the model: tools that open UI or wait on the user, start or steer sessions and triggers, change skills, plugins
 * or settings, or only make sense in the model's own context (loading a skill, loading tools). A script that calls one
 * gets Pi's caller error.
 */
export const MODEL_ONLY: ToolCallers = ["model"];

/** The model and scripts: reads, plain writes, and the tools that work in the sandbox, the browser or a connector. */
export const MODEL_AND_SCRIPTS: ToolCallers = ["model", "tools"];
