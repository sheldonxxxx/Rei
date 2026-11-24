import type { NotifyPayload, Trigger } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DROP_AFTER_MS, PRESENCE_MS, RETRY_DELAYS_MS } from "../src/notify/service.ts";
import type { TriggerFields } from "../src/triggers/spec.ts";
import { setProfile, todo, waitPending } from "./helpers/approvals.ts";
import { type BrowserServer, startBrowserServer } from "./helpers/browser.ts";
import { until } from "./helpers/client.ts";
import { STANDIN, startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, childrenOf, detail, homeChat, say, settled } from "./helpers/sessions.ts";
import { callTool } from "./helpers/web.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const rows = (s: TestServer, state = "pending") =>
  s.host.plane.store.db
    .all<{ request_id: string; session_id: string; payload: string }>(
      "SELECT request_id, session_id, payload FROM outbox WHERE kind = 'notify' AND state = ? ORDER BY id",
      state,
    )
    .map((r) => ({
      requestId: r.request_id,
      sessionId: r.session_id,
      payload: JSON.parse(r.payload) as NotifyPayload,
    }));

describe("fresh database schema", () => {
  it("makes the notification tables", async () => {
    server = await startSignedIn();
    const cols = (t: string) =>
      server!.host.plane.store.db.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
    expect(cols("push_subscriptions")).toEqual(
      expect.arrayContaining(["endpoint", "p256dh", "auth", "label", "created_at", "last_ok_at", "failures"]),
    );
    expect(cols("notification_settings")).toEqual(expect.arrayContaining(["app_url"]));
    expect(cols("notify_deliveries")).toEqual(
      expect.arrayContaining(["outbox_id", "destination", "state", "attempts", "next_attempt_at"]),
    );
  });
});

