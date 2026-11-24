// GET /api/glance (issue 12): what a widget shows, in one cheap call with an ETag.
import type { GlanceResponse } from "@rei/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesEtag } from "../src/store/glance.ts";
import { askApproval, pending, setProfile, todo } from "./helpers/approvals.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, homeChat, say, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const s = (): TestServer => server!;
const look = async (): Promise<{ status: number; etag: string | null; body: GlanceResponse }> => {
  const res = await s().client.get("/api/glance");
  return { status: res.status, etag: res.headers.get("etag"), body: res.body };
};

describe("glance", () => {
  it("names the companion agent and starts empty", async () => {
    server = await startSignedIn();
    const { status, body, etag } = await look();
    expect(status).toBe(200);
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const agents = (await s().client.get("/api/agents")).body;
    const def = agents.agents.find((a: { id: string }) => a.id === agents.defaultAgentId);
    expect(body).toEqual({
      companion: { agentId: def.id, name: def.name, avatar: def.avatar, homeSessionId: def.homeSessionId },
      preview: null,
      previewHidden: false,
      running: false,
      pendingApprovals: 0,
      unread: 0,
      nextTrigger: null,
    });
  });

  it("shows the home chat's latest message as plain text and counts unread replies", async () => {
    server = await startSignedIn();
    const home = homeChat(s());
    await say(s(), home, "**Plan** the [trip](https://example.com) please");
    await settled(s(), home);
    const { body } = await look();
    expect(body.unread).toBe(1);
    expect(body.preview).not.toBeNull();
    expect(body.preview).not.toMatch(/\*\*|\]\(/);
    expect(body.preview!.length).toBeLessThanOrEqual(200);
    expect(body.preview).toBe((await detail(s(), home)).session.preview.replace(/\*\*|\[|\]\([^)]*\)/g, ""));
  });

  it("says a run is going in the home chat while one is unfinished there", async () => {
    server = await startSignedIn();
    const home = homeChat(s());
    const runs = s().host.plane.store.runs;
    const real = runs.nonTerminal.bind(runs);
    // A faux run finishes at once, so the registry is held: one unfinished run in the home chat only.
    vi.spyOn(runs, "nonTerminal").mockImplementation((sessionId?: string) =>
      sessionId === home ? ([{ id: "run_held", status: "running" }] as never) : real(sessionId),
    );
    expect((await look()).body.running).toBe(true);
    vi.restoreAllMocks();
    expect((await look()).body.running).toBe(false);
  });

  it("hides the preview when the user hid message text from notifications", async () => {
    server = await startSignedIn();
    const home = homeChat(s());
    await say(s(), home, "secret plans");
    await settled(s(), home);
    expect((await s().client.call("PUT", "/api/notifications/preview", { body: { preview: false } })).status).toBe(200);
    const { body } = await look();
    expect(body.preview).toBeNull();
    expect(body.previewHidden).toBe(true);
  });

  it("counts pending approvals in every session and the unread total across chats", async () => {
    server = await startSignedIn();
    const a = await chat(s());
    await setProfile(s(), a, "strict");
    await askApproval(s(), a, todo("milk"));
    expect((await pending(s())).length).toBe(1);
    const { body } = await look();
    expect(body.pendingApprovals).toBe(1);
    expect(body.unread).toBe((await detail(s(), a)).session.unread);
  });

  it("says when the next trigger runs", async () => {
    server = await startSignedIn();
    const plane = s().host.plane;
    const trigger = plane.triggers.store.create({
      agentId: plane.store.defaultAgentId()!,
      createdBySessionId: null,
      fields: {
        name: "Morning brief",
        start: { kind: "schedule", schedule: { kind: "daily", times: ["09:00"], timeZone: "UTC" } },
        action: { kind: "prompt", prompt: "hello" },
        landing: "new",
        report: "on_change",
        latenessMinutes: 120,
        catchUp: "once",
        overlap: "skip",
        profile: "standard",
        allow: [],
      },
    });
    const { body } = await look();
    expect(body.nextTrigger).toEqual({
      id: trigger.id,
      name: "Morning brief",
      at: plane.triggers.store.row(trigger.id)!.next_fire_at,
    });
  });

  it("answers 304 while nothing changed, and a new ETag once anything does", async () => {
    server = await startSignedIn();
    const first = await look();
    const again = await s().client.raw("GET", "/api/glance", { headers: { "if-none-match": first.etag! } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(first.etag);
    await s().client.call("PUT", "/api/notifications/preview", { body: { preview: false } });
    const changed = await s().client.raw("GET", "/api/glance", { headers: { "if-none-match": first.etag! } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(first.etag);
  });

  it("matches If-None-Match lists, weak tags and *", () => {
    expect(matchesEtag('"a", W/"b"', '"b"')).toBe(true);
    expect(matchesEtag("*", '"x"')).toBe(true);
    expect(matchesEtag('"a"', '"b"')).toBe(false);
    expect(matchesEtag(undefined, '"b"')).toBe(false);
  });
});
