import { describe, expect, it } from "vitest";
import { redeploy } from "../src/commands/redeploy.ts";
import { makeRig } from "./fakes.ts";

describe("redeploy", () => {
  it("recreates only Dodai's Rei-built services; Garage and Qdrant get a plain up", async () => {
    const rig = makeRig();
    rig.stack.handlers.push((cmd) => (cmd === "npm" ? { code: 0, stdout: "", stderr: "" } : undefined));

    expect(await redeploy(rig.ctx)).toBe(0);
    const ups = rig.stack.compose.filter((c) => c.includes("up "));
    expect(ups).toEqual([
      "shared: up -d --wait garage qdrant",
      "shared: up -d --force-recreate --wait gateway reader",
      "up -d --force-recreate --remove-orphans",
    ]);
    expect(rig.stack.compose.some((c) => /force-recreate.*(garage|qdrant)/.test(c))).toBe(false);
  });

  it("reuses Docker's build cache by default", async () => {
    const rig = makeRig();
    rig.stack.handlers.push((cmd) => (cmd === "npm" ? { code: 0, stdout: "", stderr: "" } : undefined));

    expect(await redeploy(rig.ctx)).toBe(0);
    expect(rig.stack.compose.filter((c) => /^(shared: )?build\b/.test(c))).toEqual(["shared: build", "build"]);
  });

  it("bypasses the build cache when --no-cache is given", async () => {
    const rig = makeRig();
    rig.stack.handlers.push((cmd) => (cmd === "npm" ? { code: 0, stdout: "", stderr: "" } : undefined));

    expect(await redeploy(rig.ctx, { noCache: true })).toBe(0);
    expect(rig.stack.compose.filter((c) => /^(shared: )?build\b/.test(c))).toEqual([
      "shared: build --no-cache",
      "build --no-cache",
    ]);
  });

  it("removes legacy storage containers first and the old network last", async () => {
    const rig = makeRig({ legacyStorage: true });
    rig.stack.handlers.push((cmd) => (cmd === "npm" ? { code: 0, stdout: "", stderr: "" } : undefined));

    expect(await redeploy(rig.ctx)).toBe(0);
    const order = rig.stack.calls.filter((c) => /^(rm|network rm|compose: (shared: )?up)/.test(c));
    expect(order[0]).toBe("rm -f legacy-garage-id legacy-qdrant-id");
    expect(order.at(-1)).toBe("network rm rei_storage");
  });
});
