import type { BrowserStateResponse, Takeover } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type BrowserServer, startBrowserServer } from "./helpers/browser.ts";
import { until } from "./helpers/client.ts";
import { startTestServer } from "./helpers/server.ts";
import { chat, detail, say, sessions, settled } from "./helpers/sessions.ts";
import { callTool } from "./helpers/web.ts";

let server: BrowserServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const start = async (browser: { takeoverIdleMs?: number; maxWindows?: number } = {}): Promise<BrowserServer> =>
  (server = await startBrowserServer({ config: { browser: { mode: "cdp", cdpUrl: "http://fake:9223", ...browser } } }));
const open = (s: BrowserServer, id: string, url = "https://bank.example/login") =>
  callTool(s, id, "browser_open", { url });
const state = async (s: BrowserServer, id: string) =>
  (await s.client.get(`/api/sessions/${id}/browser`)).body as BrowserStateResponse;
const begin = (s: BrowserServer, id: string) => s.client.post(`/api/sessions/${id}/browser/takeover`, {});
const end = (s: BrowserServer, tid: string, action: "done" | "cancel", note?: string) =>
  s.client.post(`/api/takeovers/${tid}/end`, { action, ...(note !== undefined ? { note } : {}) });
const tk = (s: BrowserServer) => s.host.plane.browser!.takeovers;
const tstore = (s: BrowserServer) => s.host.plane.store.db;
const row = (s: BrowserServer, id: string) =>
  tstore(s).get<{ status: string; note: string | null; notified_at: number | null; requested_by: string }>(
    "SELECT status, note, notified_at, requested_by FROM takeovers WHERE id = ?",
    id,
  )!;
const takeoverMessages = async (s: BrowserServer, id: string) =>
  (await detail(s, id)).messages.filter((m) => m.role === "takeover");

async function request(s: BrowserServer, id: string, reason = "Sign in to the bank"): Promise<Takeover> {
  await open(s, id);
  const r = await callTool(s, id, "browser_takeover", { reason });
  expect(r.last!.isError).toBe(false);
  const t = (await state(s, id)).takeover;
  expect(t).not.toBeNull();
  return t!;
}

describe("the agent asks for a takeover", () => {
  it("puts a card in the chat and the global list, and the session waits for the user", async () => {
    const s = await start();
    const id = await chat(s);
    const t = await request(s, id);
    expect(t).toMatchObject({
      sessionId: id,
      requestedBy: "agent",
      reason: "Sign in to the bank",
      status: "pending",
      url: "https://bank.example/login",
    });
    const [m] = await takeoverMessages(s, id);
    expect(m!.takeover).toMatchObject({ id: t.id, status: "pending" });
    expect(m!.text).toContain("Sign in to the bank");
    expect(
      tk(s)
        .list()
        .map((x) => x.id),
    ).toEqual([t.id]);
    const body = await state(s, id);
    expect(body).toMatchObject({
      window: true,
      url: "https://bank.example/login",
      viewport: { width: 1000, height: 700 },
    });
    // The chat reaches the PWA's list with its open takeover.
    expect((await sessions(s)).find((x) => x.id === id)!.browser?.takeover?.id).toBe(t.id);
    await until(
      async () => ((await sessions(s)).find((x) => x.id === id)!.status === "waiting_for_user" ? true : undefined),
      10_000,
      "the session to wait for the user",
    );
    // A second request does not stack another card.
    await callTool(s, id, "browser_takeover", { reason: "again" });
    expect(await takeoverMessages(s, id)).toHaveLength(1);
    expect(tk(s).list()).toHaveLength(1);
  });

  it("refuses to take over when there is no window", async () => {
    const s = await start();
    const id = await chat(s);
    const r = await callTool(s, id, "browser_takeover", { reason: "Sign in" });
    expect(r.last!.isError).toBe(true);
    expect((await begin(s, id)).status).toBe(409);
    expect((await begin(s, id)).body.error.code).toBe("no_window");
  });

  it("is declined: nobody is asked again, and the agent is told it was NOT done", async () => {
    const s = await start();
    const id = await chat(s);
    const t = await request(s, id);
    const res = await end(s, t.id, "cancel");
    expect(res.status).toBe(200);
    expect(res.body.takeover).toMatchObject({ status: "cancelled" });
    expect((await detail(s, id)).runs.filter((r) => r.status !== "completed" && r.status !== "failed")).toEqual([]);
    await until(() => row(s, t.id).notified_at !== null || undefined, 5_000, "the agent to be told");
    expect((await takeoverMessages(s, id))[0]!.takeover).toMatchObject({ status: "cancelled" });
    // Ended: the open list is empty and a new request makes a new card.
    expect(tk(s).list()).toEqual([]);
    await callTool(s, id, "browser_takeover", { reason: "Try once more" });
    expect(await takeoverMessages(s, id)).toHaveLength(2);
  });

  it("expires after 24 hours, also when the server was down", async () => {
    const s = await start();
    const id = await chat(s);
    const t = await request(s, id);
    const clock = s.clock;
    const { dir } = s;
    const cookie = s.client.cookie;
    await s.stop();
    clock.advance(25 * 3_600_000);
    const next = await startTestServer({ dir, clock, browserDriver: s.fake });
    server = Object.assign(next, { totpSecret: "", fake: s.fake });
    next.client.cookie = cookie;
    expect(row(server, t.id)).toMatchObject({ status: "cancelled", note: "The request expired." });
    expect(tk(server).list()).toEqual([]);
    await until(() => row(server!, t.id).notified_at !== null || undefined, 5_000, "the agent to be told");
  });

  it("expires while the server runs", async () => {
    const s = await start();
    const id = await chat(s);
    const t = await request(s, id);
    s.clock.advance(25 * 3_600_000);
    await tk(s).sweep();
    expect(row(s, t.id)).toMatchObject({ status: "cancelled", note: "The request expired." });
    expect((await end(s, t.id, "done")).status).toBe(409);
  });
});

