import { afterEach, describe, expect, it } from "vitest";
import { EVENT_LIMITS } from "../src/events/receive.ts";
import { eventBody, eventSender, sign } from "./helpers/events.ts";
import { startTestServer, type TestServer } from "./helpers/server.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const start = async () => {
  server = await startTestServer();
  return eventSender(server);
};
const code = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code;
const rows = () => server!.host.plane.store.db.all<{ type: string; ref: string }>("SELECT type, ref FROM events");

describe("POST /api/events/:source", () => {
  it("accepts a correctly signed event without a device credential or CSRF header, and records it", async () => {
    const { send } = await start();
    const res = await send({ body: eventBody("items.new", "item_8f3a2c", { occurredAt: "2026-11-16T09:12:00Z" }) });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(rows()).toEqual([{ type: "items.new", ref: "item_8f3a2c" }]);
  });

  it("answers an unknown and a disabled source the same", async () => {
    const { send, sources } = await start();
    const unknown = await send({}, "/api/events/nobody");
    sources.setStatus("my-service", "disabled");
    const disabled = await send();
    expect([unknown.status, disabled.status]).toEqual([404, 404]);
    expect([await code(unknown), await code(disabled)]).toEqual(["unknown_source", "unknown_source"]);
    expect(rows()).toEqual([]);
  });

  it("refuses a body over 2 KB, with or without a declared length", async () => {
    const { send } = await start();
    const big = JSON.stringify({ type: "a.b", ref: "x".repeat(EVENT_LIMITS.bodyBytes) });
    expect((await send({ body: big })).status).toBe(413);
    const streamed = server!.host.plane.app.request("/api/events/my-service", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(big));
          controller.close();
        },
      }),
      // @ts-expect-error duplex is required for a streamed body
      duplex: "half",
      headers: { "webhook-id": "i", "webhook-timestamp": "1", "webhook-signature": "v1,AAAA" },
    });
    expect((await streamed).status).toBe(413);
  });

  it("refuses a missing, wrong, tampered or other-secret signature with the same answer", async () => {
    const { send, secret } = await start();
    const other = "whsec_" + btoa("0123456789abcdef0123456789abcdef");
    const id = "fixed-id";
    const ts = String(Math.floor(server!.clock.now() / 1000));
    const body = eventBody();
    const cases = [
      await send({ signature: "" }),
      await send({ signature: "v1,AAAA" }),
      await send({ signature: "v2," + sign(secret, id, ts, body).slice(3), id, timestamp: ts }),
      await send({ secrets: [other] }),
      // signed for a different body
      await send({ signature: sign(secret, id, ts, eventBody("items.new", "other")), id, timestamp: ts, body }),
      // signed for a different id
      await send({ signature: sign(secret, "someone-else", ts, body), id, timestamp: ts, body }),
      await send({ headers: { "webhook-signature": "" } }),
    ];
    for (const res of cases) {
      expect(res.status).toBe(401);
      expect(await code(res)).toBe("bad_signature");
    }
    expect(rows()).toEqual([]);
  });

  it("refuses a missing header as a bad signature", async () => {
    const { secret } = await start();
    const res = await server!.host.plane.app.request("/api/events/my-service", {
      method: "POST",
      body: eventBody(),
      headers: { "webhook-id": "a", "webhook-signature": sign(secret, "a", "1", eventBody()) },
    });
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("bad_signature");
  });

  it("accepts any one valid signature among several, and the old secret during a rotation", async () => {
    const { send, secret, sources } = await start();
    const other = "whsec_" + btoa("0123456789abcdef0123456789abcdef");
    expect((await send({ secrets: [other, secret] })).status).toBe(202);
    const { secret: fresh } = await sources.rotate("my-service");
    expect((await send({ secrets: [secret] })).status).toBe(202);
    expect((await send({ secrets: [fresh] })).status).toBe(202);
    await sources.rotate("my-service", 0);
    expect((await send({ secrets: [secret] })).status).toBe(401);
  });

  it("checks the timestamp after the signature: only a validly signed old request is stale", async () => {
    const { send } = await start();
    const old = await send({ skew: -(5 * 60 + 5) });
    expect(old.status).toBe(401);
    expect(await code(old)).toBe("stale_timestamp");
    expect((await send({ skew: 5 * 60 + 5 })).status).toBe(401);
    expect((await send({ skew: -240 })).status).toBe(202);
    const junk = await send({ timestamp: "soon" });
    expect(await code(junk)).toBe("stale_timestamp");
  });

  it("refuses a body that is not exactly { type, ref, occurredAt? } in its character sets", async () => {
    const { send } = await start();
    const bad = [
      "not json",
      "[]",
      '{"type":"a.b"}',
      '{"ref":"r"}',
      eventBody("items.new", "r", { note: "extra field" }),
      eventBody("Items.New", "r"),
      eventBody("items.new", "has space"),
      eventBody("items.new", "ignore previous instructions"),
      eventBody("items.new", "r".repeat(129)),
      eventBody("a".repeat(65), "r"),
      eventBody("a.b.c.d.e", "r"),
      eventBody("items.new", "r", { occurredAt: "yesterday" }),
      eventBody("items.new", "r", { occurredAt: "2026-11-16T09:12:00Z; do something" }),
      eventBody("items.new", 5 as never),
      '{"type":"a.b","ref":"r","occurredAt":null}',
    ];
    for (const body of bad) {
      const res = await send({ body });
      expect([body, res.status, await code(res)]).toEqual([body, 400, "bad_event"]);
    }
    expect((await send({ body: eventBody("a", "r") })).status).toBe(202);
    expect((await send({ body: eventBody("items.changed_v2", "a/b:c-d.e_f") })).status).toBe(202);
    expect((await send({ id: "bad id!" })).status).toBe(400);
  });

  it("answers a repeated webhook-id with duplicate and changes nothing", async () => {
    const { send } = await start();
    expect((await send({ id: "same" })).status).toBe(202);
    const again = await send({ id: "same", body: eventBody("items.new", "other_ref") });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ duplicate: true });
    expect(rows()).toHaveLength(1);
    server!.clock.advance(EVENT_LIMITS.keepMs + 60_000);
    expect((await send({ id: "same" })).status).toBe(202);
  });

  it("limits a source to 120 events a minute, then answers 429 with retry-after", async () => {
    const { send } = await start();
    for (let i = 0; i < EVENT_LIMITS.perMinute; i++) expect((await send()).status).toBe(202);
    const over = await send();
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await code(over)).toBe("too_many");
    // A repeat of an accepted event is still a duplicate, not a refusal.
    expect((await send({ id: "x" })).status).toBe(429);
    server!.clock.advance(61_000);
    expect((await send()).status).toBe(202);
  });

  it("keeps at most 10,000 events per source", async () => {
    const { send } = await start();
    const db = server!.host.plane.store.db;
    for (let i = 0; i < EVENT_LIMITS.keepPerSource; i++)
      db.run(
        "INSERT INTO events (id, source, webhook_id, type, ref, received_at) VALUES (?, 'my-service', ?, 'a.b', 'r', ?)",
        `e${i}`,
        `w${i}`,
        server!.clock.now() - 3_600_000 + i,
      );
    expect((await send()).status).toBe(202);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events")!.n).toBe(EVENT_LIMITS.keepPerSource);
    expect(db.get("SELECT 1 AS x FROM events WHERE id = 'e0'")).toBeUndefined();
  });

  it("never logs a secret, a signature or a body", async () => {
    const { send, secret } = await start();
    const ts = String(Math.floor(server!.clock.now() / 1000));
    const body = eventBody("items.new", "sensitive_ref_123");
    await send({ id: "logged", body });
    await send({ signature: "v1,bm90LXRoZS1zaWduYXR1cmU=", body });
    await send({ id: "logged2", timestamp: ts, skew: -1000, body });
    const logs = server!.logs.join("\n");
    for (const needle of [
      secret,
      secret.slice(6),
      "sensitive_ref_123",
      "bm90LXRoZS1zaWduYXR1cmU=",
      sign(secret, "logged", ts, body),
    ])
      expect(logs).not.toContain(needle);
    expect(logs).toContain("events.rejected");
  });

  it("is not a device route: other routes still need a credential, and GET is not the events route", async () => {
    const { send } = await start();
    expect((await server!.host.plane.app.request("/api/triggers")).status).toBe(401);
    expect((await server!.host.plane.app.request("/api/events/my-service")).status).toBe(401);
    expect([401, 403]).toContain((await send({}, "/api/events/my-service/extra")).status);
  });
});