describe("notification events", () => {
  it("writes a deduplicated row, with the path of the session, in the transaction it announces", async () => {
    server = await startSignedIn();
    const store = server.host.plane.store;
    const input = { event: "trigger_report" as const, sessionId: "ses_x", title: "T", body: "a\n\n  b", dedupe: "k1" };
    store.tx(() => {
      store.queueNotify(input);
      store.queueNotify(input);
    });
    store.queueNotify(input);
    expect(rows(server)).toHaveLength(1);
    expect(rows(server)[0]!.payload).toEqual({
      event: "trigger_report",
      sessionId: "ses_x",
      title: "T",
      body: "a b",
      path: "#/s/ses_x",
    });
    // Rolled back with the thing it announces.
    expect(() =>
      store.tx(() => {
        store.queueNotify({ ...input, dedupe: "k2" });
        throw new Error("boom");
      }),
    ).toThrow();
    expect(rows(server)).toHaveLength(1);
    // Long bodies are cut.
    store.queueNotify({ ...input, dedupe: "k3", body: "x".repeat(500) });
    expect(rows(server)[1]!.payload.body.length).toBe(200);
  });

  it("approval: when an approval becomes pending, once", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await setProfile(server, id, "standard");
    await setProfile(server, id, "strict");
    await say(server, id, todo("milk"));
    const [ap] = await waitPending(server, id);
    const list = rows(server);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ requestId: `notify:approval:${ap!.id}`, sessionId: id });
    expect(list[0]!.payload).toMatchObject({
      event: "approval",
      title: "Needs your approval",
      body: ap!.summary,
      path: `#/s/${id}`,
    });
    // The second prompt queues while the first approval is pending.
    await say(server, id, todo("milk"));
    expect(rows(server)).toHaveLength(1);
  });

  it("session_done: when a spawned session's report is delivered to its parent", async () => {
    server = await startSignedIn();
    const parent = homeChat(server);
    await say(server, parent, "[spawn: small job]");
    const child = await until(async () => (await childrenOf(server!, parent))[0], 10_000, "the child");
    await settled(server, child.id, 1);
    const done = await until(
      () => rows(server!).find((r) => r.payload.event === "session_done"),
      10_000,
      "the session_done row",
    );
    expect(done.payload).toMatchObject({
      event: "session_done",
      sessionId: parent,
      title: child.title,
      path: `#/s/${parent}`,
    });
    expect(done.payload.body.length).toBeGreaterThan(0);
    // It points at the report's message in the parent chat, which the parent's transcript shows under that id.
    expect(done.payload.messageId).toMatch(/^a:/);
    const id = done.payload.messageId;
    await until(async () => (await detail(server!, parent)).messages.some((m) => m.id === id), 10_000, "that message");
    expect(done.requestId).toMatch(/^notify:session_done:report:/);
    expect(rows(server).filter((r) => r.payload.event === "session_done")).toHaveLength(1);
  });

  describe("triggers", () => {
    const plane = () => server!.host.plane;
    const T = () => plane().triggers;
    const home = () => plane().store.getAgent(plane().store.defaultAgentId()!)!.homeSessionId;
    let n = 0;
    const make = (over: Partial<TriggerFields>): Trigger =>
      T().store.create({
        agentId: plane().store.defaultAgentId()!,
        createdBySessionId: null,
        fields: {
          name: `Trigger ${++n}`,
          start: { kind: "schedule", schedule: { kind: "daily", times: ["09:00"], timeZone: "UTC" } },
          action: { kind: "prompt", prompt: "hello" },
          landing: "new",
          report: "on_change",
          latenessMinutes: 120,
          catchUp: "once",
          overlap: "skip",
          profile: "standard",
          allow: [],
          ...over,
        },
      });
    const fireAt = (t: Trigger): void => T().scheduler.tick(T().store.row(t.id)!.next_fire_at! + 60_000);

    it("trigger_report: a report line", async () => {
      server = await startSignedIn();
      const t = make({ action: { kind: "notify", message: "Water the plants" } });
      fireAt(t);
      const list = rows(server).filter((r) => r.payload.event === "trigger_report");
      expect(list).toHaveLength(1);
      expect(list[0]!.payload).toMatchObject({
        title: t.name,
        body: "Water the plants",
        sessionId: home(),
        path: `#/s/${home()}`,
      });
    });

    it("trigger_failed, then trigger_paused after three failures in a row", async () => {
      server = await startSignedIn();
      const t = make({ action: { kind: "skill", skill: "gone" } });
      for (let i = 0; i < 3; i++) fireAt(t);
      await T().runner.idle();
      await settled(server, home(), 4);
      const failed = rows(server).filter((r) => r.payload.event === "trigger_failed");
      expect(failed).toHaveLength(3);
      expect(failed[0]!.payload).toMatchObject({ title: t.name, sessionId: home() });
      expect(failed[0]!.payload.body).toContain("gone");
      const paused = rows(server).filter((r) => r.payload.event === "trigger_paused");
      expect(paused).toHaveLength(1);
      expect(paused[0]!.payload).toMatchObject({ title: t.name });
      expect(paused[0]!.payload.body).toContain("Paused");
    });
  });
});

describe("takeover event", () => {
  let browser: BrowserServer | undefined;
  afterEach(async () => {
    await browser?.destroy();
    browser = undefined;
  });
  it("is written when the agent asks, with the reason", async () => {
    browser = await startBrowserServer({ config: { browser: { mode: "cdp", cdpUrl: "http://fake:9223" } } });
    const id = await chat(browser);
    await callTool(browser, id, "browser_open", { url: "https://bank.example/login" });
    await callTool(browser, id, "browser_takeover", { reason: "Sign in to the bank" });
    await callTool(browser, id, "browser_takeover", { reason: "again" });
    const list = rows(browser).filter((r) => r.payload.event === "takeover");
    expect(list).toHaveLength(1);
    expect(list[0]!.payload).toMatchObject({
      title: "Needs you in the browser",
      body: "Sign in to the bank",
      sessionId: id,
      path: `#/s/${id}`,
    });
    // Taking over by yourself does not notify you.
    const own = await chat(browser);
    await callTool(browser, own, "browser_open", { url: "https://bank.example/login" });
    expect((await browser.client.post(`/api/sessions/${own}/browser/takeover`, {})).status).toBe(200);
    expect(rows(browser).filter((r) => r.payload.event === "takeover")).toHaveLength(1);
  });
});

