import { describe, expect, it } from "vitest";
import { fence, fenceAs, newFenceId, originOf, stableFenceIds } from "../src/web/fence.ts";
import { unfence } from "./helpers/fence.ts";

describe("fence", () => {
  it("puts the same id in both markers, with the origin in the first", () => {
    const text = fence("hello\nworld", "shop.example");
    const m =
      /^<<<page-content id=([0-9a-f]{8}) origin=shop\.example>>>\nhello\nworld\n<<<end page-content id=\1>>>$/.exec(
        text,
      );
    expect(m).not.toBeNull();
    expect(unfence(text)).toMatchObject({ origin: "shop.example", body: "hello\nworld", lead: "", footer: "" });
  });

  it("leaves origin out when there is none", () => {
    const text = fence("body", null);
    expect(text).toMatch(/^<<<page-content id=[0-9a-f]{8}>>>\nbody\n<<<end page-content id=[0-9a-f]{8}>>>$/);
    expect(text).not.toContain("origin");
  });

  it("uses a new id each call", () => {
    expect(new Set(Array.from({ length: 20 }, () => newFenceId())).size).toBe(20);
  });

  it("picks another id when the body contains the one it drew", () => {
    const ids = ["aaaaaaaa", "bbbbbbbb", "cccccccc"];
    const next = () => ids.shift()!;
    const text = fence("a page that says aaaaaaaa and bbbbbbbb", "x.example", next);
    expect(text.startsWith("<<<page-content id=cccccccc origin=x.example>>>")).toBe(true);
    expect(text.endsWith("<<<end page-content id=cccccccc>>>")).toBe(true);
  });
});

describe("fenceAs with stable ids", () => {
  it("renders the same text for the same body, and never an id the body contains", () => {
    const body = "a report";
    const once = fenceAs("previous-report", body, stableFenceIds(body));
    expect(fenceAs("previous-report", body, stableFenceIds(body))).toBe(once);
    const id = /^<<<previous-report id=([0-9a-f]{8})>>>\na report\n<<<end previous-report id=\1>>>$/.exec(once)?.[1];
    expect(id).toBeDefined();
    expect(fenceAs("previous-report", "another report", stableFenceIds("another report"))).not.toContain(id);
  });

  it("draws a different id each time, so a body that contains one still gets an id it does not contain", () => {
    const next = stableFenceIds("body");
    const ids = Array.from({ length: 5 }, () => next());
    expect(new Set(ids).size).toBe(5);
    const first = stableFenceIds("x")();
    expect(fenceAs("k", "x", () => first)).toContain(`id=${first}`);
    const [drawn, second] = ids;
    expect(fenceAs("k", `x ${drawn}`, () => ids.shift()!)).toContain(`<<<end k id=${second}>>>`);
  });
});

describe("originOf", () => {
  it("is the lower-case host of an http(s) address, else null", () => {
    expect(originOf("https://Shop.Example/cart?x=1")).toBe("shop.example");
    expect(originOf("http://a.example:8080/")).toBe("a.example");
    expect(originOf("about:blank")).toBeNull();
    expect(originOf("file:///etc/passwd")).toBeNull();
    expect(originOf("nonsense")).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});
