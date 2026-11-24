// Capability discovery (issue 02): which tools each kind of chat is offered, and search_capabilities loading deferred
// tool groups natively (Pi's control.addTools), by query or by exact name, plus the skills it suggests.

import { afterEach, describe, expect, it } from "vitest";
import { ToolGroups } from "../src/capabilities/groups.ts";
import { droppedExtensions } from "../src/pi/trees.ts";
import { tool } from "./helpers/approvals.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, homeChat, say, settled, stepPayloads } from "./helpers/sessions.ts";
import { toolResults } from "./helpers/web.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const start = async (): Promise<TestServer> => {
  server = await startSignedIn();
  return server;
};

/** The tools a model request offered: its system messages' tool changes, replayed in order. */
function offered(payload: string): Set<string> {
  const request = JSON.parse(payload) as {
    messages: { role: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] }[];
  };
  const names = new Set<string>();
  for (const m of request.messages) {
    if (m.role !== "system") continue;
    // A changed definition comes as a removal and an addition in one message.
    for (const t of m.toolsRemoved ?? []) names.delete(t.name);
    for (const t of m.toolsAdded ?? []) names.add(t.name);
  }
  return names;
}
const lastOffered = (s: TestServer, id: string): Set<string> => offered(stepPayloads(s, id).at(-1)!);

// The core groups this test server has (no sandbox, so no bash): memory, library, knowledge, skills, web.
const CORE_WORKER = [
  "memory_add",
  "search_history",
  "search_library",
  "read_library_file",
  "knowledge_search",
  "web_search",
  "use_skill",
  "read_skill_file",
  "save_skill",
  "search_capabilities",
];
const DEFERRED = ["list_triggers", "create_trigger", "update_trigger", "delete_trigger", "list_plugins", "read_plugin"];

describe("tool groups", () => {
  it("marks every tool of a deferred group deferred, and leaves core groups as they are", () => {
    const groups = new ToolGroups();
    const t = (name: string) => ({ name, description: name, parameters: {}, execute: async () => ({}) }) as never;
    const triggers = groups.mark({ name: "triggers", tools: [t("list_triggers"), t("create_trigger")] } as never);
    const memory = { name: "memory", tools: [t("memory_search")] } as never;
    expect(groups.mark(memory)).toBe(memory);
    expect((triggers as { tools: { deferred?: boolean }[] }).tools.every((x) => x.deferred === true)).toBe(true);
    expect(groups.groupOf("create_trigger")).toBe("triggers");
    expect(groups.toolsOf("triggers")).toEqual(["list_triggers", "create_trigger"]);
    expect(groups.isDeferred("list_triggers")).toBe(true);
    expect(groups.isDeferred("triggers")).toBe(true);
    expect(groups.isDeferred("memory_search")).toBe(false);
    expect(groups.deferredGroups()).toEqual(["triggers"]);
  });

  it("drops the session tools outside the home chat and report() outside trigger runs", () => {
    expect(droppedExtensions("home")).toEqual(["trigger_run"]);
    expect(droppedExtensions("trigger")).toEqual(["sessions"]);
    expect(droppedExtensions("user")).toEqual(["sessions", "trigger_run"]);
  });
});

describe("the tools each chat is offered", () => {
  it("offers the core groups and search_capabilities, never a deferred group before it is loaded", async () => {
    const s = await start();
    const home = homeChat(s);
    await say(s, home, "hi");
    await settled(s, home);
    const worker = await chat(s);
    await say(s, worker, "hi");
    await settled(s, worker);

    const atHome = lastOffered(s, home);
    const inWorker = lastOffered(s, worker);
    for (const name of CORE_WORKER) {
      expect(atHome.has(name), `home: ${name}`).toBe(true);
      expect(inWorker.has(name), `worker: ${name}`).toBe(true);
    }
    for (const name of ["start_session", "list_sessions", "cancel_session"]) {
      expect(atHome.has(name), `home: ${name}`).toBe(true);
      expect(inWorker.has(name), `worker: ${name}`).toBe(false);
    }
    for (const name of [...DEFERRED, "report", "use_builtin_tool"]) {
      expect(atHome.has(name), `home: ${name}`).toBe(false);
      expect(inWorker.has(name), `worker: ${name}`).toBe(false);
    }
    // The index says what can be loaded.
    const payload = stepPayloads(s, worker).at(-1)!;
    expect(payload).toContain("Deferred tool groups");
    expect(payload).toContain("- triggers: schedule reminders");
    expect(payload).not.toContain("deferred_tools");
  });
});

