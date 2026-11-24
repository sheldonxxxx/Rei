import type { PluginDetail, PluginPackage } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { exportPluginZip, importPluginZip, validatePackage } from "../src/plugins/package.ts";
import { approve, tool as directive, pending, setProfile, waitPending } from "./helpers/approvals.ts";
import { FakeMcpGateway, tool } from "./helpers/fake-mcp.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, say, settled } from "./helpers/sessions.ts";
import { callTool } from "./helpers/web.ts";

const pkg = (name = "research"): PluginPackage => ({
  formatVersion: 1,
  name,
  description: "Research notes",
  skills: [
    {
      name: "notes",
      files: [
        {
          path: "SKILL.md",
          encoding: "text",
          content: "---\nname: notes\ndescription: Work with notes\n---\n\nRead notes carefully before making changes.",
        },
      ],
    },
  ],
  mcp: [],
});
let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const start = async (gw?: FakeMcpGateway) => {
  server = await startSignedIn(gw ? { fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } } : {});
  return server;
};
const create = async (s: TestServer, content = pkg()) => {
  const result = await s.client.post("/api/plugins", { package: content });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body.plugin as PluginDetail;
};
describe("plugin packages", () => {
  it("round trips multiple skills, binary files and linked MCP definitions without installed state", () => {
    const p = pkg();
    p.skills[0]!.files.push({ path: "assets/sample.bin", encoding: "base64", content: "AAEC" });
    p.skills.push({
      name: "other",
      files: [
        {
          path: "SKILL.md",
          encoding: "text",
          content: "---\nname: other\ndescription: Another skill\n---\n\nInstructions.",
        },
      ],
    });
    p.mcp.push({ name: "notes", url: "https://notes.example/mcp", auth: "token", skills: ["notes", "other"] });
    expect(importPluginZip(exportPluginZip(p, Date.now()))).toEqual(validatePackage(p));
    expect(() => validatePackage({ ...p, token: "secret" })).toThrow(/credentials/);
    expect(() => validatePackage({ ...p, mcp: [{ ...p.mcp[0], token: "secret" }] })).toThrow(/credentials/);
    expect(() => validatePackage({ ...p, mcp: [{ ...p.mcp[0], skills: ["missing"] }] })).toThrow(/reference/);
    expect(() =>
      validatePackage({ ...p, mcp: [{ ...p.mcp[0], url: `https://${["user", "pass"].join(":")}@example.com/mcp` }] }),
    ).toThrow(/credentials/);
    expect(() =>
      validatePackage({
        ...p,
        skills: [{ name: "notes", files: [{ path: "../bad", encoding: "text", content: "bad" }] }],
      }),
    ).toThrow();
  });
});
describe("plugin lifecycle", () => {
  it("creates versioned packages, rejects stale updates, restores content and preserves skill identity", async () => {
    const s = await start();
    const first = await create(s);
    const content = pkg();
    content.skills[0]!.files[0]!.content += "\nUpdated.";
    const result = await s.client.call("PATCH", `/api/plugins/${first.id}`, {
      body: { package: content, expectedRevision: 1 },
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.plugin.revision).toBe(2);
    expect(result.body.plugin.skills[0].id).toBe(first.skills[0]!.id);
    expect(
      (await s.client.call("PATCH", `/api/plugins/${first.id}`, { body: { package: pkg(), expectedRevision: 1 } }))
        .status,
    ).toBe(409);
    const historical = await s.host.plane.plugins.get(first.id, undefined, 1);
    expect(historical.package).toEqual(pkg());
    const restored = await s.host.plane.plugins.save(historical.package, {
      id: first.id,
      expectedRevision: 2,
      author: "user",
    });
    expect(restored.revision).toBe(3);
    expect(restored.revisions).toHaveLength(3);
    const duplicate = await create(s);
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.revision).toBe(3);
  });
  it("leaves standalone skills and connectors outside any plugin", async () => {
    const gw = new FakeMcpGateway();
    gw.add("con_notes", "Notes", [tool("search", "Search notes", { readOnlyHint: true })]);
    const s = await start(gw);
    const saved = s.host.plane.skills.save({
      files: pkg().skills[0]!.files,
      author: "user",
      note: "Standalone",
      log: false,
    }).skill;
    expect((await s.host.plane.plugins.list()).filter((p) => !p.builtIn)).toEqual([]);
    const files = pkg().skills[0]!.files;
    files[0]!.content += "\nEdited.";
    s.host.plane.skills.save({ files, author: "user", note: "Edit", log: false });
    expect((await s.host.plane.plugins.list()).filter((p) => !p.builtIn)).toEqual([]);
    expect(s.host.plane.plugins.owner("skill", saved.id)).toBeNull();
    expect(s.host.plane.plugins.owner("connection", "con_notes")).toBeNull();
  });
  it("resolves qualified skills, rejects ambiguous names, and hides disabled plugins", async () => {
    const s = await start();
    const a = await create(s, pkg("one"));
    await create(s, pkg("two"));
    const id = await chat(s);
    const agent = s.host.plane.store.getSessionRow(id)!.agent_id;
    // Two plugins share the bare name: it is ambiguous, so only the qualified names resolve.
    expect(s.host.plane.skills.byName("notes", agent)).toBeUndefined();
    expect(s.host.plane.skills.byName("one/notes", agent)).toBeDefined();
    await s.host.plane.plugins.installation(a.id, { enabled: false });
    expect(s.host.plane.skills.byName("one/notes", agent)).toBeUndefined();
    expect((await s.host.plane.plugins.list(agent)).filter((p) => !p.builtIn).map((p) => p.name)).toEqual(["two"]);
    expect((await callTool(s, id, "use_skill", { name: "two/notes" })).last!.text).toContain("Read notes carefully");
    expect((await callTool(s, id, "read_plugin", { plugin: "two" })).last!.text).toContain("two/notes");
  });
  it("keeps authentication failures retryable and replaces endpoints without carrying permissions", async () => {
    const gw = new FakeMcpGateway();
    const s = await start(gw);
    const content = pkg();
    content.mcp.push({ name: "notes", url: "https://notes.example/mcp", auth: "oauth", skills: ["notes"] });
    const first = await create(s, content);
    expect(first.connections[0]!.status).toBe("needs_auth");
    await s.host.plane.plugins.reconcile(first.id);
    expect(gw.requests.filter((r) => r.method === "POST" && r.path === "/mcp/connectors")).toHaveLength(1);
    const c = gw.connectors[0]!;
    c.status = "connected";
    gw.tools.set(c.id, [tool("search", "Search notes", { readOnlyHint: true })]);
    await s.host.plane.plugins.reconcile(first.id);
    const session = await chat(s);
    // The plugin's connector tool comes with the plugin's skill.
    const result = await callTool(s, session, "search_capabilities", { query: "search notes" });
    expect(result.last!.text).toContain("notes__search");
    expect(result.last!.text).toContain("research/notes");
    await s.host.plane.plugins.installation(first.id, { enabled: false });
    expect((await callTool(s, session, "search_capabilities", { query: "search notes" })).last!.text).not.toContain(
      "notes__search",
    );
    content.mcp[0]!.url = "https://new.example/mcp";
    const updated = await s.host.plane.plugins.save(content, { id: first.id, expectedRevision: 1, author: "user" });
    expect(updated.connections[0]!.connectorId).not.toBe(c.id);
    expect(gw.connectors.some((x) => x.id === c.id)).toBe(false);
    expect(updated.connections[0]!.connector?.mcpProfile).toBe("always_ask");
  });
  it.each(["strict", "standard", "relaxed", "yolo"] as const)(
    "agent creation follows %s permissions",
    async (profile) => {
      const s = await start();
      const id = await chat(s);
      await setProfile(s, id, profile);
      await say(s, id, directive("create_plugin", { package: pkg() }));
      if (profile !== "yolo") {
        const cards = await waitPending(s, id);
        expect(cards[0]!.preview?.kind).toBe("plugin");
        expect((await s.host.plane.plugins.list()).filter((p) => !p.builtIn)).toHaveLength(0);
        await approve(s, id);
      } else await settled(s, id, 1);
      expect((await s.host.plane.plugins.list()).filter((p) => !p.builtIn).map((p) => p.name)).toEqual(["research"]);
      expect(await pending(s)).toHaveLength(0);
    },
  );
});