// ---- the worker and the API, against a fake gateway ----------------------------------------------------------------

interface Call {
  method: string;
  path: string;
  body: any;
  auth: string | null;
}
class FakeNotifyGateway {
  calls: Call[] = [];
  down = false;
  pushResult: (endpoint: string) => unknown = () => ({ ok: true });
  fetch: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError("fetch failed");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      body,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    if (url.pathname === "/notify/webpush/key") return json({ publicKey: "BPublicKey" });
    if (url.pathname === "/notify/webpush/send") return json(this.pushResult(body.subscription.endpoint));
    if (url.pathname === "/notify/fcm/send") return json(this.pushResult(body.token));
    return json({ error: { code: "not_found", message: "no" } }, 404);
  };
  sent(path: string): Call[] {
    return this.calls.filter((c) => c.path === path);
  }
}

const sub = (n: number) => ({
  subscription: {
    endpoint: `https://fcm.googleapis.com/fcm/send/dev${n}`,
    keys: {
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
      auth: "tBHItJI5svbpez7KI4CCXg",
    },
  },
  label: `Device ${n}`,
});

async function start(gw: FakeNotifyGateway) {
  server = await startSignedIn({ gatewayUrl: "http://gateway.test", fetchImpl: gw.fetch });
  return server;
}
const queue = (
  s: TestServer,
  over: Partial<{ event: NotifyPayload["event"]; messageId: string; title: string; body: string; dedupe: string }> = {},
) => {
  const store = s.host.plane.store;
  store.tx(() =>
    store.queueNotify({
      event: "trigger_report",
      sessionId: "ses_abc",
      title: "Morning brief",
      body: "3 things to look at",
      dedupe: crypto.randomUUID(),
      ...over,
    }),
  );
};
const deliver = (s: TestServer) => s.host.plane.notifications.deliver();
const state = (s: TestServer, id: string) =>
  s.host.plane.store.db.get<{ state: string }>("SELECT state FROM outbox WHERE request_id = ?", id)?.state;

describe("Firebase delivery", () => {
  it("registers and rotates the Android channel, redacts previews, and retires an unregistered token", async () => {
    const gw = new FakeNotifyGateway();
    server = await startSignedIn({
      gatewayUrl: "http://gateway.test",
      fetchImpl: gw.fetch,
      config: { fcmEnabled: true },
    });
    const s = server;
    const device = (await s.client.get("/api/auth/state")).body.deviceId;
    const path = "/api/devices/current/channels";
    const initial = await s.client.post(path, { kind: "fcm", token: "test-initial-token" });
    expect(initial.body.channel).toMatchObject({ kind: "fcm", state: "active" });
    const rotated = await s.client.post(path, { kind: "fcm", token: "test-current-token" });
    const channels = s.host.plane.notifications.channels(device);
    expect(channels.map((channel) => channel.id)).toEqual([rotated.body.channel.id]);
    await s.client.call("PUT", "/api/notifications/preview", { body: { preview: false } });
    queue(s, { messageId: "message-for-notification", body: "private preview" });
    await deliver(s);
    expect(gw.sent("/notify/fcm/send").map((call) => call.body)).toMatchObject([
      {
        token: "test-current-token",
        data: {
          deviceId: device,
          sessionId: "ses_abc",
          messageId: "message-for-notification",
          body: "A scheduled task has a report.",
        },
      },
    ]);
    gw.pushResult = () => ({ ok: false, gone: true, status: 404 });
    queue(s);
    await deliver(s);
    expect(s.host.plane.notifications.channels(device)).toEqual([]);
  });
});

