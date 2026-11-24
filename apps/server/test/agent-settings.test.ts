import { type Agent, type EditLogEntry, THINKING_LEVELS } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeGateway, startFakeGateway } from "./helpers/fake-gateway.ts";
import { STANDIN, startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
let gateway: FakeGateway | undefined;
afterEach(async () => {
  await server?.destroy();
  await gateway?.close();
  server = undefined;
  gateway = undefined;
});
const s = (): TestServer => server!;
const agent = async () => (await s().client.get("/api/agents")).body.agents[0] as Agent;
const patch = (id: string, body: unknown) => s().client.call("PATCH", `/api/agents/${id}`, { body });
const edits = async (query = ""): Promise<EditLogEntry[]> => (await s().client.get(`/api/edits${query}`)).body.entries;

describe("agent settings", () => {
  it("persists thinking effort, announces and logs changes, and keeps it after restart", async () => {
    server = await startSignedIn();
    const a = await agent();
    expect(a.thinkingLevel).toBe("off");
    const stream = await s().sse("/api/stream");
    expect((await patch(a.id, { thinkingLevel: "high" })).body.agent.thinkingLevel).toBe("high");
    const seen = await stream.waitFor((e) => e.event === "agent.upserted" && e.data.agent.thinkingLevel === "high");
    expect(seen.data.agent.id).toBe(a.id);
    stream.close?.();
    await patch(a.id, { thinkingLevel: "high" });
    expect((await edits()).map((e) => [e.field, e.before, e.after])).toEqual([["thinkingLevel", "off", "high"]]);
    const { dir, totpSecret } = server;
    const cookie = s().client.cookie;
    await s().stop();
    server = Object.assign(await startTestServer({ dir }), { totpSecret });
    s().client.cookie = cookie;
    expect((await agent()).thinkingLevel).toBe("high");
    for (const thinkingLevel of THINKING_LEVELS)
      expect((await patch(a.id, { thinkingLevel })).body.agent.thinkingLevel).toBe(thinkingLevel);
  });

  it("rejects invalid thinking efforts before changing any settings", async () => {
    server = await startSignedIn();
    const a = await agent();
    for (const thinkingLevel of [null, "", "ultra", "HIGH", " high ", 3, true, {}, []]) {
      const res = await patch(a.id, { name: "Changed", thinkingLevel });
      expect([res.status, res.body.error.code], JSON.stringify(thinkingLevel)).toEqual([400, "bad_request"]);
    }
    expect(await agent()).toEqual(a);
    expect(await edits()).toEqual([]);
  });

  it("persists the sandbox network mode, logs the change, and rejects other values", async () => {
    server = await startSignedIn();
    const a = await agent();
    expect(a.networkMode).toBe("block");
    expect((await patch(a.id, { networkMode: "whitelist" })).body.agent.networkMode).toBe("whitelist");
    expect((await edits()).map((e) => [e.field, e.before, e.after])).toEqual([["networkMode", "block", "whitelist"]]);
    for (const networkMode of [null, "", "ask", "any_site", "packages", "ON", true, {}]) {
      const res = await patch(a.id, { networkMode });
      expect([res.status, res.body.error?.code], JSON.stringify(networkMode)).toEqual([400, "bad_request"]);
    }
    expect((await agent()).networkMode).toBe("whitelist");
  });

  it("sends the saved effort to the gateway in existing chats and forks, then restores the provider default", async () => {
    gateway = await startFakeGateway({ bearer: STANDIN, behavior: () => ({ kind: "text", text: "ok" }) });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const a = await agent();
    const catalog = (await s().client.get("/api/models")).body;
    expect(catalog.models).toEqual([]); // Fake gateway has no configured providers.
    const id = await chat(s());
    await patch(a.id, { model: "gpt-6.1-terra", thinkingLevel: "high" });
    await say(s(), id, "one");
    await settled(s(), id, 1);
    expect(gateway.seen[0]!.json.model).toBe("gpt-6.1-terra");
    expect(gateway.seen[0]!.json.reasoning.effort).toBe("high");
    const reply = (await detail(s(), id)).messages.find((m) => m.role === "assistant")!;
    const fork = (await s().client.post(`/api/sessions/${id}/fork`, { messageId: reply.id })).body.session.id;
    await patch(a.id, { thinkingLevel: "low" });
    await say(s(), fork, "two");
    await settled(s(), fork, 1);
    expect(gateway.seen[1]!.json.reasoning.effort).toBe("low");
    await say(s(), id, "three");
    await settled(s(), id, 2);
    expect(gateway.seen[2]!.json.reasoning.effort).toBe("low");
    await patch(a.id, { thinkingLevel: "off" });
    await say(s(), id, "four");
    await settled(s(), id, 3);
    expect(gateway.seen[3]!.json.reasoning).toBeUndefined();
  });

  it("changes the name, the model and the default profile, announces the agent and logs each change", async () => {
    server = await startSignedIn();
    const a = await agent();
    const stream = await s().sse("/api/stream");
    const res = await patch(a.id, { name: "  Dot  ", model: " gpt-6.1-sol-deep ", defaultProfile: "strict" });
    expect(res.status).toBe(200);
    expect(res.body.agent).toMatchObject({
      id: a.id,
      name: "Dot",
      model: "gpt-6.1-sol-deep",
      defaultProfile: "strict",
    });
    const seen = await stream.waitFor((e) => e.event === "agent.upserted" && e.data.agent.name === "Dot");
    expect(seen.data.agent.model).toBe("gpt-6.1-sol-deep");
    stream.close?.();
    expect(await agent()).toMatchObject({ name: "Dot", model: "gpt-6.1-sol-deep", defaultProfile: "strict" });

    const log = await edits();
    expect(log).toHaveLength(3);
    expect(log.map((e) => [e.field, e.before, e.after]).sort()).toEqual(
      [
        ["defaultProfile", a.defaultProfile, "strict"],
        ["model", a.model, "gpt-6.1-sol-deep"],
        ["name", a.name, "Dot"],
      ].sort(),
    );
    for (const e of log)
      expect(e).toMatchObject({
        author: "user",
        target: { kind: "agent", agentId: a.id },
        id: expect.any(String),
        at: expect.any(Number),
      });
  });

  it("null puts the agent back on the default model, and the change is logged", async () => {
    server = await startSignedIn();
    const a = await agent();
    expect(a.model).toBeNull();
    await patch(a.id, { model: "gpt-6-luna" });
    expect((await agent()).model).toBe("gpt-6-luna");
    expect((await patch(a.id, { model: null })).body.agent.model).toBeNull();
    expect((await edits()).map((e) => [e.field, e.before, e.after])).toEqual([
      ["model", "gpt-6-luna", null],
      ["model", null, "gpt-6-luna"],
    ]);
  });

  it("lists the faux choices with the default first, without injecting saved agent models", async () => {
    server = await startSignedIn();
    const a = await agent();
    const before = (await s().client.get("/api/models")).body;
    expect(before.default).toBe("gpt-6.1-sol");
    expect(before.models.slice(0, 5)).toEqual([
      before.default,
      "gpt-6.2-sol",
      "gpt-6.1-terra",
      "gpt-6-sol",
      "gpt-6-astra",
    ]);
    expect(before.models).toContain("gpt-6-luna");
    expect(new Set(before.models).size).toBe(before.models.length);
    await patch(a.id, { model: "my-own-model" });
    expect((await s().client.get("/api/models")).body.models).not.toContain("my-own-model");
    expect((await s().client.raw("GET", "/api/models", { cookie: false })).status).toBe(401);
  });

  it("logs only what changed, newest first, and honours the limit", async () => {
    server = await startSignedIn();
    const a = await agent();
    await patch(a.id, { name: "One" });
    await patch(a.id, { name: "One" }); // nothing changed
    await patch(a.id, { model: a.model }); // same
    await patch(a.id, { name: "Two" });
    await patch(a.id, { avatar: "bot:sprout" }); // a look, not a setting
    const log = await edits();
    expect(log.map((e) => [e.field, e.before, e.after])).toEqual([
      ["name", "One", "Two"],
      ["name", a.name, "One"],
    ]);
    expect((await edits("?limit=1")).map((e) => e.after)).toEqual(["Two"]);
    for (const bad of ["0", "201", "x", "1.5", "-1"])
      expect((await s().client.get(`/api/edits?limit=${bad}`)).status, bad).toBe(400);
    expect((await s().client.get("/api/edits?limit=200")).status).toBe(200);
    expect((await s().client.raw("GET", "/api/edits", { cookie: false })).status).toBe(401);
  });

  it("refuses a bad name, model or profile and changes nothing", async () => {
    server = await startSignedIn();
    const a = await agent();
    for (const body of [
      { name: "" },
      { name: "   " },
      { name: "x".repeat(41) },
      { name: 5 },
      { model: "" },
      { model: "two words" },
      { model: "m".repeat(101) },
      { model: 5 },
      { defaultProfile: "reckless" },
      { defaultProfile: 3 },
      { name: "Fine", model: "" },
    ]) {
      const res = await patch(a.id, body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([400, "bad_request"]);
    }
    expect(await agent()).toEqual(a);
    expect(await edits()).toEqual([]);
    expect((await patch(a.id, { name: "x".repeat(40) })).status).toBe(200);
    expect((await patch("agt_ghost", { name: "X" })).status).toBe(404);
    expect((await s().client.call("PATCH", `/api/agents/${a.id}`, { csrf: false, body: { name: "X" } })).status).toBe(
      403,
    );
  });

  it("the home chat is retitled with the name; a chat the agent's new default profile applies to starts with it", async () => {
    server = await startSignedIn();
    const a = await agent();
    await patch(a.id, { name: "Dot", defaultProfile: "strict" });
    expect((await detail(s(), a.homeSessionId)).session.title).toBe("Dot");
    const id = await chat(s());
    expect((await detail(s(), id)).session.profile).toBe("strict");
  });

  it("the model chosen for the agent is the one the gateway is asked for, from the next call on", async () => {
    gateway = await startFakeGateway({ bearer: STANDIN, behavior: () => ({ kind: "text", text: "ok" }) });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const a = await agent();
    const id = await chat(s());
    await say(s(), id, "one");
    await settled(s(), id, 1);
    expect(gateway.seen[0]!.json).toMatchObject({ model: "gpt-6.1-sol" }); // no choice: the default
    await patch(a.id, { model: "my-own-model" });
    await say(s(), id, "two");
    await settled(s(), id, 2);
    expect(gateway.seen[1]!.json).toMatchObject({ model: "my-own-model" });
    await patch(a.id, { model: null });
    await say(s(), id, "three");
    await settled(s(), id, 3);
    expect(gateway.seen[2]!.json).toMatchObject({ model: "gpt-6.1-sol" });
  });

  it("the new name is what the model is told it is called, from the next call on", async () => {
    gateway = await startFakeGateway({ bearer: STANDIN, behavior: () => ({ kind: "text", text: "ok" }) });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const a = await agent();
    const id = await chat(s());
    await say(s(), id, "one");
    await settled(s(), id, 1);
    expect(gateway.seen[0]!.raw).toContain(`You are ${a.name} (agent id ${a.id})`);
    await patch(a.id, { name: "Quokka" });
    await say(s(), id, "two");
    await settled(s(), id, 2);
    const raw = gateway.seen[1]!.raw;
    expect(raw.lastIndexOf("You are Quokka (agent id")).toBeGreaterThan(raw.lastIndexOf(`You are ${a.name} (agent id`));
  });
});

it("validates, persists, logs and restores agent connector limits", async () => {
  server = await startSignedIn();
  const a = await agent();
  expect(a.allowedConnectorIds).toBeNull();
  for (const value of [false, "all", {}, [null], [12], [""], [" "]]) {
    expect((await patch(a.id, { name: "Changed", allowedConnectorIds: value })).status).toBe(400);
  }
  expect(await agent()).toEqual(a);
  expect((await patch(a.id, { allowedConnectorIds: ["con_a", "con_a"] })).body.agent.allowedConnectorIds).toEqual([
    "con_a",
  ]);
  const { dir, totpSecret } = server;
  const cookie = s().client.cookie;
  await s().stop();
  server = Object.assign(await startTestServer({ dir }), { totpSecret });
  s().client.cookie = cookie;
  expect((await agent()).allowedConnectorIds).toEqual(["con_a"]);
  expect((await patch(a.id, { allowedConnectorIds: [] })).body.agent.allowedConnectorIds).toEqual([]);
  expect((await patch(a.id, { allowedConnectorIds: null })).body.agent.allowedConnectorIds).toBeNull();
  expect((await edits()).filter((e) => e.field === "allowedConnectorIds")).toHaveLength(3);
});
