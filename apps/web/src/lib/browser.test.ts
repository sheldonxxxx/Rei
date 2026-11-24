import { describe, expect, it } from "vitest";
import { hostOf, normalizeAddress } from "./browser.ts";

describe("hostOf", () => {
  it("gives the host with its port, and null for nothing usable", () => {
    expect(hostOf("https://bank.example.com/login?x=1")).toBe("bank.example.com");
    expect(hostOf("http://localhost:3000/a")).toBe("localhost:3000");
    expect(hostOf(null)).toBeNull();
    expect(hostOf("not a url")).toBeNull();
  });
});

describe("normalizeAddress", () => {
  it("adds https to a bare host and keeps http(s) URLs", () => {
    expect(normalizeAddress("example.com")).toBe("https://example.com/");
    expect(normalizeAddress("  example.com/a?b=1 ")).toBe("https://example.com/a?b=1");
    expect(normalizeAddress("http://example.com")).toBe("http://example.com/");
    expect(normalizeAddress("localhost:3000/x")).toBe("https://localhost:3000/x");
  });
  it("refuses other schemes, spaces and words that are not hosts", () => {
    expect(normalizeAddress("javascript:alert(1)")).toBeNull();
    expect(normalizeAddress("file:///etc/passwd")).toBeNull();
    expect(normalizeAddress("ftp://example.com")).toBeNull();
    expect(normalizeAddress("two words.com")).toBeNull();
    expect(normalizeAddress("hello")).toBeNull();
    expect(normalizeAddress("")).toBeNull();
  });
});