describe("you take over", () => {
  it("makes dialogs wait for you and lifts the navigation guard, and puts everything back when you finish", async () => {
    const s = await start();
    const id = await chat(s);
    const t = await request(s, id);
    const started = await begin(s, id);
    expect(started.status).toBe(200);
    expect(started.body.takeover).toMatchObject({ id: t.id, status: "active" });
    expect(s.fake.wins.get(id)!.dialogMode).toBe("ask");
    expect(s.fake.wins.get(id)!.guard).toBeNull();
    expect(await state(s, id)).toMatchObject({ takeover: { id: t.id, status: "active" } });
    expect(s.host.plane.browser!.service.inUse()).toBe(true);
    const done = await end(s, t.id, "done", "Signed in");
    expect(done.body.takeover).toMatchObject({ status: "done", note: "Signed in" });
    expect(s.fake.wins.get(id)!.dialogMode).toBe("auto");
    expect(s.fake.wins.get(id)!.guard).not.toBeNull();
    // What you opened is outside content from now on.
    expect(JSON.parse(s.host.plane.store.getSessionRow(id)!.taint)).toContain("external");
  });

  it("starts a run for the agent when you finish what it asked for, with your note", async () => {
    const s = await start();
    const id = await chat(s);
    const t = await request(s, id);
    await until(
      async () => (await detail(s, id)).runs.every((r) => r.status !== "running" && r.status !== "queued") || undefined,
      10_000,
      "the first run to end",
    );
    const before = (await detail(s, id)).runs.length;
    await begin(s, id);
    const done = await end(s, t.id, "done", "Signed in as ada");
    expect(done.status).toBe(200);
    await until(
      async () => ((await detail(s, id)).runs.length > before ? true : undefined),
      10_000,
      "a run for the agent",
    );
    const d = await detail(s, id);
    expect(
      d.messages.some((m) => m.role === "notice" && m.text === "You finished in the browser: Signed in as ada"),
    ).toBe(true);
    // Idempotent: finishing again changes nothing.
    expect((await end(s, t.id, "done")).status).toBe(409);
    expect((await detail(s, id)).runs.length).toBe(before + 1);
  });

  it("makes the agent's browser calls wait until you finish", async () => {
    const s = await start();
    const id = await chat(s);
    const t = await request(s, id);
    await begin(s, id);
    let finished = false;
    const call = callTool(s, id, "browser_snapshot", {}).then((r) => ((finished = true), r));
    await new Promise((r) => setTimeout(r, 700));
    expect(finished).toBe(false);
    await end(s, t.id, "cancel");
    const r = await call;
    expect(r.last!.isError).toBe(false);
  });

  it("lets you use the browser without being asked, and tells the agent afterwards", async () => {
    const s = await start();
    const id = await chat(s);
    await open(s, id);
    const res = await begin(s, id);
    expect(res.body.takeover).toMatchObject({ requestedBy: "user", status: "active" });
    const before = (await detail(s, id)).runs.length;
    await end(s, res.body.takeover.id, "done");
    const d = await detail(s, id);
    expect(d.runs.length).toBe(before); // no model turn
    expect(d.messages.some((m) => m.role === "notice" && m.text === "You used the browser.")).toBe(true);
    await until(() => row(s, res.body.takeover.id).notified_at !== null || undefined, 5_000, "the agent to be told");
  });

  it("keeps a finished manual takeover on its original message version", async () => {
    const s = await start();
    const id = await chat(s);
    await open(s, id);
    const original = (await settled(s, id, 1)).messages.find((m) => m.role === "user")!;
    const started = await begin(s, id);
    expect(started.status).toBe(200);
    const takeoverId = started.body.takeover.id;
    expect((await end(s, takeoverId, "done")).status).toBe(200);
    await until(() => row(s, takeoverId).notified_at !== null || undefined, 5_000, "the agent to be told");
    expect((await takeoverMessages(s, id)).map((m) => m.takeover)).toEqual([
      expect.objectContaining({ id: takeoverId, status: "done" }),
    ]);

    const edited = await s.client.post(`/api/sessions/${id}/edit`, { messageId: original.id, text: "Different task" });
    expect(edited.status).toBe(200);
    await settled(s, id, 1);
    expect(await takeoverMessages(s, id)).toEqual([]);

    const previous = await s.client.post(`/api/sessions/${id}/version`, {
      messageId: edited.body.messageId,
      to: "prev",
    });
    expect(previous.status).toBe(200);
    expect((await takeoverMessages(s, id)).map((m) => m.takeover)).toEqual([
      expect.objectContaining({ id: takeoverId, status: "done" }),
    ]);
  });

  it("retains a finished takeover in the shared prefix and pages it with its outcome", async () => {
    const s = await start();
    const id = await chat(s);
    await open(s, id);
    await settled(s, id, 1);
    const started = await begin(s, id);
    expect(started.status).toBe(200);
    const takeoverId = started.body.takeover.id;
    expect((await end(s, takeoverId, "done")).status).toBe(200);
    await say(s, id, "A later task");
    const later = (await settled(s, id, 2)).messages.find((m) => m.text === "A later task")!;
    const edited = await s.client.post(`/api/sessions/${id}/edit`, { messageId: later.id, text: "Another later task" });
    expect(edited.status).toBe(200);
    await settled(s, id, 2);

    const firstPage = await s.host.plane.adapter.views.view(id, { limit: 2 });
    expect(firstPage.items.some((m) => m.role === "takeover")).toBe(false);
    const secondPage = await s.client.get(`/api/sessions/${id}/transcript?before=${firstPage.before}`);
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.items).toContainEqual(
      expect.objectContaining({ takeover: expect.objectContaining({ id: takeoverId, status: "done" }) }),
    );
  });

  it("answers a second start with the active takeover", async () => {
    const s = await start();
    const id = await chat(s);
    const t = await request(s, id);
    await begin(s, id);
    const again = await begin(s, id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_active");
    expect(again.body.takeover).toMatchObject({ id: t.id, status: "active" });
  });

  it("ends by itself after 15 idle minutes (here: shortened), and the agent is told it was not done", async () => {
    const s = await start({ takeoverIdleMs: 300 });
    const id = await chat(s);
    const t = await request(s, id);
    await begin(s, id);
    await until(() => (row(s, t.id).status === "cancelled" ? true : undefined), 5_000, "the idle timeout");
    expect(row(s, t.id).note).toMatch(/^Timed out/);
    expect(s.fake.wins.get(id)!.dialogMode).toBe("auto");
    await until(() => row(s, t.id).notified_at !== null || undefined, 5_000, "the agent to be told");
  });

  it("ends when the window closes under you", async () => {
    const s = await start();
    const id = await chat(s);
    const t = await request(s, id);
    await begin(s, id);
    s.fake.drop(id, "crashed");
    await until(() => (row(s, t.id).status === "cancelled" ? true : undefined), 5_000, "the cancel");
    expect(row(s, t.id).note).toBe("The browser window closed.");
  });

  it("keeps a waiting request across a browser restart, and opens the page again when you start it", async () => {
    const s = await start();
    const id = await chat(s);
    const t = await request(s, id);
    s.fake.restart();
    expect(row(s, t.id).status).toBe("pending");
    expect(s.fake.hasWindow(id)).toBe(false);
    const res = await begin(s, id);
    expect(res.status).toBe(200);
    expect(s.fake.hasWindow(id)).toBe(true);
    expect(s.fake.wins.get(id)!.url).toBe("https://bank.example/login");
  });

  it("cancels a takeover whose session is deleted, and leaves nothing behind", async () => {
    const s = await start();
    const id = await chat(s);
    const t = await request(s, id);
    await begin(s, id);
    expect((await s.client.call("DELETE", `/api/sessions/${id}`)).status).toBe(200);
    expect(tstore(s).get("SELECT id FROM takeovers WHERE id = ?", t.id)).toBeUndefined();
    expect(tk(s).list()).toEqual([]);
    expect(s.fake.hasWindow(id)).toBe(false);
  });
});
