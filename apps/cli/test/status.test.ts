import { describe, expect, it } from "vitest";
import type { StatusReport } from "../src/commands/status.ts";
import { status } from "../src/commands/status.ts";
import { makeRig, SECRET } from "./fakes.ts";

describe("status", () => {
  it("reports container health and the app, without mutations or secrets", async () => {
    const rig = makeRig({ setupRequired: true });
    expect(await status(rig.ctx, { json: false })).toBe(0);
    expect(rig.out.text).toMatch(/ok {3}control +running, healthy/);
    expect(rig.out.text).toMatch(/ok {3}exec-keys +ran, exited 0/);
    expect(rig.out.text).toMatch(/ok {3}app +http:\/\/localhost:8787 +no account yet: \.\/rei setup-code/);
    expect(rig.out.text).not.toContain(SECRET);
    expect(rig.stack.mutating).toEqual([]);
    expect(rig.fetched).toContain("http://127.0.0.1:8787/api/auth/state");
  });

  it("says the account exists once Rei has one", async () => {
    const rig = makeRig({ setupRequired: false });
    expect(await status(rig.ctx, { json: false })).toBe(0);
    expect(rig.out.text).toMatch(/ok {3}app +http:\/\/localhost:8787 +account exists/);
  });

  it("model, search and memory are not reported here", async () => {
    const rig = makeRig();
    await status(rig.ctx, { json: false });
    expect(rig.out.text).not.toMatch(/model sign-in|web search|Memory/);
  });

  it("gateway down: its line says so", async () => {
    const rig = makeRig();
    rig.stack.rows.set("gateway", { state: "exited", health: "", exitCode: 1 });
    expect(await status(rig.ctx, { json: false })).toBe(0);
    expect(rig.out.text).toMatch(/FAIL {1}gateway +exited 1/);
  });

  it("an app that does not answer is a warning with the fix, and the command still succeeds", async () => {
    const rig = makeRig({ appDown: true });
    expect(await status(rig.ctx, { json: false })).toBe(0);
    expect(rig.out.text).toMatch(/warn {1}app +http:\/\/localhost:8787 does not answer/);
  });

  it("--json is one object with the containers and the app only", async () => {
    const rig = makeRig({ setupRequired: true });
    expect(await status(rig.ctx, { json: true })).toBe(0);
    expect(rig.out.lines).toHaveLength(1);
    const r = JSON.parse(rig.out.text) as StatusReport;
    expect(r.services.map((s) => s.service)).toEqual([
      "browser",
      "control",
      "edge",
      "egress",
      "exec",
      "exec-keys",
      "garage",
      "gateway",
      "qdrant",
      "reader",
      "searxng",
    ]);
    expect(r.app).toEqual({ url: "http://localhost:8787", reachable: true, accountExists: false });
    expect(Object.keys(r).sort()).toEqual(["app", "services"]);
  });

  it("docker missing: one line, exit 1", async () => {
    const rig = makeRig({ dockerMissing: true });
    expect(await status(rig.ctx, { json: false })).toBe(1);
    expect(rig.out.lines).toHaveLength(1);
    expect(rig.out.text).toMatch(/^docker is not available/);
  });
});
