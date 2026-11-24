import { describe, expect, it } from "vitest";
import { setupCode } from "../src/commands/setup-code.ts";
import { makeRig } from "./fakes.ts";

describe("setup-code", () => {
  it("shows the code and where to open Rei while the first account is still to be created", async () => {
    const rig = makeRig({ setupRequired: true, setupCode: "ABCD-1234" });
    expect(await setupCode(rig.ctx)).toBe(0);
    expect(rig.out.text).toContain("http://localhost:8787");
    expect(rig.out.text).toContain("    ABCD-1234");
  });

  it("reads the code from control's setup-code file, and only that", async () => {
    const rig = makeRig({ setupRequired: true, setupCode: "ABCD-1234" });
    await setupCode(rig.ctx);
    expect(rig.stack.compose.filter((c) => c.includes("exec"))).toEqual(["exec -T control cat /data/setup-code.txt"]);
  });

  it("says the account exists and points at sign-in, without reading any code", async () => {
    const rig = makeRig({ setupRequired: false });
    expect(await setupCode(rig.ctx)).toBe(0);
    expect(rig.out.text).toContain("Rei already has an account. Sign in at http://localhost:8787");
    expect(rig.stack.compose.some((c) => c.includes("cat"))).toBe(false);
  });

  it("a missing code file is a failure that says where the code is logged", async () => {
    const rig = makeRig({ setupRequired: true, setupCode: null });
    expect(await setupCode(rig.ctx)).toBe(1);
    expect(rig.out.text).toContain("The setup code was not found");
    expect(rig.out.text).toContain("logs control");
  });

  it("an app that does not answer is a failure that says to start Rei", async () => {
    const rig = makeRig({ appDown: true });
    expect(await setupCode(rig.ctx)).toBe(1);
    expect(rig.out.text).toContain("did not answer from here");
    expect(rig.out.text).toContain("./rei start");
  });

  it("never changes the stack", async () => {
    const rig = makeRig({ setupRequired: true, setupCode: "ABCD-1234" });
    await setupCode(rig.ctx);
    expect(rig.stack.mutating).toEqual([]);
    expect(rig.host.writes).toEqual([]);
  });
});
