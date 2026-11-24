import { normalizeHost, parseConnectTarget, parsePort, parseProxyUrl } from "@rei/forward-proxy";
import { describe, expect, it } from "vitest";

describe("normalizeHost", () => {
  it.each([
    ["Example.COM", "example.com"],
    ["example.com.", "example.com"],
    ["[2606:4700:4700::1111]", "2606:4700:4700::1111"],
    ["[::1]", "::1"],
    ["10.0.0.1", "10.0.0.1"],
    ["xn--nxasmq6b.example", "xn--nxasmq6b.example"],
    ["a_b.example.com", "a_b.example.com"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeHost(raw)).toBe(expected);
  });
  it.each([
    "",
    ".",
    "..",
    "example.com..",
    ".example.com",
    "a..b",
    "exa mple.com",
    "a/b",
    "a?b",
    "a@b",
    "user@example.com",
    "[example.com]",
    "[::1",
    "x".repeat(254),
    "é.example",
    "a\u0000b",
  ])("rejects %j", (raw) => {
    expect(normalizeHost(raw)).toBeNull();
  });
  it("takes a bare IPv6 literal", () => {
    expect(normalizeHost("::1")).toBe("::1");
  });
  it("accepts a 253 character name and no more", () => {
    const name = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(name.length).toBe(253);
    expect(normalizeHost(name)).toBe(name);
    expect(normalizeHost(name + "e")).toBeNull();
  });
});

describe("parsing destinations", () => {
  it("parses ports", () => {
    expect(parsePort("443")).toBe(443);
    expect(parsePort("0")).toBeNull();
    expect(parsePort("65536")).toBeNull();
    expect(parsePort("-1")).toBeNull();
    expect(parsePort("80x")).toBeNull();
    expect(parsePort("")).toBeNull();
  });
  it("parses CONNECT targets", () => {
    expect(parseConnectTarget("Example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(parseConnectTarget("example.com.:80")).toEqual({ host: "example.com", port: 80 });
    expect(parseConnectTarget("[2606:4700::1111]:443")).toEqual({ host: "2606:4700::1111", port: 443 });
    for (const bad of [
      "example.com",
      "example.com:",
      ":443",
      "example.com:99999",
      "a b:443",
      "::1:443",
      "[::1:443",
      "example.com:443:1",
      "",
    ]) {
      expect(parseConnectTarget(bad), bad).toBeNull();
    }
  });
  it("parses absolute-URI request targets", () => {
    expect(parseProxyUrl("http://Example.com/a/b?x=1")).toEqual({ host: "example.com", port: 80, path: "/a/b?x=1" });
    expect(parseProxyUrl("http://example.com:8080")).toEqual({ host: "example.com", port: 8080, path: "/" });
    expect(parseProxyUrl("http://[2606:4700::1111]/x")).toEqual({ host: "2606:4700::1111", port: 80, path: "/x" });
    expect(parseProxyUrl("https://example.com/")).toBeNull();
    expect(parseProxyUrl("/just/a/path")).toBeNull();
    expect(parseProxyUrl("example.com:80")).toBeNull();
    expect(parseProxyUrl("http://")).toBeNull();
  });
});
