import type { Extension } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { createGuard } from "../src/pi/guard.ts";
import { context } from "../src/pi/trees.ts";
import {
  approve,
  askApproval,
  decide,
  effects,
  pending,
  sayAndSettle,
  setProfile,
  todo,
  tool,
} from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";
import { chat, childrenOf, detail, homeChat, say, settled, stepPayloads, treeOf } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const plane = () => server!.host.plane;

/** Stops the server and starts another on the same folder, signed in with the same cookie. */
async function reboot(
  config: Parameters<typeof startTestServer>[0] extends infer O
    ? O extends { config?: infer C }
      ? C
      : never
    : never = {},
) {
  const old = server!;
  const { dir } = old;
  const cookie = old.client.cookie;
  const { totpSecret } = old;
  await old.stop();
  server = Object.assign(await startTestServer({ dir, config }), { totpSecret });
  server.client.cookie = cookie;
  return server;
}

describe("the guard: the policy is on every conversation", () => {
  const fake = { name: "policy" } as unknown as Extension;
  const other = { name: "other" } as unknown as Extension;

  it("forces the policy into every extension selection it is given, and never lets one remove it", () => {
    const guard = createGuard(fake);
    expect(guard.ensure()).toEqual({});
    expect(guard.ensure({ extensions: null })).toEqual({ extensions: null });
    expect(guard.ensure({ extensions: [] }).extensions).toEqual([fake]);
    expect(guard.ensure({ extensions: [fake, other] }).extensions).toEqual([fake, other]);
    expect(guard.ensure({ extensions: [other] }).extensions).toEqual([other, fake]);
    expect(guard.ensure({ extensions: { add: [other] } }).extensions).toEqual({ add: [other, fake], remove: [] });
    expect(guard.ensure({ extensions: { remove: [fake, other] } }).extensions).toEqual({
      add: [fake],
      remove: [other],
    });
    expect(guard.ensure({ model: "m" } as never)).toEqual({ model: "m" });
  });

  it("every conversation of every tree selects the policy: root, fork and spawned, and a reconfigure keeps it", async () => {
    server = await startSignedIn();
    const a = homeChat(server);
    const d = await sayAndSettle(server, a, "hello");
    const forkRes = await server.client.post(`/api/sessions/${a}/fork`, {
      messageId: d.messages.find((m) => m.role === "assistant")!.id,
    });
    const fork = forkRes.body.session.id as string;
    await say(server, a, "[spawn: small job]");
    const child = (await until(async () => (await childrenOf(server!, a))[0], 10_000, "the child")).id;
    await settled(server, child, 1);

    const trees = new Set([treeOf(server, a), treeOf(server, fork), treeOf(server, child)]);
    expect(trees.size).toBe(2); // the fork shares its source's tree; the child has its own
    for (const id of trees) {
      const tree = await plane().adapter.trees.open(id);
      expect(await tree.guard.audit(tree.harness, context)).toEqual([]);
      for (const sid of tree.sessions.keys()) {
        const agent = await tree.session(sid)!.conv.agent(context);
        expect(agent.extensions.map((e) => e.name)).toContain("policy");
        expect(agent.extensions.at(-1)!.name).toBe("policy"); // last, so it sees the arguments the other hooks settled on
        // A reconfigure that names an explicit list, or removes the policy, still leaves it in.
        await tree.guard.reconfigure(tree.session(sid)!.conv, { extensions: [] }, context);
        expect((await tree.session(sid)!.conv.agent(context)).extensions.map((e) => e.name)).toContain("policy");
        await tree.guard.reconfigure(tree.session(sid)!.conv, { extensions: { remove: [tree.guard.policy] } }, context);
        expect((await tree.session(sid)!.conv.agent(context)).extensions.map((e) => e.name)).toContain("policy");
      }
      expect(await tree.guard.audit(tree.harness, context)).toEqual([]);
    }
  });

  it("fails closed: a conversation that lost the policy refuses outside actions and nothing runs; the audit finds and repairs it", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await sayAndSettle(server, a, "hello");
    const tree = await plane().adapter.trees.open(treeOf(server, a));
    const conv = tree.session(a)!.conv;
    // Bypass the guard on purpose.
    await conv.configure({ extensions: { remove: [tree.guard.policy] } }, context);
    expect((await conv.agent(context)).extensions.map((e) => e.name)).not.toContain("policy");

    // Even in yolo, where the policy would allow it, the tool refuses because the policy did not run.
    await setProfile(server, a, "yolo");
    await sayAndSettle(server, a, tool("demo_send_message", { to: "x@example.test", text: "hi" }));
    await sayAndSettle(server, a, todo("milk"));
    await sayAndSettle(server, a, tool("demo_buy", { item: "book", price: 1 }));
    expect(effects(server)).toEqual([]);
    expect(stepPayloads(server, a).join("\n")).toContain("the approval policy did not run");
    // Inside actions do not need it.
    const list = await sayAndSettle(server, a, "[list]");
    expect(list.messages.at(-1)!.text).toMatch(/Done\./);

    const missing = await tree.guard.audit(tree.harness, context);
    expect(missing).toHaveLength(1);
    expect(await plane().adapter.trees.auditPolicy(tree)).toBe(1);
    expect(server.logs.join("\n")).toContain("policy.missing_on_conversation");
    expect(await tree.guard.audit(tree.harness, context)).toEqual([]);
    await sayAndSettle(server, a, todo("milk"));
    // Yolo allows a write outside, and now it goes through the policy.
    expect(effects(server).map((e) => e.tool)).toEqual(["demo_add_todo"]);
  });

  it("the audit at the start of a tree repairs and logs a conversation without the policy", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await sayAndSettle(server, a, "hello");
    const tree = await plane().adapter.trees.open(treeOf(server, a));
    await tree.session(a)!.conv.configure({ extensions: { remove: [tree.guard.policy] } }, context);
    await reboot();
    expect(server.logs.join("\n")).not.toContain("policy.missing_on_conversation");
    await setProfile(server, a, "strict");
    await askApproval(server, a, todo("milk"));
    expect(server.logs.join("\n")).toContain("policy.missing_on_conversation");
    // It was repaired before the call, so the call was judged, not refused.
    expect(await pending(server)).toHaveLength(1);
    expect(stepPayloads(server, a).join("\n")).not.toContain("the approval policy did not run");
  });
});

