// The companion agent (issue 08): the agent companion clients talk to, defaulting to the default agent, with its home chat
// in the global snapshot and GET /api/agents, and companion.changed on every change.
import type { AgentsResponse, Companion } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startSignedIn, type TestServer } from "./helpers/server.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const s = (): TestServer => server!;
const agents = async (): Promise<AgentsResponse> => (await s().client.get("/api/agents")).body;
const pick = (agentId: string) => s().client.call("PUT", "/api/settings/companion", { body: { agentId } });
const helper = () =>
  s().host.plane.adapter.createAgent({ name: "Helper", avatar: "bot:round", instructions: "Help." }).agent;

describe("companion agent", () => {
  it("defaults to the default agent and its home chat, in GET /api/agents and the snapshot", async () => {
    server = await startSignedIn();
    const list = await agents();
    const def = list.agents.find((a) => a.id === list.defaultAgentId)!;
    expect(list.companion).toEqual({ agentId: def.id, homeSessionId: def.homeSessionId });
    expect(def.homeSessionId).not.toBe("");
    const stream = await s().sse("/api/stream");
    const snapshot = await stream.waitFor((e) => e.event === "snapshot");
    expect(snapshot.data.companion).toEqual(list.companion);
    await stream.close();
  });

  it("changes to another agent, answers it, and tells every client", async () => {
    server = await startSignedIn();
    const other = helper();
    const stream = await s().sse("/api/stream");
    await stream.waitFor((e) => e.event === "snapshot");
    const res = await pick(other.id);
    expect(res.status).toBe(200);
    const expected: Companion = { agentId: other.id, homeSessionId: other.homeSessionId };
    expect(res.body).toEqual({ companion: expected });
    const changed = await stream.waitFor((e) => e.event === "companion.changed");
    expect(changed.data.companion).toEqual(expected);
    expect(changed.id).toBeDefined();
    expect((await agents()).companion).toEqual(expected);
    await stream.close();
  });

  it("refuses an unknown agent with unknown_agent and keeps the current one", async () => {
    server = await startSignedIn();
    const before = (await agents()).companion;
    const res = await pick("agt_missing");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("unknown_agent");
    expect((await pick("")).body.error.code).toBe("unknown_agent");
    expect((await agents()).companion).toEqual(before);
  });

  it("falls back to the default agent when the companion agent is deleted", async () => {
    server = await startSignedIn();
    const other = helper();
    await pick(other.id);
    const stream = await s().sse("/api/stream");
    await stream.waitFor((e) => e.event === "snapshot");
    expect((await s().client.call("DELETE", `/api/agents/${other.id}`)).status).toBe(200);
    const list = await agents();
    const def = list.agents.find((a) => a.id === list.defaultAgentId)!;
    const fallback = { agentId: def.id, homeSessionId: def.homeSessionId };
    expect(list.companion).toEqual(fallback);
    const changed = await stream.waitFor((e) => e.event === "companion.changed");
    expect(changed.data.companion).toEqual(fallback);
    await stream.close();
  });

  it("deleting another agent leaves the companion alone", async () => {
    server = await startSignedIn();
    const a = helper();
    const b = helper();
    await pick(a.id);
    await s().client.call("DELETE", `/api/agents/${b.id}`);
    expect((await agents()).companion.agentId).toBe(a.id);
  });
});
