// Standalone skills and connectors (issue 08): a skill or connector with no plugin is a first-class component. It is
// created, used, edited and removed on its own; a plugin's removal or disabling leaves it alone; its name never collides
// with a plugin skill's; and its visibility is its own (a skill's agents list, the agent's connector setting).

import type { Connector, PluginPackage, SkillFile, SkillSummary } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { approve, tool as directive } from "./helpers/approvals.ts";
import { FakeMcpGateway, tool } from "./helpers/fake-mcp.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, say } from "./helpers/sessions.ts";
import { callTool } from "./helpers/web.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const skillFiles = (name: string, body: string): SkillFile[] => [
  { path: "SKILL.md", encoding: "text", content: `---\nname: ${name}\ndescription: ${name} work\n---\n\n${body}` },
];
const plugin = (name: string, skill: string, body: string, mcp: PluginPackage["mcp"] = []): PluginPackage => ({
  formatVersion: 1,
  name,
  description: `${name} plugin`,
  skills: [{ name: skill, files: skillFiles(skill, body) }],
  mcp,
});
const patch = (s: TestServer, path: string, body: unknown) => s.client.call("PATCH", path, { body });
/** save_skill always asks: say it, then approve the card. */
const saveSkill = async (s: TestServer, id: string, args: unknown) => {
  await say(s, id, directive("save_skill", args));
  await approve(s, id);
};
const skillsOf = async (s: TestServer) => (await s.client.get("/api/skills")).body.skills as SkillSummary[];
const connectorsOf = async (s: TestServer) => (await s.client.get("/api/connectors")).body.connectors as Connector[];
const agentOf = (s: TestServer, session: string) => s.host.plane.store.getSessionRow(session)!.agent_id;
const createPlugin = async (s: TestServer, pkg: PluginPackage) => {
  const r = await s.client.post("/api/plugins", { package: pkg });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.plugin as { id: string };
};