describe("restart", () => {
  it("a pending approval survives a restart and approving it afterwards runs the call once", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await setProfile(server, a, "strict");
    await askApproval(server, a, todo("milk"));
    const [before] = await pending(server);
    await reboot();
    const [after] = await pending(server);
    expect(after).toMatchObject({ id: before!.id, status: "pending", tool: "demo_add_todo" });
    expect((await detail(server, a)).session).toMatchObject({ status: "waiting_for_user", pendingApprovals: 1 });
    await approve(server, a);
    expect(effects(server)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(effects(server)).toHaveLength(1);
    expect((await detail(server, a)).session.status).toBe("idle");
  });

  // Long enough that a loaded machine cannot expire the approval before the first check; the wait below outlasts it.
  const TTL = 2_000;
  it("an approval that ran out while the server was down is expired by the sweep at start, and the agent is told", async () => {
    server = await startSignedIn({ config: { approvalTtlMs: TTL } });
    const a = await chat(server);
    await setProfile(server, a, "strict");
    await askApproval(server, a, todo("milk"));
    expect(await pending(server)).toHaveLength(1);
    const old = server;
    await old.stop();
    await new Promise((r) => setTimeout(r, TTL + 300));
    const { dir, totpSecret } = old;
    const cookie = old.client.cookie;
    server = Object.assign(await startTestServer({ dir, config: { approvalTtlMs: TTL } }), { totpSecret });
    server.client.cookie = cookie;
    await until(async () => (await pending(server!)).length === 0, 10_000, "the sweep");
    const d = await settled(server, a);
    expect(d.messages.find((m) => m.role === "approval")!.approval!.status).toBe("expired");
    expect(d.session.status).toBe("idle");
    expect(effects(server)).toEqual([]);
    await until(
      async () =>
        plane().store.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM approvals WHERE notified_at IS NOT NULL AND status = 'expired'",
        )!.n === 1,
      10_000,
      "the agent to be told",
    );
    await sayAndSettle(server, a, "anything new?");
    expect(stepPayloads(server, a).join("\n")).toContain("was expired");
  });

  it("a grant survives a restart", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await setProfile(server, a, "strict");
    await askApproval(server, a, todo("milk"));
    await approve(server, a, { length: "always" });
    await reboot();
    const b = await chat(server);
    await sayAndSettle(server, b, todo("bread"));
    expect(effects(server)).toHaveLength(2);
    expect(await pending(server)).toEqual([]);
  });
});

