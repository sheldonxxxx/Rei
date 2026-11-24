import type { Message } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  askApproval,
  decide,
  effects,
  pending,
  sessionOf,
  setProfile,
  todo,
  tool,
  waitPending,
} from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, childrenOf, detail, homeChat, say, settled } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const roles = (d: { messages: Message[] }) => d.messages.map((m) => m.role);

/** A parent that spawns a child whose brief is `brief`; resolves with the child's id once it exists. */
async function spawn(s: TestServer, parent: string, brief: string): Promise<string> {
  await say(s, parent, `[spawn: ${brief}]`);
  const child = await until(async () => (await childrenOf(s, parent))[0], 10_000, "the child session");
  return child.id;
}

describe("approvals of spawned sessions", () => {
  it("blocks in the child, shows the approval in the child and in the parent chat, and the original call runs once and reports back", async () => {
    server = await startSignedIn();
    const parent = homeChat(server);
    await setProfile(server, parent, "strict");
    const child = await spawn(server, parent, todo("milk"));
    const [ap] = await waitPending(server, child);
    expect(ap).toMatchObject({ sessionId: child, tool: "demo_add_todo", status: "pending" });
    expect(effects(server)).toHaveLength(0);
    const c = await detail(server, child);
    expect(c.session.status).toBe("waiting_for_user");
    expect(c.session.pendingApprovals).toBe(1);
    expect(roles(c)).toContain("approval");
    const p = await detail(server, parent);
    const inParent = p.messages.filter((m) => m.role === "approval");
    expect(inParent).toHaveLength(1);
    expect(inParent[0]!.approval!.id).toBe(ap!.id);

    const res = await decide(server, ap!.id, { decision: "approve" });
    expect(res.status).toBe(200);
    await settled(server, child, 1);
    expect(effects(server)).toHaveLength(1);
    expect(effects(server)[0]).toMatchObject({ tool: "demo_add_todo", sessionId: child });
    const after = await detail(server, child);
    expect(after.session.status).toBe("completed");
    expect(after.session.pendingApprovals).toBe(0);
    // The child's card shows the decision; the parent's copy leaves its chat once decided.
    expect(after.messages.find((m) => m.role === "approval")!.approval!.status).toBe("approved");
    const pAfter = await until(
      async () => {
        const d = await detail(server!, parent);
        return d.messages.some((m) => m.approval?.status === "pending") ? undefined : d;
      },
      10_000,
      "the parent card to leave",
    );
    // The original child run reports its result to the parent once.
    await until(
      async () => (await detail(server!, parent)).messages.filter((m) => m.role === "report").length === 1,
      10_000,
      "the original run’s report",
    );
    expect(pAfter.session.pendingApprovals).toBe(0);
  });

  it("starts with the parent's profile, including yolo", async () => {
    server = await startSignedIn();
    const parent = homeChat(server);
    await setProfile(server, parent, "strict");
    const child = await spawn(server, parent, "small job");
    expect((await sessionOf(server, child)).profile).toBe("strict");

    const p2 = server.host.plane.adapter.createAgent({ name: "Helper", avatar: "H", instructions: "Help." }).session.id;
    await setProfile(server, p2, "yolo");
    const c2 = await spawn(server, p2, tool("demo_send_message", { to: "ana@example.test", text: "hi" }));
    expect((await sessionOf(server, c2)).profile).toBe("yolo");
    await settled(server, c2);
    expect(await pending(server)).toEqual([]);
    expect(effects(server)).toMatchObject([{ tool: "demo_send_message", sessionId: c2 }]);
  });

  it("a child's taint reaches the parent in the report", async () => {
    server = await startSignedIn();
    const parent = homeChat(server);
    expect((await sessionOf(server, parent)).taint).toEqual([]);
    const child = await spawn(server, parent, tool("demo_read_inbox", {}));
    await settled(server, child);
    expect((await sessionOf(server, child)).taint.sort()).toEqual(["external", "private"]);
    await settled(server, parent, 2);
    expect((await sessionOf(server, parent)).taint.sort()).toEqual(["external", "private"]);
    // So now the parent cannot send freely.
    await askApproval(server, parent, tool("demo_send_message", { to: "ana@example.test", text: "hi" }));
    const [ap] = await waitPending(server, parent);
    expect(ap!.lengths).toEqual(["once"]);
  });

  it("deleting a session cancels its pending approvals", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await setProfile(server, a, "strict");
    await askApproval(server, a, todo("milk"));
    expect(await pending(server)).toHaveLength(1);
    const g = await server.sse("/api/stream");
    await g.waitFor((e) => e.event === "snapshot");
    const res = await server.client.call("DELETE", `/api/sessions/${a}`);
    expect(res.status).toBe(200);
    expect(await pending(server)).toEqual([]);
    expect(effects(server)).toHaveLength(0);
    expect(
      server.host.plane.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE session_id = ?", a)!.n,
    ).toBe(0);
    await g.close();
  });

  it("deleting a spawned child removes its approval card from the parent chat", async () => {
    server = await startSignedIn();
    const parent = homeChat(server);
    await setProfile(server, parent, "strict");
    const child = await spawn(server, parent, todo("milk"));
    await waitPending(server, child);
    expect((await detail(server, parent)).messages.filter((m) => m.role === "approval")).toHaveLength(1);
    const res = await server.client.call("DELETE", `/api/sessions/${child}`);
    expect(res.status).toBe(200);
    expect(await pending(server)).toEqual([]);
    const p = await detail(server, parent);
    expect(p.session.pendingApprovals).toBe(0);
    expect(p.messages.filter((m) => m.role === "approval" && m.approval?.status === "pending")).toEqual([]);
  });
});
