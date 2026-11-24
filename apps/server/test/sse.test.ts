import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { SESSION_COOKIE } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { SseReader, until, ViewReader } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const chat = async (s: TestServer) => (await s.client.post("/api/sessions", {})).body.session.id as string;
const say = (s: TestServer, id: string, text: string) =>
  s.client.post(`/api/sessions/${id}/messages`, { requestId: crypto.randomUUID(), text });
const idle = (s: TestServer, id: string, runs: number) =>
  until(async () => {
    const d = (await s.client.get(`/api/sessions/${id}`)).body;
    return d.runs.length >= runs && d.runs.every((r: { status: string }) => r.status === "completed") ? d : undefined;
  });

describe("session stream", () => {
  it("starts with a snapshot of the Conversation View, without SSE ids, and the content type is event-stream", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const res = await server.client.raw("GET", `/api/sessions/${id}/stream`);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const sse = new SseReader(res, `/api/sessions/${id}/stream`);
    const first = await sse.waitFor(() => true);
    expect(first.event).toBe("snapshot");
    expect(first.id).toBeUndefined();
    expect(first.data.type).toBe("snapshot");
    expect(first.data.rev).toBe(0);
    expect(typeof first.data.epoch).toBe("string");
    expect(first.data.view.version).toBe(2);
    expect(first.data.view.session.id).toBe(id);
    expect(first.data.view.items).toEqual([]);
    expect(first.data.view.runs).toEqual([]);
    expect(first.data.view.before).toBeNull();
    await sse.close();
  });

  it("then sends patches in rev order that fold into the same view the API returns", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const view = new ViewReader(await server.sse(`/api/sessions/${id}/stream`));
    await view.waitForView(() => true);
    await say(server, id, "one [len=400]");
    const done = await idle(server, id, 1);
    const folded = await view.waitForView(
      (v) =>
        v.runs[0]?.status === "completed" && v.items.some((i) => i.role === "assistant" && i.status === "complete"),
    );
    const patches = view.sse.events.filter((e) => e.event === "patch");
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.every((e) => e.id === undefined)).toBe(true);
    expect(patches.map((e) => e.data.rev)).toEqual(patches.map((_, n) => n + 1));
    expect(folded.items.map((i) => [i.id, i.role, i.text])).toEqual(
      done.messages.map((m: { id: string; role: string; text: string }) => [m.id, m.role, m.text]),
    );
    expect(folded.runs).toEqual(done.runs);
    await view.close();
  });

  it("starts every connection with a fresh snapshot (a reconnect never replays)", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await say(server, id, "before");
    await idle(server, id, 1);
    const a = await server.sse(`/api/sessions/${id}/stream`, { "last-event-id": "3" });
    const snap = await a.waitFor((e) => e.event === "snapshot");
    expect(snap.data.view.items.map((i: { role: string }) => i.role)).toEqual(["user", "assistant"]);
    await a.close();
  });

  it("restarts into a new epoch with the same transcript", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await say(server, id, "before");
    await idle(server, id, 1);
    const first = await server.sse(`/api/sessions/${id}/stream`);
    const a = await first.waitFor((e) => e.event === "snapshot");
    await first.close();
    const { dir, totpSecret, clock } = server;
    const cookie = server.client.cookie;
    await server.stop();
    const { startTestServer } = await import("./helpers/server.ts");
    server = Object.assign(await startTestServer({ dir, clock }), { totpSecret });
    server.client.cookie = cookie;
    const second = await server.sse(`/api/sessions/${id}/stream`);
    const b = await second.waitFor((e) => e.event === "snapshot");
    expect(b.data.epoch).not.toBe(a.data.epoch);
    expect(b.data.view.items).toEqual(a.data.view.items);
    await second.close();
  });

  it("sends session.removed and ends when the session is deleted", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const sse = await server.sse(`/api/sessions/${id}/stream`);
    await sse.waitFor((e) => e.event === "snapshot");
    expect((await server.client.call("DELETE", `/api/sessions/${id}`)).status).toBeLessThan(300);
    await sse.waitFor((e) => e.event === "session.removed");
    await until(() => sse.ended, 5_000, "stream end");
  });

  it("pings so proxies keep the connection open", async () => {
    server = await startSignedIn({ config: { ssePingMs: 120 } });
    const id = await chat(server);
    const sse = await server.sse(`/api/sessions/${id}/stream`);
    await sse.waitFor((e) => e.event === "ping", 3_000);
    await sse.close();
  });

  it("requires the cookie and a known session", async () => {
    server = await startSignedIn();
    expect((await server.client.get("/api/sessions/nope/stream")).status).toBe(404);
    server.client.cookie = undefined;
    expect((await server.client.get("/api/stream")).status).toBe(401);
  });
});

describe("over a real socket", () => {
  it("stops listening for a client that went away", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const http = serve({ fetch: server.host.plane.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((r) => http.on("listening", () => r()));
    const port = (http.address() as AddressInfo).port;
    try {
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/stream`, {
        headers: { cookie: `${SESSION_COOKIE}=${server.client.cookie}` },
        signal: ac.signal,
      });
      const sse = new SseReader(res, `/api/sessions/${id}/stream`);
      await sse.waitFor((e) => e.event === "snapshot");
      const views = server.host.plane.adapter.views;
      expect(views.watchers(id)).toBe(1);
      ac.abort();
      await until(() => views.watchers(id) === 0, 5_000, "subscriber cleanup");
    } finally {
      (http as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => http.close(() => r()));
    }
  });
});
