// Tool groups: a built-in extension's tools are one group, offered or deferred together. The browser, plugins and
// triggers groups are deferred: registered with `deferred: true`, so the model is offered them only after
// search_capabilities loads the group (Pi's `control.addTools`). Every other group is core.

import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";

/** The deferred groups, with the line the Capabilities index shows for each. */
export const DEFERRED_GROUPS: Readonly<Record<string, string>> = {
  browser: "open websites, read pages, click, type, fill in forms and take screenshots in the user's browser window",
  plugins: "list, read, create and update plugins (installable packages of skills and connectors)",
  triggers: "schedule reminders and recurring work (daily, weekly, monthly); list, change or delete triggers",
};

/** The group names and tool names of one tree, recorded as its extensions are installed. */
export class ToolGroups {
  readonly #groupOf = new Map<string, string>();
  readonly #tools = new Map<string, string[]>();

  /** Records the extension's tools as its group; a deferred group's tools come back marked `deferred`. */
  mark<E extends Extension>(extension: E): E {
    const tools = extension.tools ?? [];
    if (tools.length === 0) return extension;
    const group = extension.name;
    for (const tool of tools) this.#groupOf.set(tool.name, group);
    this.#tools.set(
      group,
      tools.map((t) => t.name),
    );
    if (!(group in DEFERRED_GROUPS)) return extension;
    return { ...extension, tools: tools.map((t): ToolRegistration => ({ ...t, deferred: true })) } as E;
  }

  /** The group a built-in tool belongs to. */
  groupOf(tool: string): string | undefined {
    return this.#groupOf.get(tool);
  }

  /** The tools of a group, in registration order; empty for an unknown group. */
  toolsOf(group: string): string[] {
    return this.#tools.get(group) ?? [];
  }

  /** Whether a group or tool name is (in) a deferred group. */
  isDeferred(name: string): boolean {
    const group = this.#tools.has(name) ? name : this.#groupOf.get(name);
    return group !== undefined && group in DEFERRED_GROUPS;
  }

  /** The deferred groups this tree has, in the order of DEFERRED_GROUPS. */
  deferredGroups(): string[] {
    return Object.keys(DEFERRED_GROUPS).filter((g) => this.#tools.has(g));
  }
}
