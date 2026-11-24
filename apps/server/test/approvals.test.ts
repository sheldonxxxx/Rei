import type { Message } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { askApproval, decide, effects, pending, setProfile, tool, waitPending } from "./helpers/approvals.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const store = () => server!.host.plane.store;
const roles = (d: { messages: Message[] }) => d.messages.map((m) => m.role);

describe("D28: block, approve, run once", () => {
  it("blocks a write outside, shows the approval, and runs it exactly once after approval", async () => {
    server = await startSignedIn();
    const sid = await chat(server);
    server.host.plane.store.setProfile(sid, "strict");
    await askApproval(server, sid, tool("demo_add_todo", { text: "milk" }));
    const d = await detail(server, sid);
    expect(effects(server)).toHaveLength(0);
    expect(roles(d)).toEqual(["user", "assistant", "approval"]);
    expect(d.session.status).toBe("waiting_for_user");
    expect(d.session.pendingApprovals).toBe(1);

    const [a] = await pending(server);
    expect(a).toMatchObject({
      sessionId: sid,
      tool: "demo_add_todo",
      connector: "demo",
      operation: "todo.add",
      actionClass: "write_external",
      destination: null,
      status: "pending",
    });
    expect(a!.lengths).toEqual(["once", "session", "agent", "hours", "always"]);
    expect(a!.summary).toBe("Add a to-do: milk");
    expect(JSON.parse(a!.argsPreview)).toEqual({ text: "milk" });
    expect(a!.expiresAt - a!.createdAt).toBe(24 * 3_600_000);
    expect(d.messages[2]!.approval!.id).toBe(a!.id);

    const res = await decide(server, a!.id, { decision: "approve" });
    expect(res.status).toBe(200);
    expect(res.body.approval.status).toBe("approved");
    const after = await settled(server, sid, 1);
    expect(effects(server)).toHaveLength(1);
    expect(effects(server)[0]).toMatchObject({ tool: "demo_add_todo", args: { text: "milk" }, sessionId: sid });
    expect(after.session.status).toBe("idle");
    expect(after.session.pendingApprovals).toBe(0);
    expect(after.messages.find((m) => m.role === "approval")!.approval!.status).toBe("approved");
    expect(after.messages.some((m) => m.role === "notice" && m.text.includes("You approved"))).toBe(false);
    expect(await pending(server)).toEqual([]);

    // The same call again needs a new approval: one-time grants are used up.
    await askApproval(server, sid, tool("demo_add_todo", { text: "milk" }));
    expect(effects(server)).toHaveLength(1);
    expect(await pending(server)).toHaveLength(1);
  });

  it("a new call with different arguments is a new approval and runs nothing", async () => {
    server = await startSignedIn();
    const sid = await chat(server);
    await setProfile(server, sid, "strict");
    await askApproval(server, sid, tool("demo_add_todo", { text: "milk" }));
    const [a] = await pending(server);
    await decide(server, a!.id, { decision: "approve" });
    await settled(server, sid, 1);
    expect(effects(server)).toHaveLength(1);
    await askApproval(server, sid, tool("demo_add_todo", { text: "bread" }));
    expect(effects(server)).toHaveLength(1);
    const [b] = await pending(server);
    expect(b!.id).not.toBe(a!.id);
    expect(JSON.parse(b!.argsPreview)).toEqual({ text: "bread" });
  });

  it("queues a second identical call until the first decision, then asks independently", async () => {
    server = await startSignedIn();
    const sid = await chat(server);
    await setProfile(server, sid, "strict");
    await askApproval(server, sid, tool("demo_add_todo", { text: "milk" }));
    const [first] = await pending(server);
    await say(server, sid, tool("demo_add_todo", { text: "milk" }));
    expect((await pending(server)).map((approval) => approval.id)).toEqual([first!.id]);
    expect(store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals")!.n).toBe(1);
    expect(store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM overlays WHERE kind = 'approval'")!.n).toBe(1);
    await decide(server, first!.id, { decision: "approve" });
    const [second] = await waitPending(server, sid);
    expect(second!.id).not.toBe(first!.id);
    expect(effects(server)).toHaveLength(1);
  });
});