describe("loop guards", () => {
  it("stops a run that keeps calling the model past maxModelCallsPerRun, before the next call, with a loop_guard error", async () => {
    server = await startSignedIn({ config: { maxModelCallsPerRun: 4 } });
    const a = await chat(server);
    await say(server, a, "[loop]");
    const d = await settled(server, a, 1);
    expect(d.runs[0]!.status).toBe("failed");
    expect(d.runs[0]!.error).toMatchObject({ code: "loop_guard" });
    expect(d.runs[0]!.error!.message).toMatch(/model calls/);
    const calls = plane().store.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM steps WHERE run_id = ? AND type = 'llm.call'",
      d.runs[0]!.id,
    )!.n;
    expect(calls).toBe(4);
    // The session is fine afterwards.
    const next = await sayAndSettle(server, a, "hello again");
    expect(next.runs.at(-1)!.status).toBe("completed");
  });

  it("stops a run that goes on past maxRunMs", async () => {
    server = await startSignedIn({ config: { maxModelCallsPerRun: 0, maxRunMs: 300 } });
    const a = await chat(server);
    await say(server, a, "[loop]");
    const d = await settled(server, a, 1);
    expect(d.runs[0]!.status).toBe("failed");
    expect(d.runs[0]!.error).toMatchObject({ code: "loop_guard" });
    expect(d.runs[0]!.error!.message).toMatch(/time limit/);
    expect(d.runs[0]!.endedAt! - d.runs[0]!.startedAt).toBeLessThan(10_000);
  });

  it("does not count a normal run against the limits", async () => {
    server = await startSignedIn({ config: { maxModelCallsPerRun: 2 } });
    const a = await chat(server);
    const d = await sayAndSettle(server, a, "[list]"); // two model calls: the tool call, the answer
    expect(d.runs[0]!.status).toBe("completed");
  });
});

describe("HTTP", () => {
  it("answers 401 without the cookie and 403 without the CSRF header on every approval, grant and profile endpoint", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await setProfile(server, a, "strict");
    await askApproval(server, a, todo("milk"));
    const [ap] = await pending(server);
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/approvals"],
      ["GET", "/api/grants"],
      ["POST", `/api/approvals/${ap!.id}/decide`, { decision: "deny" }],
      ["DELETE", "/api/grants/grt_x"],
      ["PATCH", `/api/sessions/${a}`, { profile: "yolo" }],
    ];
    for (const [method, path, body] of calls) {
      const r = await server.client.call(method, path, { cookie: false, ...(body ? { body } : {}) });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
    for (const [method, path, body] of calls.filter((c) => c[0] !== "GET")) {
      const r = await server.client.call(method, path, { csrf: false, ...(body ? { body } : {}) });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect(await pending(server)).toHaveLength(1);
    expect(plane().store.getSession(a)!.profile).toBe("strict");
  });

  it("answers not_found, not_pending and bad_request with the contract's codes", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    expect((await decide(server, "apr_missing", { decision: "approve" })).status).toBe(404);
    expect((await decide(server, "apr_missing", { decision: "approve" })).body.error.code).toBe("not_found");
    expect((await server.client.call("DELETE", "/api/grants/grt_missing")).status).toBe(404);
    expect((await server.client.call("DELETE", "/api/grants/grt_missing")).body.error.code).toBe("not_found");

    await setProfile(server, a, "strict");
    await askApproval(server, a, todo("milk"));
    const [ap] = await pending(server);
    const bad = await server.client.post(`/api/approvals/${ap!.id}/decide`, { decision: "maybe" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("bad_request");
    const no = await server.client.post(`/api/approvals/${ap!.id}/decide`, {});
    expect(no.status).toBe(400);
    expect((await decide(server, ap!.id, { decision: "deny" })).status).toBe(200);
    const again = await decide(server, ap!.id, { decision: "approve" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("not_pending");
    const twice = await decide(server, ap!.id, { decision: "deny" });
    expect(twice.status).toBe(409);
  });

  it("sends approval changes on the global stream", async () => {
    server = await startSignedIn();
    const g = await server.sse("/api/stream");
    const snap = await g.waitFor((e) => e.event === "snapshot");
    expect(snap.data.approvals).toEqual([]);
    const a = await chat(server);
    await setProfile(server, a, "strict");
    await askApproval(server, a, todo("milk"));
    const up = await g.waitFor((e) => e.event === "approval.upserted" && e.data.approval.status === "pending");
    expect(up.data.approval).toMatchObject({ sessionId: a, tool: "demo_add_todo" });
    await decide(server, up.data.approval.id, { decision: "deny" });
    await g.waitFor((e) => e.event === "approval.upserted" && e.data.approval.status === "denied");
    await g.close();
    const g2 = await server.sse("/api/stream");
    expect((await g2.waitFor((e) => e.event === "snapshot")).data.approvals).toEqual([]);
    await g2.close();
  });
});
