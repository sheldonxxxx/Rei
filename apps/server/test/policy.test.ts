import type { ActionClass, ProfileName, TaintLabel } from "@rei/protocol";
import { describe, expect, it } from "vitest";
import {
  ALL_LENGTHS,
  argsPreview,
  CREDENTIALS_DENIED,
  canonicalJson,
  canonicalProfile,
  type DecisionInput,
  decide,
  isTainted,
  ONCE_ONLY,
} from "../src/policy/decision.ts";

const PROFILES: ProfileName[] = ["strict", "standard", "yolo"];
const BOTH: TaintLabel[] = ["external", "private"];

const base: DecisionInput = {
  actionClass: "read_internal",
  profile: "standard",
  grantMatches: false,
  taint: [],
};
const d = (over: Partial<DecisionInput>) => decide({ ...base, ...over });
const allow = (via: "profile" | "grant" = "profile") => ({ kind: "allow", via });
const ask = (lengths: readonly string[]) => expect.objectContaining({ kind: "ask", lengths });

describe("decision table", () => {
  it("read_internal and write_internal: allow in every profile, whatever else is true", () => {
    for (const actionClass of ["read_internal", "write_internal"] as ActionClass[]) {
      for (const profile of PROFILES) {
        for (const taint of [[], BOTH]) {
          for (const grantMatches of [true, false])
            expect(d({ actionClass, profile, taint, grantMatches })).toEqual(allow());
        }
      }
    }
  });

  it("read_external: allow except in strict, where it asks (all lengths) unless a grant matches", () => {
    for (const profile of ["standard", "yolo"] as ProfileName[])
      expect(d({ actionClass: "read_external", profile })).toEqual(allow());
    expect(d({ actionClass: "read_external", profile: "strict" })).toEqual(ask(ALL_LENGTHS));
    expect(d({ actionClass: "read_external", profile: "strict", grantMatches: true })).toEqual(allow("grant"));
    // tainted sessions read just the same
    expect(d({ actionClass: "read_external", profile: "standard", taint: BOTH })).toEqual(allow());
  });

  it("write_external: asks only in Strict", () => {
    expect(d({ actionClass: "write_external", profile: "strict" })).toEqual(ask(ALL_LENGTHS));
    expect(d({ actionClass: "write_external", profile: "strict", grantMatches: true })).toEqual(allow("grant"));
    for (const profile of ["standard", "yolo"] as ProfileName[]) {
      expect(d({ actionClass: "write_external", profile })).toEqual(allow());
      // taint does not change write_external
      expect(d({ actionClass: "write_external", profile, taint: BOTH })).toEqual(allow());
    }
  });

  it("send, untainted: ask in strict and standard unless a grant matches; yolo allows", () => {
    for (const taint of [[], ["external"], ["private"]] as TaintLabel[][]) {
      for (const profile of ["strict", "standard"] as ProfileName[]) {
        expect(d({ actionClass: "send", profile, taint })).toEqual(ask(ALL_LENGTHS));
        expect(d({ actionClass: "send", profile, taint, grantMatches: true })).toEqual(allow("grant"));
      }
      expect(d({ actionClass: "send", profile: "yolo", taint })).toEqual(allow());
    }
  });

  it("send, tainted (external and private): strict and standard ask every time, ignore grants, offer only once; yolo allows", () => {
    for (const profile of ["strict", "standard"] as ProfileName[]) {
      for (const grantMatches of [true, false])
        expect(d({ actionClass: "send", profile, taint: BOTH, grantMatches })).toEqual(ask(ONCE_ONLY));
    }
    expect(d({ actionClass: "send", profile: "yolo", taint: BOTH })).toEqual(allow());
  });

  it.each(["irreversible", "configure"] as const)("%s: YOLO allows; other profiles ask once", (actionClass) => {
    for (const profile of PROFILES) {
      for (const taint of [[], BOTH]) {
        for (const grantMatches of [true, false])
          expect(d({ actionClass, profile, taint, grantMatches })).toEqual(
            profile === "yolo" ? allow() : ask(ONCE_ONLY),
          );
      }
    }
  });

  it("memory_write: automatic in Standard and YOLO, with review after outside reads in Strict", () => {
    for (const profile of PROFILES) {
      for (const taint of [[], ["private"] as TaintLabel[]])
        expect(d({ actionClass: "memory_write", profile, taint })).toEqual(allow());
    }
    for (const taint of [["external"] as TaintLabel[], BOTH]) {
      expect(d({ actionClass: "memory_write", profile: "strict", taint })).toEqual(
        expect.objectContaining({
          kind: "ask",
          lengths: ALL_LENGTHS,
          reason: "this chat read outside content, so writing your profile asks first",
        }),
      );
      expect(d({ actionClass: "memory_write", profile: "strict", taint, grantMatches: true })).toEqual(allow("grant"));
      for (const profile of ["standard", "yolo"] as const)
        expect(d({ actionClass: "memory_write", profile, taint })).toEqual(allow());
    }
  });

  it("public web research: Standard and YOLO run it, also after private reads; Strict asks with web lengths", () => {
    for (const actionClass of ["read_external", "send"] as const) {
      for (const profile of ["standard", "yolo"] as const)
        expect(d({ actionClass, scope: "web", taint: BOTH, profile })).toEqual(allow());
      expect(d({ actionClass, scope: "web", taint: BOTH, profile: "strict" })).toEqual(
        ask(["once", "session", "web_session"]),
      );
      expect(d({ actionClass, scope: "web", profile: "strict", grantMatches: true })).toEqual(allow("grant"));
    }
  });

  it("browser typing after private reads asks for the site except in YOLO", () => {
    for (const profile of ["strict", "standard"] as const) {
      expect(d({ actionClass: "send", scope: "browser_site", taint: BOTH, profile })).toEqual(ask(["once", "session"]));
      expect(d({ actionClass: "send", scope: "browser_site", taint: BOTH, profile, grantMatches: true })).toEqual(
        allow("grant"),
      );
    }
    expect(d({ actionClass: "send", scope: "browser_site", taint: BOTH, profile: "yolo" })).toEqual(allow());
  });

  it("credentials: denied in every profile, with a takeover message", () => {
    for (const profile of PROFILES)
      for (const grantMatches of [true, false]) {
        expect(d({ actionClass: "credentials", profile, grantMatches })).toEqual({
          kind: "deny",
          reason: CREDENTIALS_DENIED,
        });
      }
    expect(CREDENTIALS_DENIED).toMatch(/takeover/);
  });

  it("isTainted needs both labels", () => {
    expect(isTainted([])).toBe(false);
    expect(isTainted(["external"])).toBe(false);
    expect(isTainted(["private"])).toBe(false);
    expect(isTainted(["private", "external"])).toBe(true);
  });
});

