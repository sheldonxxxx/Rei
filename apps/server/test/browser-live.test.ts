import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { LIVE_CLOSE_DENIED, type LiveServerMessage, SESSION_COOKIE } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { SESSION_TTL_MS } from "../src/auth/service.ts";
import { totpCode } from "../src/auth/totp.ts";
import { gotoUrl, parseClientMessage } from "../src/browser/live.ts";
import { attachBrowserLive, cookieValue, sameOrigin } from "../src/node/browser-live.ts";
import { type BrowserServer, startBrowserServer } from "./helpers/browser.ts";
import { until } from "./helpers/client.ts";
import { PASSWORD } from "./helpers/server.ts";
import { chat } from "./helpers/sessions.ts";
import { callTool } from "./helpers/web.ts";

let server: BrowserServer | undefined;
let http: ReturnType<typeof serve> | undefined;
let closeLive: (() => void) | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  closeLive?.();
  (http as { closeAllConnections?: () => void } | undefined)?.closeAllConnections?.();
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
  http = closeLive = undefined;
  await server?.destroy();
  server = undefined;
});

async function boot(publicUrl?: string): Promise<{ s: BrowserServer; port: number; id: string }> {
  server = await startBrowserServer();
  const s = server;
  const plane = s.host.plane;
  http = serve({ fetch: plane.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => http!.once("listening", r));
  const port = (http!.address() as AddressInfo).port;
  closeLive = attachBrowserLive(http as never, {
    live: plane.browser!.live,
    auth: plane.auth,
    store: plane.store,
    log: s.host.log,
    publicUrl,
  });
  const id = await chat(s);
  await callTool(s, id, "browser_open", { url: "https://bank.example/login" });
  return { s, port, id };
}

interface Client {
  ws: WebSocket;
  texts: LiveServerMessage[];
  frames: Buffer[];
  closed: Promise<number>;
  send(message: unknown): void;
}
function connect(port: number, id: string, headers: Record<string, string>): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${id}/browser/live`, { headers });
  sockets.push(ws);
  const c: Client = {
    ws,
    texts: [],
    frames: [],
    closed: new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
      ws.on("error", () => resolve(-1));
    }),
    send: (m) => ws.send(JSON.stringify(m)),
  };
  ws.on("message", (data, isBinary) =>
    isBinary ? c.frames.push(data as Buffer) : c.texts.push(JSON.parse(data.toString()) as LiveServerMessage),
  );
  return c;
}
const authed = (s: BrowserServer, port: number): Record<string, string> => ({
  cookie: `${SESSION_COOKIE}=${s.client.cookie}`,
  origin: `http://127.0.0.1:${port}`,
});
async function androidLogin(s: BrowserServer): Promise<{ headers: Record<string, string>; deviceId: string }> {
  s.clock.advance(31_000);
  const headers = { "x-rei-client": "android/1" };
  const response = await s.host.plane.app.request("/api/auth/login", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, totpCode: await totpCode(s.totpSecret, s.clock.now()) }),
  });
  expect(response.status).toBe(200);
  const { token, deviceId } = (await response.json()) as { token: string; deviceId: string };
  return { deviceId, headers: { ...headers, authorization: `Bearer ${token}` } };
}
const msgs = (c: Client, type: string) => c.texts.filter((t) => t.type === type);
const waitFor = (fn: () => boolean) => until(() => fn() || undefined, 5_000, "the socket to do it");

