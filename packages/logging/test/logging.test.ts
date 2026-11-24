import { describe, expect, it } from "vitest";
import { classifyError, DROPPED, isTokenShaped, type LogFields, sanitizeFields } from "../src/index.ts";
import { CANARIES, canaryError, leakedCanaries } from "./canaries.ts";

describe("sanitizeFields", () => {
  it("keeps ids, codes, numbers, booleans and route patterns", () => {
    expect(
      sanitizeFields({
        stepId: "st_01HZX",
        route: "/api/sessions/:id",
        model: "gpt-5.5",
        host: "api.example.com:443",
        status: 429,
        ok: false,
        none: null,
        empty: "",
      }),
    ).toEqual({
      stepId: "st_01HZX",
      route: "/api/sessions/:id",
      model: "gpt-5.5",
      host: "api.example.com:443",
      status: 429,
      ok: false,
      none: null,
      empty: "",
    });
  });

  it("replaces every canary with the dropped marker or a redaction", () => {
    const fields: Record<string, string> = {};
    for (const [name, value] of Object.entries(CANARIES)) fields[`v_${name}`] = value;
    fields.error = canaryError().message;
    const line = JSON.stringify(sanitizeFields(fields));
    expect(leakedCanaries(line)).toEqual([]);
  });

  it("drops free text, URLs and over-long values", () => {
    expect(isTokenShaped("two words")).toBe(false);
    expect(isTokenShaped("https://example.com")).toBe(false);
    expect(isTokenShaped("a=b")).toBe(false);
    expect(isTokenShaped("x".repeat(129))).toBe(false);
    expect(sanitizeFields({ error: "Request failed: bad things" })).toEqual({ error: DROPPED });
  });

  it("drops protected and forbidden keys even when the types are bypassed", () => {
    const sneaky = { t: "x", timestamp: "x", level: "debug", event: "x", service: "x", message: "hi", id: "ok" };
    expect(sanitizeFields(sneaky as unknown as LogFields)).toEqual({ id: "ok" });
  });

  it("redacts credential-shaped tokens that pass the shape check", () => {
    const out = sanitizeFields({ a: CANARIES.apiKey, b: CANARIES.jwt });
    expect(out).toEqual({ a: "[redacted-key]", b: "[redacted-jwt]" });
  });

  it("runs the service redactor last", () => {
    expect(sanitizeFields({ a: "standin123" }, { redact: (s) => s.replace("standin123", "[standin]") })).toEqual({
      a: "[standin]",
    });
  });

  it("turns non-finite numbers into null", () => {
    expect(sanitizeFields({ n: Number.NaN })).toEqual({ n: null });
  });
});

describe("classifyError", () => {
  it("never reads the message", () => {
    expect(classifyError(canaryError())).toEqual({ errorCode: "unknown", errorClass: "Error" });
  });

  it("uses a code, a fetch cause, kind and status, SQLite result codes and known classes", () => {
    expect(classifyError(Object.assign(new Error("x"), { code: "ECONNREFUSED" })).errorCode).toBe("econnrefused");
    expect(
      classifyError(new TypeError("fetch failed", { cause: Object.assign(new Error("y"), { code: "ENOTFOUND" }) })),
    ).toEqual({ errorCode: "enotfound", errorClass: "TypeError" });
    class EmbedderError extends Error {
      readonly kind = "server";
      readonly status = 503;
      override name = "EmbedderError";
    }
    expect(classifyError(new EmbedderError("down"))).toEqual({ errorCode: "server_503", errorClass: "EmbedderError" });
    expect(classifyError(Object.assign(new Error("locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 })).errorCode).toBe(
      "sqlite_busy",
    );
    expect(classifyError(new DOMException("t", "TimeoutError")).errorCode).toBe("timeout");
    expect(classifyError(new DOMException("a", "AbortError")).errorCode).toBe("aborted");
  });

  it("lets a service name its own failures first, ignoring unsafe codes", () => {
    expect(classifyError(new Error("x"), () => "upstream_429").errorCode).toBe("upstream_429");
    expect(classifyError(new Error("x"), () => "not a code").errorCode).toBe("unknown");
  });

  it("describes non-Error throws by type", () => {
    expect(classifyError("boom")).toEqual({ errorCode: "unknown", errorClass: "string" });
    expect(classifyError(null)).toEqual({ errorCode: "unknown", errorClass: "null" });
    expect(classifyError(Object.assign(new Error("x"), { name: "Bad Name!" })).errorClass).toBe("Error");
  });
});