describe("the App API", () => {
  it("needs a session, and the CSRF header on writes", async () => {
    const gw = new FakeNotifyGateway();
    const s = await start(gw);
    const all = [
      ["GET", "/api/push/key"],
      ["GET", "/api/notifications"],
      ["POST", "/api/presence"],
      ["POST", "/api/push/subscriptions"],
      ["DELETE", "/api/push/subscriptions"],
      ["PUT", "/api/notifications/preview"],
      ["POST", "/api/notifications/test"],
    ] as const;
    for (const [m, p] of all)
      expect(
        (await s.client.call(m, p, { cookie: false, ...(m === "GET" ? {} : { body: {} }) })).status,
        `${m} ${p}`,
      ).toBe(401);
    for (const [m, p] of all.filter(([m]) => m !== "GET")) {
      const r = await s.client.call(m, p, { csrf: false, body: {} });
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.body.error.code).toBe("csrf");
    }
    expect(gw.calls).toHaveLength(0);
  });

  it("gives the push key from the gateway, with the stand-in", async () => {
    const gw = new FakeNotifyGateway();
    const s = await start(gw);
    const r = await s.client.get("/api/push/key");
    expect(r.body).toEqual({ publicKey: "BPublicKey" });
    expect(gw.calls[0]).toMatchObject({ method: "GET", path: "/notify/webpush/key", auth: `Bearer ${STANDIN}` });
  });

  it("says so when there is no gateway", async () => {
    server = await startSignedIn();
    const r = await server.client.get("/api/push/key");
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("gateway_unavailable");
  });

  it("subscribes (upsert by endpoint), counts devices, unsubscribes, and records the app origin", async () => {
    const gw = new FakeNotifyGateway();
    const s = await start(gw);
    expect(
      (await s.client.post("/api/push/subscriptions", sub(1), { headers: { origin: "https://ai.example.com" } }))
        .status,
    ).toBe(204);
    expect((await s.client.post("/api/push/subscriptions", { ...sub(1), label: "iPhone · Safari" })).status).toBe(204);
    expect((await s.client.post("/api/push/subscriptions", sub(2))).status).toBe(204);
    expect((await s.client.get("/api/notifications")).body).toEqual({
      devices: 2,
      preview: true,
    });
    const db = s.host.plane.store.db;
    expect(
      db.get<{ label: string }>(
        "SELECT label FROM push_subscriptions WHERE endpoint = ?",
        sub(1).subscription.endpoint,
      )!.label,
    ).toBe("iPhone · Safari");
    expect(db.get<{ app_url: string | null }>("SELECT app_url FROM notification_settings")!.app_url).toBe(
      "https://ai.example.com",
    );
    expect(
      (await s.client.call("DELETE", "/api/push/subscriptions", { body: { endpoint: sub(1).subscription.endpoint } }))
        .status,
    ).toBe(204);
    expect((await s.client.get("/api/notifications")).body.devices).toBe(1);
  });

  it("validates subscriptions and presence", async () => {
    const gw = new FakeNotifyGateway();
    const s = await start(gw);
    for (const body of [
      {},
      { ...sub(1), label: "" },
      { subscription: { endpoint: "http://insecure.example/x", keys: sub(1).subscription.keys }, label: "x" },
      {
        subscription: { endpoint: sub(1).subscription.endpoint, keys: { p256dh: "not base64!", auth: "abc" } },
        label: "x",
      },
      { subscription: { endpoint: sub(1).subscription.endpoint }, label: "x" },
    ]) {
      const r = await s.client.post("/api/push/subscriptions", body);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("bad_request");
    }
    expect((await s.client.call("DELETE", "/api/push/subscriptions", { body: {} })).status).toBe(400);
    expect((await s.client.post("/api/presence", { visible: "yes" })).status).toBe(400);
    expect((await s.client.post("/api/presence", { visible: true })).status).toBe(204);
  });

  it("sends a test to every subscribed device, and says when none are configured", async () => {
    const gw = new FakeNotifyGateway();
    const s = await start(gw);
    const none = await s.client.post("/api/notifications/test", {});
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("no_destinations");
    await s.client.post("/api/push/subscriptions", sub(1));
    expect((await s.client.post("/api/notifications/test", {})).status).toBe(204);
    expect(gw.sent("/notify/webpush/send")).toHaveLength(1);
    expect(JSON.parse(gw.sent("/notify/webpush/send")[0]!.body.payload)).toMatchObject({ title: "Rei" });
    // Not through the outbox, and presence does not hold it back.
    expect(rows(s)).toHaveLength(0);
    await s.client.post("/api/presence", { visible: true });
    expect((await s.client.post("/api/notifications/test", {})).status).toBe(204);
  });
});