describe("standalone skills", () => {
  it("are created, used, edited and deleted without a plugin", async () => {
    server = await startSignedIn();
    const s = server;
    const created = await s.client.post("/api/skills", { files: skillFiles("triage", "Sort the inbox first.") });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const skill = created.body.skill as SkillSummary;
    expect(skill.plugin).toBeNull();
    expect((await skillsOf(s)).find((x) => x.id === skill.id)?.plugin).toBeNull();
    // No plugin is made for it.
    expect((await s.host.plane.plugins.list()).filter((p) => !p.builtIn)).toEqual([]);

    const id = await chat(s);
    expect((await callTool(s, id, "use_skill", { name: "triage" })).last!.text).toContain("Sort the inbox first.");

    const edited = await patch(s, `/api/skills/${skill.id}`, {
      files: skillFiles("triage", "Sort the inbox by sender."),
    });
    expect(edited.status).toBe(200);
    expect(edited.body.skill).toMatchObject({ version: 2, plugin: null });
    expect((await callTool(s, id, "use_skill", { name: "triage" })).last!.text).toContain("by sender");
    expect((await s.host.plane.plugins.list()).filter((p) => !p.builtIn)).toEqual([]);

    expect((await s.client.call("DELETE", `/api/skills/${skill.id}`)).status).toBe(200);
    expect((await skillsOf(s)).some((x) => x.id === skill.id)).toBe(false);
    expect((await callTool(s, id, "use_skill", { name: "triage" })).last!.text).toContain('no skill named "triage"');
  });

  it("are saved by the agent as standalone skills, and follow their own agents list", async () => {
    server = await startSignedIn();
    const s = server;
    const id = await chat(s);
    await saveSkill(s, id, { name: "weekly-report", description: "Weekly report", body: "Use bullets." });
    const saved = (await skillsOf(s)).find((x) => x.name === "weekly-report")!;
    expect(saved.plugin).toBeNull();
    expect((await s.host.plane.plugins.list()).filter((p) => !p.builtIn)).toEqual([]);

    await patch(s, `/api/skills/${saved.id}`, { agents: [] });
    expect(s.host.plane.skills.byName("weekly-report", agentOf(s, id))).toBeUndefined();
    expect((await callTool(s, id, "use_skill", { name: "weekly-report" })).last!.text).toContain("no skill named");
    await patch(s, `/api/skills/${saved.id}`, { agents: null });
    expect(s.host.plane.skills.byName("weekly-report", agentOf(s, id))?.id).toBe(saved.id);
  });

  it("never collide with a plugin skill of the same bare name", async () => {
    server = await startSignedIn();
    const s = server;
    const owner = await createPlugin(s, plugin("notes", "research", "Plugin research steps."));
    const id = await chat(s);
    const agent = agentOf(s, id);
    const { skills } = s.host.plane;

    // With only the plugin's skill, its bare name still finds it.
    expect(skills.byName("research", agent)?.name).toBe("notes/research");
    // save_skill with a bare name makes a standalone skill; it does not edit the plugin's.
    await saveSkill(s, id, { name: "research", description: "Mine", body: "My research steps." });
    const all = await skillsOf(s);
    const standalone = all.find((x) => x.name === "research")!;
    const owned = all.find((x) => x.name === "notes/research")!;
    expect(standalone.plugin).toBeNull();
    expect(owned.plugin).toEqual({ id: owner.id, name: "notes", enabled: true });
    expect(owned.version).toBe(1);

    // The exact name wins; the qualified name reaches the plugin's.
    expect(skills.byName("research", agent)?.id).toBe(standalone.id);
    expect(skills.byName("notes/research", agent)?.id).toBe(owned.id);
    expect((await callTool(s, id, "use_skill", { name: "research" })).last!.text).toContain("My research steps.");
    expect((await callTool(s, id, "use_skill", { name: "notes/research" })).last!.text).toContain(
      "Plugin research steps.",
    );

    // Saving each by its own name edits only that one.
    await saveSkill(s, id, { name: "research", description: "Mine", body: "My research, revised." });
    await saveSkill(s, id, { name: "notes/research", description: "Theirs", body: "Plugin, revised." });
    const after = await skillsOf(s);
    expect(after.find((x) => x.id === standalone.id)!.version).toBe(2);
    expect(after.find((x) => x.id === owned.id)!.version).toBe(2);
    expect((await s.host.plane.plugins.get(owner.id)).revision).toBe(2);

    // A hidden standalone skill keeps its name: the bare name does not fall through to the plugin's.
    await patch(s, `/api/skills/${standalone.id}`, { agents: [] });
    expect(skills.byName("research", agent)).toBeUndefined();
    // Gone, the bare name finds the plugin's again.
    await s.client.call("DELETE", `/api/skills/${standalone.id}`);
    expect(skills.byName("research", agent)?.id).toBe(owned.id);
  });

  it("stay when a plugin is disabled or removed", async () => {
    server = await startSignedIn();
    const s = server;
    const owner = await createPlugin(s, plugin("notes", "research", "Plugin steps."));
    const mine = (await s.client.post("/api/skills", { files: skillFiles("triage", "Mine.") })).body
      .skill as SkillSummary;
    const id = await chat(s);
    const agent = agentOf(s, id);
    await s.host.plane.plugins.installation(owner.id, { enabled: false });
    expect(s.host.plane.skills.byName("notes/research", agent)).toBeUndefined();
    expect(s.host.plane.skills.byName("triage", agent)?.id).toBe(mine.id);
    expect((await skillsOf(s)).find((x) => x.name === "notes/research")?.plugin?.enabled).toBe(false);
    await s.host.plane.plugins.remove(owner.id);
    const left = await skillsOf(s);
    expect(left.some((x) => x.name === "notes/research")).toBe(false);
    expect(left.find((x) => x.id === mine.id)?.plugin).toBeNull();
  });
});

