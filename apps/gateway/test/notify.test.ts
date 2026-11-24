import { createPublicKey, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { b64u } from "../src/core/http.ts";
import { encryptWebPush, generateVapidKeys, vapidAuthorization } from "../src/core/notify/webpush.ts";
import type { McpRig } from "./mcp-rig.ts";
import { startMcpRig } from "./mcp-rig.ts";

let rig: McpRig | undefined;
afterEach(() => {
  rig?.stop();
  rig = undefined;
});

/** A browser's push subscription keys. */
async function subscriptionKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    p256dh: b64u.encode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    auth: b64u.encode(randomBytes(16)),
    privateKey: pair.privateKey,
  };
}

describe("RFC 8291 encryption", () => {
  // Appendix A and section 5 of RFC 8291.
  const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
  const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";
  const AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
  const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
  // 86-byte header and the AES-GCM output, as printed (the concatenation is not a multiple of 3 bytes: decode separately).
  const HEADER =
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
  const CIPHERTEXT = "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ";

  it("reproduces the Appendix A message byte for byte", async () => {
    const body = await encryptWebPush(
      { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: UA_PUBLIC, auth: AUTH_SECRET } },
      new TextEncoder().encode("When I grow up, I want to be a watermelon"),
      {
        sender: { privateKey: AS_PRIVATE, publicKey: AS_PUBLIC },
        salt: b64u.decode(SALT),
      },
    );
    const expected = new Uint8Array([...b64u.decode(HEADER), ...b64u.decode(CIPHERTEXT)]);
    expect(b64u.decode(HEADER)).toHaveLength(86);
    expect(Buffer.from(body).toString("hex")).toBe(Buffer.from(expected).toString("hex"));
  });

  it("round-trips: the user agent can decrypt what a random sender produced", async () => {
    const ua = await subscriptionKeys();
    const body = await encryptWebPush(
      { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: ua.p256dh, auth: ua.auth } },
      new TextEncoder().encode("hello ✓"),
    );
    const salt = body.slice(0, 16);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
    expect(body[20]).toBe(65);
    const asPublic = body.slice(21, 86);
    const secret = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "ECDH",
          public: await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []),
        },
        ua.privateKey,
        256,
      ),
    );
    const hk = async (
      s: Uint8Array<ArrayBuffer>,
      ikm: Uint8Array<ArrayBuffer>,
      info: Uint8Array<ArrayBuffer>,
      n: number,
    ) =>
      new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: "HKDF", hash: "SHA-256", salt: s, info },
          await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
          n * 8,
        ),
      );
    const t = new TextEncoder();
    const uaPublic = b64u.decode(ua.p256dh);
    const ikm = await hk(
      b64u.decode(ua.auth),
      secret,
      new Uint8Array([...t.encode("WebPush: info\0"), ...uaPublic, ...asPublic]),
      32,
    );
    const cek = await hk(salt, ikm, t.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hk(salt, ikm, t.encode("Content-Encoding: nonce\0"), 12);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce },
        await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]),
        body.slice(86),
      ),
    );
    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe("hello ✓");
    expect(plain.at(-1)).toBe(2);
  });
});

describe("VAPID", () => {
  it("signs an ES256 JWT for the endpoint's origin that is valid for at most 24 hours", async () => {
    const keys = await generateVapidKeys();
    const now = 1_700_000_000_000;
    const header = await vapidAuthorization(keys, "https://fcm.googleapis.com", "mailto:ops@example.org", now);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, p, sig, k] = m!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(claims).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: now / 1000 + 12 * 3600,
      sub: "mailto:ops@example.org",
    });
    expect(claims.exp - now / 1000).toBeLessThanOrEqual(24 * 3600);
    const verifier = await crypto.subtle.importKey(
      "raw",
      b64u.decode(k!),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signature = b64u.decode(sig!);
    expect(signature).toHaveLength(64);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifier,
        signature,
        new TextEncoder().encode(`${h}.${p}`),
      ),
    ).toBe(true);
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifier,
        signature,
        new TextEncoder().encode(`${h}.${p}x`),
      ),
    ).toBe(false);
    expect(
      createPublicKey({ key: { kty: "EC", crv: "P-256", x: keys.privateJwk.x!, y: keys.privateJwk.y! }, format: "jwk" })
        .asymmetricKeyType,
    ).toBe("ec");
  });
});