describe("delivery", () => {
  it("sends notifications to every subscribed device", async () => {
    const gw = new FakeNotifyGateway();
    const s = await start(gw);
    await s.client.post("/api/push/subscriptions", sub(1), { headers: { origin: "https://ai.example.com" } });
    await s.client.post("/api/push/subscriptions", sub(2));
    queue(s, { event: "approval", title: "Needs your approval", body: "Send an email to Sam" });
    await deliver(s);
    const pushes = gw.sent("/notify/webpush/send");
    expect(pushes.map((c) => c.body.subscription.endpoint).sort()).toEqual([
      sub(1).subscription.endpoint,
      sub(2).subscription.endpoint,
    ]);
    expect(JSON.parse(pushes[0]!.body.payload)).toEqual({
      event: "approval",
      sessionId: "ses_abc",
      title: "Needs your approval",
      body: "Send an email to Sam",
      path: "#/s/ses_abc",
    });
    expect(pushes[0]!.body).toMatchObject({ urgency: "high", ttl: 86_400 });
    expect(rows(s)).toHaveLength(0);
    expect(rows(s, "delivered")).toHaveLength(1);

    queue(s, { event: "trigger_failed", title: "Morning brief", body: "Couldn't read the calendar" });
    await deliver(s);
    expect(gw.sent("/notify/webpush/send")).toHaveLength(4);
    // A notification never carries a way to decide anything.
    for (const c of gw.calls) expect(JSON.stringify(c.body ?? "")).not.toMatch(/approve|deny|actions/i);
  });

  it("hides previews in push payloads when asked", async () => {
    const gw = new FakeNotifyGateway();
    const s = await start(gw);
    await s.client.post("/api/devices/current/channels", { kind: "webpush", subscription: sub(1).subscription });
    await s.client.post("/api/devices/current/channels", { kind: "apns", token: "apns-token" });
    expect((await s.client.call("PUT", "/api/notifications/preview", { body: { preview: "no" } })).status).toBe(400);
    const off = await s.client.call("PUT", "/api/notifications/preview", { body: { preview: false } });
    expect(off.body.preview).toBe(false);
    queue(s, { event: "approval", title: "Needs your approval", body: "Send an email to Sam" });
    await deliver(s);
    const pushes = gw.sent("/notify/webpush/send");
    // Only the Web Push channel is sent to: an APNs channel has no adapter yet.
    expect(pushes).toHaveLength(1);
    expect(JSON.parse(pushes[0]!.body.payload)).toMatchObject({
      title: "Needs your approval",
      body: "An agent is waiting for your approval.",
    });
    expect(JSON.stringify(gw.calls)).not.toContain("Send an email");

    await s.client.call("PUT", "/api/notifications/preview", { body: { preview: true } });
    queue(s, { event: "trigger_report", title: "Brief", body: "Three meetings today", dedupe: "k2" });
    await deliver(s);
    expect(JSON.parse(gw.sent("/notify/webpush/send")[1]!.body.payload).body).toBe("Three meetings today");
  });

  it("with nothing to send to, the row is simply done", async () => {
    const gw = new FakeNotifyGateway();
    const s = await start(gw);
    queue(s);
    await deliver(s);
    expect(rows(s)).toHaveLength(0);
    expect(gw.sent("/notify/webpush/send")).toHaveLength(0);
  });

  it("retries after 1 minute, 5 minutes and 30 minutes, only to the destination that failed, then gives up", async () => {
    const gw = new FakeNotifyGateway();
    const s = await start(gw);
    await s.client.post("/api/push/subscriptions", sub(1));
    gw.pushResult = () => ({ ok: false, gone: false, status: 503 });
    queue(s);
    await deliver(s);
    const pushes = () => gw.sent("/notify/webpush/send").length;
    expect(pushes()).toBe(1);
    expect(rows(s)).toHaveLength(1);
    for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
      s.clock.advance(delay - 1_000);
      await deliver(s);
      expect(pushes(), `before retry ${i + 1}`).toBe(i + 1);
      s.clock.advance(1_000);
      await deliver(s);
      expect(pushes(), `retry ${i + 1}`).toBe(i + 2);
    }
    // Four failures: that destination is given up on, and the row is finished.
    expect(rows(s)).toHaveLength(0);
    s.clock.advance(3_600_000);
    await deliver(s);
    expect(pushes()).toBe(4);
  });

  it("drops a notification that is more than 24 hours old", async () => {
    const gw = new FakeNotifyGateway();
    const s = await start(gw);
    await s.client.post("/api/push/subscriptions", sub(1));
    gw.pushResult = () => ({ ok: false, gone: false, status: 500 });
    queue(s, { dedupe: "old" });
    await deliver(s);
    expect(gw.sent("/notify/webpush/send")).toHaveLength(1);
    s.clock.advance(DROP_AFTER_MS + 1_000);
    await deliver(s);
    expect(gw.sent("/notify/webpush/send")).toHaveLength(1);
    expect(state(s, "notify:trigger_report:old")).toBe("dropped");
  });

  it("holds everything back while a window is visible, and sends once it has not been seen for 90 seconds", async () => {
    const gw = new FakeNotifyGateway();
    const s = await start(gw);
    await s.client.post("/api/push/subscriptions", sub(1));
    await s.client.post("/api/presence", { visible: true });
    queue(s);
    await deliver(s);
    expect(gw.sent("/notify/webpush/send")).toHaveLength(0);
    s.clock.advance(PRESENCE_MS - 1_000);
    await deliver(s);
    expect(gw.sent("/notify/webpush/send")).toHaveLength(0);
    s.clock.advance(2_000);
    await deliver(s);
    expect(gw.sent("/notify/webpush/send")).toHaveLength(1);
    // A window that says it is hidden releases at once.
    await s.client.post("/api/presence", { visible: true });
    queue(s);
    await deliver(s);
    expect(gw.sent("/notify/webpush/send")).toHaveLength(1);
    await s.client.post("/api/presence", { visible: false });
    await deliver(s);
    expect(gw.sent("/notify/webpush/send")).toHaveLength(2);
  });

  it("removes a subscription the gateway says is gone", async () => {
    const gw = new FakeNotifyGateway();
    const s = await start(gw);
    await s.client.post("/api/push/subscriptions", sub(1));
    await s.client.post("/api/push/subscriptions", sub(2));
    gw.pushResult = (endpoint) => (endpoint.endsWith("dev1") ? { ok: false, gone: true, status: 410 } : { ok: true });
    queue(s);
    await deliver(s);
    expect((await s.client.get("/api/notifications")).body.devices).toBe(1);
    expect(rows(s)).toHaveLength(0);
    queue(s);
    await deliver(s);
    expect(gw.sent("/notify/webpush/send").map((c) => c.body.subscription.endpoint.slice(-4))).toEqual([
      "dev1",
      "dev2",
      "dev2",
    ]);
  });

  it("keeps rows when the gateway cannot be reached, and delivers them later", async () => {
    const gw = new FakeNotifyGateway();
    const s = await start(gw);
    await s.client.post("/api/push/subscriptions", sub(1));
    gw.down = true;
    queue(s);
    await deliver(s);
    expect(rows(s)).toHaveLength(1);
    s.clock.advance(RETRY_DELAYS_MS[0] + 1_000);
    gw.down = false;
    await deliver(s);
    expect(rows(s)).toHaveLength(0);
    expect(gw.sent("/notify/webpush/send")).toHaveLength(1);
  });
});
