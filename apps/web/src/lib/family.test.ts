import { describe, expect, it } from "vitest";
import { session } from "../test/fixtures.ts";
import { branchesOf, childrenOf, isUnfinished } from "./family.ts";

const fork = (id: string, from: string) =>
  session({ id, origin: "fork", forkedFrom: { sessionId: from, messageId: "m" } });

describe("childrenOf", () => {
  it("returns only sessions whose parent is the given chat", () => {
    const all = [
      session({ id: "p" }),
      session({ id: "c1", origin: "spawned", parentSessionId: "p" }),
      session({ id: "c2", origin: "spawned", parentSessionId: "other" }),
      session({ id: "x" }),
    ];
    expect(childrenOf(all, "p").map((s) => s.id)).toEqual(["c1"]);
  });
});

describe("isUnfinished", () => {
  it("is true while running or waiting for you", () => {
    expect(isUnfinished(session({ status: "running" }))).toBe(true);
    expect(isUnfinished(session({ status: "waiting_for_user" }))).toBe(true);
    for (const status of ["idle", "completed", "failed", "cancelled"] as const)
      expect(isUnfinished(session({ status }))).toBe(false);
  });
});

describe("branchesOf", () => {
  it("is empty for a chat with no branches", () => {
    expect(branchesOf([session({ id: "a" }), session({ id: "b" })], "a")).toEqual([]);
  });

  it("finds branches of branches, never the source or siblings", () => {
    const all = [
      session({ id: "a" }),
      fork("b", "a"),
      fork("c", "b"),
      fork("d", "a"),
      session({ id: "z" }),
      session({ id: "s", origin: "spawned", parentSessionId: "b" }),
    ];
    expect(
      branchesOf(all, "a")
        .map((s) => s.id)
        .sort(),
    ).toEqual(["b", "c", "d"]);
    expect(branchesOf(all, "b").map((s) => s.id)).toEqual(["c"]);
    expect(branchesOf(all, "c")).toEqual([]);
  });
});