describe("standalone connectors", () => {
  const NOTES = [tool("search_notes", "Search the user's notes by text.", { readOnlyHint: true })];
  const MAIL = [tool("send_mail", "Send an email.")];

  it("are added, used and removed without a plugin", async () => {
    const gw = new FakeMcpGateway();
    server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } });
    const s = server;
    const added = await s.client.post("/api/connectors", { name: "Notes", url: "https://notes.example/mcp" });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const connector = added.body.connector as Connector;
    gw.connectors.find((c) => c.id === connector.id)!.status = "connected";
    gw.tools.set(connector.id, structuredClone(NOTES));
    await s.host.plane.adapter.trees.syncConnectors();
    expect((await connectorsOf(s)).find((c) => c.id === connector.id)?.plugin).toBeNull();
    expect((await s.host.plane.plugins.list()).filter((p) => !p.builtIn)).toEqual([]);

    const id = await chat(s);
    expect((await callTool(s, id, "search_capabilities", { query: "search my notes" })).last!.text).toContain(
      "notes__search_notes",
    );
    expect((await s.client.call("DELETE", `/api/connectors/${connector.id}`)).status).toBe(204);
    await s.host.plane.adapter.trees.syncConnectors();
    expect(await connectorsOf(s)).toEqual([]);
    expect((await callTool(s, id, "search_capabilities", { query: "search my notes" })).last!.text).not.toContain(
      "notes__search_notes",
    );
  });

  it("follow the agent's connector setting", async () => {
    const gw = new FakeMcpGateway();
    gw.add("con_notes", "Notes", structuredClone(NOTES));
    server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } });
    const s = server;
    const id = await chat(s);
    const directory = s.host.plane.connectorTools;
    expect(directory.allowed(agentOf(s, id), "con_notes")).toBe(true);
    s.host.plane.store.updateAgentSettings(agentOf(s, id), { allowedConnectorIds: [] });
    expect(directory.allowed(agentOf(s, id), "con_notes")).toBe(false);
    s.host.plane.store.updateAgentSettings(agentOf(s, id), { allowedConnectorIds: ["con_notes"] });
    expect(directory.allowed(agentOf(s, id), "con_notes")).toBe(true);
  });

  it("stay when a plugin with its own connector is disabled or removed", async () => {
    const gw = new FakeMcpGateway();
    gw.add("con_mail", "Mail", structuredClone(MAIL));
    server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } });
    const s = server;
    const owner = await createPlugin(
      s,
      plugin("notes", "research", "Plugin steps.", [
        { name: "notes", url: "https://notes.example/mcp", auth: "none", skills: ["research"] },
      ]),
    );
    await s.host.plane.plugins.reconcile(owner.id);
    const pluginConnector = gw.connectors.find((c) => c.id !== "con_mail")!;
    pluginConnector.status = "connected";
    gw.tools.set(pluginConnector.id, structuredClone(NOTES));
    await s.host.plane.plugins.reconcile(owner.id);
    await s.host.plane.adapter.trees.syncConnectors();

    const listed = await connectorsOf(s);
    expect(listed.find((c) => c.id === "con_mail")?.plugin).toBeNull();
    expect(listed.find((c) => c.id === pluginConnector.id)?.plugin).toMatchObject({ id: owner.id, name: "notes" });

    const id = await chat(s);
    const agent = agentOf(s, id);
    const directory = s.host.plane.connectorTools;
    await s.host.plane.plugins.installation(owner.id, { enabled: false });
    expect(directory.allowed(agent, pluginConnector.id)).toBe(false);
    expect(directory.allowed(agent, "con_mail")).toBe(true);

    await s.host.plane.plugins.remove(owner.id);
    await s.host.plane.adapter.trees.syncConnectors();
    const left = await connectorsOf(s);
    expect(left.map((c) => c.id)).toEqual(["con_mail"]);
    expect(left[0]!.plugin).toBeNull();
    expect((await callTool(s, id, "search_capabilities", { load: ["mail__send_mail"] })).last!.text).toContain(
      "mail__send_mail",
    );
  });
});