describe("the live socket's checks", () => {
  it("closes with 4401 without a cookie, with a bad cookie, from another origin, for an unknown session", async () => {
    const { s, port, id } = await boot();
    const ok = authed(s, port);
    expect(await connect(port, id, { origin: ok.origin! }).closed).toBe(LIVE_CLOSE_DENIED);
    expect(await connect(port, id, { cookie: `${SESSION_COOKIE}=not-a-session`, origin: ok.origin! }).closed).toBe(
      LIVE_CLOSE_DENIED,
    );
    expect(await connect(port, id, { cookie: ok.cookie!, origin: "https://evil.example" }).closed).toBe(
      LIVE_CLOSE_DENIED,
    );
    expect(await connect(port, id, { cookie: ok.cookie! }).closed).toBe(LIVE_CLOSE_DENIED);
    expect(await connect(port, "ses_nope", ok).closed).toBe(LIVE_CLOSE_DENIED);
    // Nothing reached the browser.
    expect(s.fake.count("startScreencast")).toBe(0);
  });

  it("authenticates a device bearer without a cookie or Origin and rejects invalid or expired credentials", async () => {
    const { s, port, id } = await boot();
    const { headers } = await androidLogin(s);
    const native = connect(port, id, headers);
    await waitFor(() => msgs(native, "hello").length === 1);
    native.ws.close(1000);
    expect(await native.closed).toBe(1000);
    await waitFor(() => s.fake.count("stopScreencast") === 1);

    expect(await connect(port, "ses_nope", headers).closed).toBe(LIVE_CLOSE_DENIED);
    const invalid = { ...authed(s, port), authorization: `Bearer ${"x".repeat(43)}` };
    expect(await connect(port, id, invalid).closed).toBe(LIVE_CLOSE_DENIED);
    s.clock.advance(SESSION_TTL_MS);
    expect(await connect(port, id, headers).closed).toBe(LIVE_CLOSE_DENIED);
  });

  it.each(["revocation", "logout"])(
    "disconnects a device's open sockets on %s and rejects reconnects",
    async (action) => {
      const { s, port, id } = await boot();
      const { deviceId, headers } = await androidLogin(s);
      const web = connect(port, id, authed(s, port));
      const native = connect(port, id, headers);
      await waitFor(() => msgs(native, "hello").length === 1 && msgs(web, "hello").length === 1);
      if (action === "logout") {
        const response = await s.host.plane.app.request("/api/auth/logout", { method: "POST", headers });
        expect(response.status).toBe(200);
      } else {
        expect((await s.client.call("DELETE", `/api/devices/${deviceId}`)).status).toBe(200);
      }
      expect(await native.closed).toBe(LIVE_CLOSE_DENIED);
      expect(await connect(port, id, headers).closed).toBe(LIVE_CLOSE_DENIED);
      s.fake.frame(id, new Uint8Array([0xff, 0xd8, 1, 2]));
      await waitFor(() => web.frames.length === 1);
    },
  );

  it("accepts the public host behind a proxy that rewrites Host, from REI_PUBLIC_URL or X-Forwarded-Host", async () => {
    const { s, port, id } = await boot("https://rei.example.ts.net");
    const cookie = authed(s, port).cookie!;
    const viaPublic = connect(port, id, { cookie, origin: "https://rei.example.ts.net" });
    await waitFor(() => msgs(viaPublic, "hello").length === 1);
    const viaForwarded = connect(port, id, {
      cookie,
      origin: "https://proxy.example",
      "x-forwarded-host": "proxy.example",
    });
    await waitFor(() => msgs(viaForwarded, "hello").length === 1);
    expect(await connect(port, id, { cookie, origin: "https://evil.example" }).closed).toBe(LIVE_CLOSE_DENIED);
  });

  it("refuses other upgrades", async () => {
    const { s, port } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/other`, { headers: authed(s, port) });
    sockets.push(ws);
    await new Promise<void>((r) => ws.on("error", () => r()));
  });

  it("parses the cookie and compares origins", () => {
    expect(cookieValue(`a=1; ${SESSION_COOKIE}=abc%20d; b=2`, SESSION_COOKIE)).toBe("abc d");
    expect(cookieValue("a=1", SESSION_COOKIE)).toBeUndefined();
    expect(sameOrigin("https://app.example", "app.example")).toBe(true);
    expect(sameOrigin("https://app.example:8443", "app.example")).toBe(false);
    expect(sameOrigin(undefined, "app.example")).toBe(false);
    expect(sameOrigin("null", "app.example")).toBe(false);
    // Behind a proxy that rewrites Host: the forwarded host or REI_PUBLIC_URL's host is the app's own.
    expect(sameOrigin("https://rei.example.ts.net", "127.0.0.1:8787", "rei.example.ts.net")).toBe(true);
    expect(sameOrigin("https://rei.example.ts.net", "127.0.0.1:8787", "rei.example.ts.net, 10.0.0.1")).toBe(true);
    expect(sameOrigin("https://evil.example", "127.0.0.1:8787", undefined, "rei.example.ts.net")).toBe(false);
    expect(sameOrigin("https://app.example", undefined, "")).toBe(false);
  });
});

describe("the live view", () => {
  it("says hello with the real viewport first, then streams frames, and shares one screencast between viewers", async () => {
    const { s, port, id } = await boot();
    const a = connect(port, id, authed(s, port));
    await waitFor(() => a.texts.length > 0);
    expect(a.texts[0]).toEqual({
      type: "hello",
      viewport: { width: 1000, height: 700 },
      url: "https://bank.example/login",
      title: "bank.example",
      control: false,
    });
    await waitFor(() => s.fake.count("startScreencast") === 1);
    s.fake.frame(id, new Uint8Array([0xff, 0xd8, 1, 2]));
    await waitFor(() => a.frames.length === 1);
    expect([...a.frames[0]!]).toEqual([0xff, 0xd8, 1, 2]);
    // A second viewer gets the newest frame at once, from the same screencast.
    const b = connect(port, id, authed(s, port));
    await waitFor(() => b.frames.length === 1);
    expect(s.fake.count("startScreencast")).toBe(1);
    s.fake.frame(id, new Uint8Array([0xff, 0xd8, 3]));
    await waitFor(() => a.frames.length === 2 && b.frames.length === 2);
    // The screencast stops with the last viewer.
    a.ws.close();
    await a.closed;
    expect(s.fake.count("stopScreencast")).toBe(0);
    b.ws.close();
    await b.closed;
    await waitFor(() => s.fake.count("stopScreencast") === 1);
  });

  it("forwards page and viewport changes, and says when the window is gone", async () => {
    const { s, port, id } = await boot();
    const a = connect(port, id, authed(s, port));
    await waitFor(() => a.texts.length > 0);
    s.fake.emit({ type: "page", key: id, url: "https://bank.example/home", title: "Home" });
    s.fake.emit({ type: "viewport", key: id, width: 800, height: 600 });
    await waitFor(() => msgs(a, "page").length === 1 && msgs(a, "viewport").length === 1);
    expect(msgs(a, "page")[0]).toEqual({ type: "page", url: "https://bank.example/home", title: "Home" });
    expect(msgs(a, "viewport")[0]).toEqual({ type: "viewport", width: 800, height: 600 });
    s.fake.drop(id, "crashed");
    expect(await a.closed).toBe(1000);
    expect(msgs(a, "closed")[0]).toEqual({ type: "closed", reason: "crashed" });
  });

  it("tells a viewer there is no window, and closes", async () => {
    const { s, port } = await boot();
    const other = await chat(s);
    const c = connect(port, other, authed(s, port));
    expect(await c.closed).toBe(1000);
    expect(c.texts).toEqual([{ type: "closed", reason: "no_window" }]);
  });

  it("ignores input unless the session's takeover is active, and honours it then", async () => {
    const { s, port, id } = await boot();
    await callTool(s, id, "browser_takeover", { reason: "Sign in" });
    const { headers } = await androidLogin(s);
    const c = connect(port, id, headers);
    await waitFor(() => c.texts.length > 0);
    c.send({ type: "mouse", action: "down", x: 10, y: 10, button: "left", clickCount: 1 });
    c.send({ type: "key", action: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 });
    await new Promise((r) => setTimeout(r, 150));
    expect(s.fake.inputs.get(id) ?? []).toEqual([]); // pending: not yours yet

    await s.client.post(`/api/sessions/${id}/browser/takeover`, {});
    await waitFor(() => msgs(c, "control").length === 1);
    expect(msgs(c, "control")[0]).toEqual({ type: "control", control: true });
    c.send({ type: "mouse", action: "move", x: 5, y: 5, button: "left", clickCount: 0 });
    c.send({ type: "mouse", action: "down", x: 12.4, y: 20.6, button: "left", clickCount: 1 });
    c.send({ type: "mouse", action: "up", x: 12.4, y: 20.6, button: "left", clickCount: 1 });
    c.send({ type: "key", action: "down", key: "Enter", code: "Enter", text: "\r", modifiers: 0 });
    c.send({ type: "wheel", x: 1, y: 1, dx: 0, dy: 40 });
    await waitFor(() => (s.fake.inputs.get(id) ?? []).length === 5);
    expect((s.fake.inputs.get(id) ?? []).map((m) => m.type)).toEqual(["mouse", "mouse", "mouse", "key", "wheel"]);
    // Garbage is dropped.
    c.send({ type: "mouse", action: "down", x: "no", y: 1, button: "left", clickCount: 1 });
    c.ws.send("not json");
    await new Promise((r) => setTimeout(r, 100));
    expect(s.fake.inputs.get(id)).toHaveLength(5);

    // Control is taken away when the takeover ends.
    const t = (await s.client.get(`/api/sessions/${id}/browser`)).body.takeover;
    await s.client.post(`/api/takeovers/${t.id}/end`, { action: "cancel" });
    await waitFor(() => msgs(c, "control").length === 2);
    expect(msgs(c, "control")[1]).toEqual({ type: "control", control: false });
    c.send({ type: "mouse", action: "down", x: 1, y: 1, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(s.fake.inputs.get(id)).toHaveLength(5);
  });

  it("Backspace goes back when nothing is being edited, and deletes when a field is focused", async () => {
    const { s, port, id } = await boot();
    await callTool(s, id, "browser_takeover", { reason: "Sign in" });
    const c = connect(port, id, authed(s, port));
    await waitFor(() => c.texts.length > 0);
    await s.client.post(`/api/sessions/${id}/browser/takeover`, {});
    await waitFor(() => msgs(c, "control").length === 1);
    const bs = (action: "down" | "up") =>
      c.send({ type: "key", action, key: "Backspace", code: "Backspace", modifiers: 0 });

    s.fake.focusedFieldValue = null;
    bs("down");
    bs("up");
    await waitFor(() => s.fake.count("navigate") === 1);
    expect(s.fake.inputs.get(id) ?? []).toEqual([]); // not forwarded as a key

    s.fake.focusedFieldValue = { role: "textbox", name: "Name" };
    bs("down");
    bs("up");
    await waitFor(() => (s.fake.inputs.get(id) ?? []).length === 2);
    expect(s.fake.count("navigate")).toBe(1);
  });

  it("records what you did in a takeover but never what you typed", async () => {
    const { s, port, id } = await boot();
    const started = await s.client.post(`/api/sessions/${id}/browser/takeover`, {});
    const tid = started.body.takeover.id as string;
    const c = connect(port, id, authed(s, port));
    await waitFor(() => c.texts.length > 0);
    s.fake.at = { role: "textbox", name: "Password" };
    c.send({ type: "mouse", action: "down", x: 30, y: 40, button: "left", clickCount: 1 });
    c.send({ type: "mouse", action: "up", x: 30, y: 40, button: "left", clickCount: 1 });
    await waitFor(
      () =>
        s.host.plane.browser!.takeovers.isActive(id) &&
        s.host.plane.store.db.all("SELECT * FROM takeover_acts WHERE takeover_id = ?", tid).length > 0,
    );
    for (const ch of "hunter2!") c.send({ type: "key", action: "down", key: ch, code: "KeyH", text: ch, modifiers: 0 });
    c.send({ type: "text", text: "p4ssw0rd-secret" });
    c.send({ type: "key", action: "down", key: "Enter", code: "Enter", text: "\r", modifiers: 0 });
    await waitFor(() => (s.fake.inputs.get(id) ?? []).length >= 2 + 8 + 2);
    s.fake.emit({ type: "page", key: id, url: "https://bank.example/home", title: "Home" });
    await s.client.post(`/api/takeovers/${tid}/end`, { action: "done", note: "Signed in" });
    const acts = s.host.plane.store.db.all<{ kind: string; detail: string }>(
      "SELECT kind, detail FROM takeover_acts WHERE takeover_id = ? ORDER BY seq",
      tid,
    );
    expect(acts.map((a) => a.kind)).toEqual(["click", "type", "navigate"]);
    expect(JSON.parse(acts[0]!.detail)).toEqual({ x: 30, y: 40, element: { role: "textbox", name: "Password" } });
    expect(JSON.parse(acts[1]!.detail)).toMatchObject({ chars: 8 + [..."p4ssw0rd-secret"].length });
    const dump =
      JSON.stringify(s.host.plane.store.db.all("SELECT * FROM takeover_acts")) +
      JSON.stringify((await s.client.get(`/api/sessions/${id}`)).body) +
      s.logs.join("\n");
    for (const secret of ["hunter2", "p4ssw0rd"]) expect(dump).not.toContain(secret);
  });

  it("passes a select pick, a dialog answer, navigation and an address to the browser", async () => {
    const { s, port, id } = await boot();
    await s.client.post(`/api/sessions/${id}/browser/takeover`, {});
    const c = connect(port, id, authed(s, port));
    await waitFor(() => c.texts.length > 0);
    // The picker is offered to the viewer and its answer applied.
    s.fake.emit({
      type: "select",
      key: id,
      options: [
        { label: "Red", value: "r", selected: true },
        { label: "Green", value: "g", selected: false },
      ],
      multiple: false,
    });
    await waitFor(() => msgs(c, "select").length === 1);
    c.send({ type: "select", values: ["g"] });
    await waitFor(() => s.fake.selected.length === 1);
    expect(s.fake.selected[0]).toEqual(["g"]);
    s.fake.emit({
      type: "dialog",
      key: id,
      kind: "confirm",
      message: "Sure?",
      defaultPrompt: null,
      handled: false,
      accepted: false,
    });
    await waitFor(() => msgs(c, "dialog").length === 1);
    c.send({ type: "dialog", accept: true });
    await waitFor(() => s.fake.dialogs.length === 1);
    expect(s.fake.dialogs[0]).toEqual({ key: id, accept: true });
    c.send({ type: "nav", action: "reload" });
    c.send({ type: "goto", url: "example.org/path" });
    c.send({ type: "goto", url: "javascript:alert(1)" });
    await waitFor(() => s.fake.count("goto") === 2 && s.fake.count("navigate") === 1);
    expect(s.fake.calls).toContain(`goto ${id} https://example.org/path`);
    expect(s.fake.calls.some((x) => x.includes("javascript"))).toBe(false);
  });

  it("does not show a select or a dialog to viewers when nobody is in control", async () => {
    const { s, port, id } = await boot();
    const c = connect(port, id, authed(s, port));
    await waitFor(() => c.texts.length > 0);
    s.fake.emit({ type: "select", key: id, options: [], multiple: false });
    s.fake.emit({
      type: "dialog",
      key: id,
      kind: "alert",
      message: "x",
      defaultPrompt: null,
      handled: false,
      accepted: false,
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(msgs(c, "select")).toEqual([]);
    expect(msgs(c, "dialog")).toEqual([]);
  });
});

describe("client messages", () => {
  it("accepts only well-formed ones, with sizes bounded", () => {
    expect(parseClientMessage('{"type":"mouse","action":"move","x":1,"y":2,"button":"left","clickCount":0}')).toEqual({
      type: "mouse",
      action: "move",
      x: 1,
      y: 2,
      button: "left",
      clickCount: 0,
    });
    expect(
      parseClientMessage('{"type":"key","action":"down","key":"Enter","code":"Enter","text":"\\r","modifiers":0}'),
    ).toEqual({ type: "key", action: "down", key: "Enter", code: "Enter", text: "\r", modifiers: 0 });
    expect(parseClientMessage('{"type":"key","action":"down","key":"a","code":"KeyA","modifiers":99}')).toBeUndefined();
    expect(
      parseClientMessage('{"type":"mouse","action":"down","x":1e9,"y":2,"button":"left","clickCount":1}'),
    ).toBeUndefined();
    expect(parseClientMessage('{"type":"text","text":""}')).toBeUndefined();
    expect(parseClientMessage(`{"type":"text","text":"${"x".repeat(20_000)}"}`)).toBeUndefined();
    expect(parseClientMessage('{"type":"select","values":[1]}')).toBeUndefined();
    expect(parseClientMessage('{"type":"nope"}')).toBeUndefined();
    expect(parseClientMessage("[]")).toBeUndefined();
  });

  it("turns an address into an http(s) URL and nothing else", () => {
    expect(gotoUrl("example.org")).toBe("https://example.org/");
    expect(gotoUrl("http://example.org/a?b=1")).toBe("http://example.org/a?b=1");
    expect(gotoUrl("localhost:8080/x")).toBe("https://localhost:8080/x");
    expect(gotoUrl("javascript:alert(1)")).toBeUndefined();
    expect(gotoUrl("file:///etc/passwd")).toBeUndefined();
    expect(gotoUrl("https://user:pw@example.org/")).toBeUndefined();
    expect(gotoUrl("")).toBeUndefined();
  });
});
