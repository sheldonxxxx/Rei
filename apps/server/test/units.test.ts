import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.ts";
import { totpCode, verifyTotp } from "../src/auth/totp.ts";
import { FolderBlobStore } from "../src/node/blob-store.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import { mapModelError } from "../src/pi/errors.ts";
import { DEFAULT_DEADLINES, parseModelOverrides, parseModelsConfig } from "../src/pi/model-config.ts";
import { EventLog } from "../src/store/events.ts";
import { base32Decode, base32Encode, fromBase64Url, toBase64Url } from "../src/util/encoding.ts";
import { newId } from "../src/util/ids.ts";
import { createLogger, redact } from "../src/util/log.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "rei-unit-"));

describe("SQLite writes", () => {
  it("handles large internal rowids without changing the numeric query results", () => {
    const db = openSqliteDb(":memory:");
    try {
      db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");
      expect(db.run("INSERT INTO probe (id, value) VALUES (?, ?)", 9007199254740993n, "large").changes).toBe(1);
      expect(db.run("DELETE FROM probe").changes).toBe(1);
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM probe")?.n).toBe(0);
      // A cached statement used by run() must still read ordinary integers as numbers.
      db.run("SELECT 1 AS n");
      expect(db.get("SELECT 1 AS n")).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});

describe("encoding and ids", () => {
  it.each([
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ])("interoperates with the standard Base32 vector %j → %s", (plain, encoded) => {
    const bytes = new TextEncoder().encode(plain);
    expect(base32Encode(bytes)).toBe(encoded);
    expect(base32Decode(encoded)).toEqual(bytes);
  });

  it("decodes padded and lowercase Base32 from external authenticators", () => {
    expect(base32Decode("mzxw6===")).toEqual(new Uint8Array([102, 111, 111]));
    expect(base32Encode(new Uint8Array([0, 255]))).toBe("AD7Q");
    expect(base32Decode("AD7Q")).toEqual(new Uint8Array([0, 255]));
  });

  it("round-trips base32 and base64url", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(toBase64Url(bytes)).not.toMatch(/[+/=]/);
  });
  it("makes sortable, prefixed, unique ids", () => {
    const a = newId("ses", 1_000);
    const b = newId("ses", 2_000);
    expect(a).toMatch(/^ses_[0-9a-f]+$/);
    expect(a < b).toBe(true);
    expect(newId("ses", 1_000)).not.toBe(a);
  });
});

describe("totp", () => {
  // RFC 6238 appendix B, SHA-1, secret "12345678901234567890", 8 digits there; the last 6 are ours.
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  it("matches the RFC 6238 test vectors", async () => {
    expect(await totpCode(secret, 59_000)).toBe("287082");
    expect(await totpCode(secret, 1_111_111_109_000)).toBe("081804");
    expect(await totpCode(secret, 1_234_567_890_000)).toBe("005924");
  });
  it("accepts one step of drift, once", async () => {
    const now = 1_111_111_109_000;
    const code = await totpCode(secret, now);
    const step = await verifyTotp(secret, code, now + 30_000, 0);
    expect(step).not.toBeNull();
    expect(await verifyTotp(secret, code, now + 30_000, step!)).toBeNull();
    expect(await verifyTotp(secret, code, now + 120_000, 0)).toBeNull();
    expect(await verifyTotp(secret, "12345", now, 0)).toBeNull();
    expect(await verifyTotp(secret, "abcdef", now, 0)).toBeNull();
  });
});

describe("password", () => {
  it("verifies the right password only, with a fresh salt each time", async () => {
    const a = await hashPassword("a long enough password", 1_000);
    const b = await hashPassword("a long enough password", 1_000);
    expect(a.hash).not.toBe(b.hash);
    expect(await verifyPassword("a long enough password", a)).toBe(true);
    expect(await verifyPassword("a long enough passwore", a)).toBe(false);
  });
});

describe("event log", () => {
  it("keeps the last N events per stream in memory, numbers streams from the start time, and plans replay or snapshot", () => {
    const log = new EventLog({ now: () => 1_000 }, 5);
    const base = 1_000 * 1_000;
    for (let i = 0; i < 12; i++) log.append("a", { type: "x", i });
    log.append("b", { type: "y" });
    expect(log.latest("a")).toBe(base + 12);
    expect(log.latest("b")).toBe(base + 1);
    expect(log.oldest("a")).toBe(base + 8);
    expect(log.since("a", 0)).toHaveLength(5);
    expect(log.plan("a", String(base + 12))).toEqual({ mode: "replay", events: [] });
    const near = log.plan("a", String(base + 10));
    expect(near.mode === "replay" && near.events.map((e) => e.cursor)).toEqual([base + 11, base + 12]);
    expect(log.plan("a", String(base + 1)).mode).toBe("snapshot");
    expect(log.plan("a", String(base + 13)).mode).toBe("snapshot");
    expect(log.plan("a", undefined).mode).toBe("snapshot");
    expect(log.plan("a", "-3").mode).toBe("snapshot");
    // A restart starts later: every cursor of the old process is older than the new one's.
    expect(new EventLog({ now: () => 2_000 }).append("a", { type: "x" })).toBeGreaterThan(log.latest("a"));
  });

  it("publishes after flush only, drops on discard, and ephemeral events carry no cursor", () => {
    const log = new EventLog({ now: () => 0 });
    const seen: (number | null)[] = [];
    const off = log.subscribe("s", (e) => seen.push(e.cursor));
    log.append("s", { type: "one" });
    expect(seen).toEqual([]);
    log.flush();
    log.append("s", { type: "two" });
    log.discard();
    log.flush();
    log.ephemeral("s", { type: "tmp" });
    expect(seen).toEqual([1, null]);
    expect(log.subscriberCount("s")).toBe(1);
    off();
    expect(log.subscriberCount("s")).toBe(0);
  });
});

describe("blob store", () => {
  it("stores by content hash and reads back the same bytes", async () => {
    const dir = tmp();
    try {
      const store = new FolderBlobStore(join(dir, "blobs"));
      const bytes = new TextEncoder().encode("hello blobs");
      const ref = await store.put(bytes);
      expect(ref).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(await store.put(bytes)).toBe(ref);
      expect(await store.has(ref)).toBe(true);
      expect(new TextDecoder().decode((await store.get(ref))!)).toBe("hello blobs");
      expect(await store.get(`sha256:${"0".repeat(64)}`)).toBeUndefined();
      await expect(store.get("../../etc/passwd")).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("models.json", () => {
  it("falls back to defaults and accepts a model id or an object with deadlines", () => {
    const empty = parseModelsConfig(undefined);
    expect(empty.fast.model).toBe("gpt-6-luna");
    expect(empty.standard.deadlines).toEqual(DEFAULT_DEADLINES);
    const set = parseModelsConfig({ fast: "m1", standard: { model: "m2", firstEventMs: 5, idleMs: -1 } });
    expect(set.fast).toEqual({ model: "m1", deadlines: DEFAULT_DEADLINES });
    expect(set.standard.model).toBe("m2");
    expect(set.standard.deadlines).toEqual({
      firstEventMs: 5,
      idleMs: DEFAULT_DEADLINES.idleMs,
      totalMs: DEFAULT_DEADLINES.totalMs,
    });
  });
});

describe("logs and error text", () => {
  it("redacts credentials and drops forbidden fields", () => {
    const lines: string[] = [];
    const log = createLogger(
      (l) => lines.push(l),
      () => 0,
    );
    log.info("x", {
      ok: 1,
      text: "secret chat text",
      password: "p",
      note: "Bearer abcdefghijklmnop and eyJhbGciOiJSUzI1NiJ9.abcdefghijkl.sig",
    });
    const out = lines[0]!;
    expect(out).not.toContain("secret chat text");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("eyJhbGci");
    expect(JSON.parse(out).ok).toBe(1);
    expect(redact("sk-abcdefghijklmnopqrstuvwxyz")).toBe("[redacted-key]");
  });
  it("maps output-limit and context-limit failures to their own codes", () => {
    const outputLimit = mapModelError("output_limit: The model stopped at its output limit before writing a reply.");
    expect(outputLimit.code).toBe("output_limit");
    expect(outputLimit.message).toContain("output limit");
    const contextLimit = mapModelError("context_too_large: This chat needs about 9000 input tokens.");
    expect(contextLimit.code).toBe("context_too_large");
    expect(contextLimit.message).toContain("9000");
  });
  it("keeps only well-formed per-model overrides from models.json", () => {
    expect(
      parseModelOverrides({
        "custom/a": { contextWindow: 32768, maxTokens: 4096, thinkingLevels: ["xhigh", "low", "bogus"] },
        "custom/b": { contextWindow: 0, maxTokens: 1.5 },
        "custom/c": { maxTokens: "4096" },
        "": { contextWindow: 9 },
        "custom/d": null,
      }),
    ).toEqual({
      // Level lists saved by earlier versions are ignored, not migrated.
      "custom/a": { contextWindow: 32768, maxTokens: 4096 },
    });
    expect(parseModelOverrides(["not", "an", "object"])).toEqual({});
    expect(parseModelOverrides(undefined)).toEqual({});
  });
  it("maps raw model errors to codes without leaking the raw text", () => {
    expect(mapModelError("deadline_exceeded: no response event within 120 s").code).toBe("deadline_exceeded");
    expect(mapModelError("gateway_unavailable: could not reach the model gateway").code).toBe("gateway_unavailable");
    expect(mapModelError('401 {"error":{"code":"bad_token"}}').code).toBe("gateway_auth");
    expect(mapModelError('{"error":{"code":"not_signed_in"}}').code).toBe("gateway_auth_error");
    expect(mapModelError("ChatGPT usage limit reached").code).toBe("usage_limit");
    const other = mapModelError("Bearer abcdefghijklmnop exploded (500)");
    expect(other).toEqual({
      code: "provider_unavailable",
      message: "The model provider is temporarily unavailable (HTTP 500). Try again or choose another model.",
    });
  });
});