describe("POST /notify/webpush/send", () => {
  const ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1234";
  type Sent = { url: string; headers: Record<string, string>; body: Uint8Array };
  const setup = (status = 201, extra: Record<string, string> = {}) => {
    const sent: Sent[] = [];
    rig = startMcpRig({
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        sent.push({
          url: String(input),
          headers: Object.fromEntries(new Headers(init?.headers)),
          body: new Uint8Array(init?.body as ArrayBuffer),
        });
        return new Response(null, { status, headers: extra });
      }) as typeof fetch,
    });
    return sent;
  };
  const send = async (body: Record<string, unknown>) => rig!.request("POST", "/notify/webpush/send", body);

  it("generates the VAPID key on first use, keeps it across restarts and stores it privately", async () => {
    setup();
    const a = await rig!.json<{ publicKey: string }>(await rig!.request("GET", "/notify/webpush/key"));
    expect(b64u.decode(a.publicKey)).toHaveLength(65);
    rig!.restart();
    expect((await rig!.json<{ publicKey: string }>(await rig!.request("GET", "/notify/webpush/key"))).publicKey).toBe(
      a.publicKey,
    );
    expect(statSync(rig!.paths.secretsFile).mode & 0o777).toBe(0o600);
  });

  it("encrypts, signs and posts with the headers push services expect", async () => {
    const sent = setup();
    const ua = await subscriptionKeys();
    const res = await send({
      subscription: { endpoint: ENDPOINT, keys: { p256dh: ua.p256dh, auth: ua.auth } },
      payload: '{"title":"Needs your approval"}',
      ttl: 600,
      urgency: "high",
      topic: "approval-1",
    });
    expect(await rig!.json(res)).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    const s = sent[0]!;
    expect(s.url).toBe(ENDPOINT);
    expect(s.headers).toMatchObject({
      "content-encoding": "aes128gcm",
      ttl: "600",
      urgency: "high",
      topic: "approval-1",
    });
    const key = (await rig!.json<{ publicKey: string }>(await rig!.request("GET", "/notify/webpush/key"))).publicKey;
    const m = /^vapid t=([\w-]+\.([\w-]+)\.[\w-]+), k=([\w-]+)$/.exec(s.headers.authorization!)!;
    expect(m[3]).toBe(key);
    const claims = JSON.parse(Buffer.from(m[2]!, "base64url").toString());
    expect(claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "https://example.com/" });
    expect(claims.exp).toBeLessThanOrEqual(rig!.clock.t / 1000 + 24 * 3600);
    expect(s.body.length).toBe(86 + '{"title":"Needs your approval"}'.length + 1 + 16);
    // No plaintext in the body, and the endpoint (it identifies the device) is not logged.
    expect(Buffer.from(s.body).toString("latin1")).not.toContain("approval");
    expect(rig!.logs.join("\n")).not.toContain("device-1234");
    expect(rig!.logs.join("\n")).toContain('"event":"notify.webpush_sent","host":"fcm.googleapis.com","status":201');
  });

  it("defaults the TTL to a day and sends no urgency", async () => {
    const sent = setup();
    const ua = await subscriptionKeys();
    await send({ subscription: { endpoint: ENDPOINT, keys: { p256dh: ua.p256dh, auth: ua.auth } }, payload: "x" });
    expect(sent[0]!.headers.ttl).toBe("86400");
    expect(sent[0]!.headers.urgency).toBeUndefined();
  });

  it.each([
    ["https://fcm.googleapis.com/x", true],
    ["https://updates.push.services.mozilla.com/wpush/v2/x", true],
    ["https://web.push.apple.com/x", true],
    ["https://wns2-par02p.notify.windows.com/w/?token=x", true],
    ["http://fcm.googleapis.com/x", false],
    ["https://evil.example.com/x", false],
    ["https://fcm.googleapis.com.evil.com/x", false],
    ["https://evilpush.apple.com.example.org/x", false],
    ["https://notapush.apple.com@evil.com/x", false],
    ["https://fcm.googleapis.com:8443/x", false],
    ["https://127.0.0.1/x", false],
    ["not a url", false],
  ])("push host allowlist: %s -> %s", async (endpoint, allowed) => {
    const sent = setup();
    const ua = await subscriptionKeys();
    const res = await send({ subscription: { endpoint, keys: { p256dh: ua.p256dh, auth: ua.auth } }, payload: "x" });
    if (allowed) {
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
    } else {
      expect(res.status).toBe(400);
      expect((await rig!.json<{ error: { code: string } }>(res)).error.code).toBe("endpoint_not_allowed");
      expect(sent).toEqual([]);
    }
  });

  it.each([404, 410])("%i means the subscription is gone", async (status) => {
    setup(status);
    const ua = await subscriptionKeys();
    expect(
      await rig!.json(
        await send({ subscription: { endpoint: ENDPOINT, keys: { p256dh: ua.p256dh, auth: ua.auth } }, payload: "x" }),
      ),
    ).toEqual({ ok: false, gone: true, status });
  });

  it("other failures are not gone; 429 passes Retry-After on; an unreachable service is status 0", async () => {
    setup(503, { "retry-after": "30" });
    const ua = await subscriptionKeys();
    const sub = { endpoint: ENDPOINT, keys: { p256dh: ua.p256dh, auth: ua.auth } };
    expect(await rig!.json(await send({ subscription: sub, payload: "x" }))).toEqual({
      ok: false,
      gone: false,
      status: 503,
      retryAfterMs: 30_000,
    });
    rig!.stop();
    rig = startMcpRig({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(await rig.json(await send({ subscription: sub, payload: "x" }))).toEqual({
      ok: false,
      gone: false,
      status: 0,
    });
  });

  it("limits the payload to 3 KB before encryption", async () => {
    const sent = setup();
    const ua = await subscriptionKeys();
    const sub = { endpoint: ENDPOINT, keys: { p256dh: ua.p256dh, auth: ua.auth } };
    expect((await send({ subscription: sub, payload: "a".repeat(3 * 1024) })).status).toBe(200);
    const big = await send({ subscription: sub, payload: "a".repeat(3 * 1024 + 1) });
    expect(big.status).toBe(400);
    expect((await rig!.json<{ error: { code: string } }>(big)).error.code).toBe("payload_too_large");
    expect((await send({ subscription: sub, payload: "é".repeat(2000) })).status).toBe(400); // bytes, not characters
    expect(sent).toHaveLength(1);
  });

  it("validates the rest of the body", async () => {
    setup();
    const ua = await subscriptionKeys();
    const sub = { endpoint: ENDPOINT, keys: { p256dh: ua.p256dh, auth: ua.auth } };
    for (const body of [
      { payload: "x" },
      { subscription: { endpoint: ENDPOINT }, payload: "x" },
      { subscription: { endpoint: ENDPOINT, keys: { p256dh: "AAAA", auth: ua.auth } }, payload: "x" },
      { subscription: { endpoint: ENDPOINT, keys: { p256dh: ua.p256dh, auth: "AAAA" } }, payload: "x" },
      { subscription: sub },
      { subscription: sub, payload: "x", ttl: -1 },
      { subscription: sub, payload: "x", urgency: "low" },
      { subscription: sub, payload: "x", topic: "has space" },
      { subscription: sub, payload: "x", topic: "a".repeat(33) },
    ])
      expect((await send(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
  });
});