describe("search_capabilities", () => {
  it("loads a whole group for a matching query, and the group stays loaded in later turns", async () => {
    const s = await start();
    const id = await chat(s);
    await say(s, id, tool("search_capabilities", { query: "schedule a weekly reminder" }));
    await settled(s, id);
    const result = toolResults(s, id).at(-1)!;
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Loaded the triggers tools (4)");
    expect(lastOffered(s, id).has("create_trigger")).toBe(true);

    await say(s, id, "thanks");
    await settled(s, id, 2);
    const later = lastOffered(s, id);
    for (const name of ["list_triggers", "create_trigger", "update_trigger", "delete_trigger"])
      expect(later.has(name), name).toBe(true);
    expect(later.has("list_plugins")).toBe(false);
  });

  it("a fork keeps the groups its source had loaded", async () => {
    const s = await start();
    const id = await chat(s);
    await say(s, id, tool("search_capabilities", { load: ["triggers"] }));
    const d = await settled(s, id);
    const reply = d.messages.filter((m) => m.role === "assistant").at(-1)!;
    const res = await s.client.post(`/api/sessions/${id}/fork`, { messageId: reply.id });
    expect(res.status).toBe(200);
    const fork = res.body.session.id as string;
    await say(s, fork, "hi");
    await settled(s, fork);
    expect(lastOffered(s, fork).has("create_trigger")).toBe(true);
  });

  it("loads by exact tool or group name, and reports unknown and already loaded names", async () => {
    const s = await start();
    const id = await chat(s);
    await say(s, id, tool("search_capabilities", { load: ["list_triggers", "nope"] }));
    await settled(s, id);
    let text = toolResults(s, id).at(-1)!.text;
    expect(text).toContain("Loaded the triggers tools (4)");
    expect(text).toContain("Not found: nope.");

    await say(s, id, tool("search_capabilities", { load: ["plugins", "triggers", "bash"] }));
    await settled(s, id, 2);
    text = toolResults(s, id).at(-1)!.text;
    expect(text).toMatch(/Loaded the plugins tools \(\d\)/);
    expect(text).toContain("Already available:");
    expect(text).toContain("list_triggers");
    expect(text).toContain("bash");
    expect(lastOffered(s, id).has("list_plugins")).toBe(true);
  });

  it("refuses an empty search, and says nothing matches rather than loading something", async () => {
    const s = await start();
    const id = await chat(s);
    await say(s, id, `${tool("search_capabilities", {})} ${tool("search_capabilities", { query: "zzqx vbnm" })}`);
    await settled(s, id);
    const [empty, none] = toolResults(s, id).slice(-2);
    expect(empty).toMatchObject({ isError: true });
    expect(empty!.text).toContain("Give a query, or names to load.");
    expect(none!.text).toContain('Nothing matches "zzqx vbnm"');
    expect(lastOffered(s, id).has("list_triggers")).toBe(false);
  });

  it("lists the agent's matching skills with a pointer to use_skill", async () => {
    const s = await start();
    s.host.plane.skills.save({
      files: [
        {
          path: "SKILL.md",
          encoding: "text",
          content:
            "---\nname: weekly-report\ndescription: Write the weekly status report. Use on Mondays.\n---\n\nSteps.\n",
        },
      ],
      author: "user",
      note: "Imported",
      log: false,
    });
    const id = await chat(s);
    await say(s, id, tool("search_capabilities", { query: "weekly status report" }));
    await settled(s, id);
    const text = toolResults(s, id).at(-1)!.text;
    expect(text).toContain("Skills that match (read with use_skill before you start):");
    expect(text).toMatch(/- (weekly-report\/)?weekly-report.*Write the weekly status report/);
  });

  it("a deferred tool the model calls without loading it is not offered and does not run", async () => {
    const s = await start();
    const id = await chat(s);
    await say(s, id, "[call: list_triggers {}]");
    await settled(s, id);
    const result = toolResults(s, id).at(-1)!;
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/list_triggers is not available/i);
  });
});