describe("levels", () => {
  it("reads the older name relaxed as Standard and anything unknown as Strict", () => {
    expect(canonicalProfile("relaxed")).toBe("standard");
    for (const profile of PROFILES) expect(canonicalProfile(profile)).toBe(profile);
    for (const value of ["", "YOLO", "open", null, undefined]) expect(canonicalProfile(value)).toBe("strict");
  });

  it("decides a stored relaxed level exactly as Standard, for every class and input", () => {
    const classes: ActionClass[] = [
      "read_internal",
      "read_external",
      "write_internal",
      "write_external",
      "send",
      "irreversible",
      "credentials",
      "memory_write",
      "configure",
    ];
    for (const actionClass of classes)
      for (const scope of [undefined, "web", "browser_site"] as const)
        for (const taint of [[], ["external"], BOTH] as TaintLabel[][])
          for (const grantMatches of [true, false]) {
            const input = { actionClass, taint, grantMatches, ...(scope ? { scope } : {}) };
            expect(d({ ...input, profile: "relaxed" as ProfileName })).toEqual(d({ ...input, profile: "standard" }));
          }
  });
});

describe("helpers", () => {
  it("hashes arguments canonically (key order does not matter)", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }),
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
  it("cuts the arguments preview at 4,000 characters with an ellipsis", () => {
    expect(argsPreview({ a: 1 })).toBe('{\n  "a": 1\n}');
    const long = argsPreview({ text: "x".repeat(10_000) });
    expect(long.length).toBe(4_000);
    expect(long.endsWith("…")).toBe(true);
  });
});
