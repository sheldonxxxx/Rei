import { describe, expect, it } from "vitest";
import type { LifecycleAction } from "../src/commands/lifecycle.ts";
import { lifecycle } from "../src/commands/lifecycle.ts";
import { makeRig } from "./fakes.ts";

describe("stack lifecycle commands", () => {
  it.each([
    ["start", false, ["shared: up -d --wait", "up -d"]],
    ["stop", false, ["stop"]],
    ["restart", false, ["restart"]],
    ["stop", true, ["stop", "shared: stop"]],
    ["restart", true, ["shared: restart", "restart"]],
  ] as const)("%s (all: %s) invokes docker compose in order", async (action, all, composeCommands) => {
    const rig = makeRig();

    expect(await lifecycle(rig.ctx, action as LifecycleAction, { all })).toBe(0);
    expect(rig.stack.compose).toEqual(composeCommands);
    expect(rig.out.text).toContain(action === "stop" ? "Its data is preserved" : "Rei services");
    expect(rig.out.text.includes("was left running")).toBe(action !== "start" && !all);
  });

  it("removes a gateway container left in Rei's own project before starting the shared one", async () => {
    const rig = makeRig({ legacyGateway: true });

    expect(await lifecycle(rig.ctx, "start")).toBe(0);
    expect(rig.stack.calls.filter((c) => /^(rm|compose: (shared: )?up)/.test(c))).toEqual([
      "rm -f legacy-gateway-id",
      "compose: shared: up -d --wait",
      "compose: up -d",
    ]);
  });

  it("removes Garage and Qdrant left in Rei's own project before Dodai starts, then the old network once Rei is up", async () => {
    const rig = makeRig({ legacyStorage: true });

    expect(await lifecycle(rig.ctx, "start")).toBe(0);
    expect(rig.stack.calls.filter((c) => /^(rm|network rm|compose: (shared: )?up)/.test(c))).toEqual([
      "rm -f legacy-garage-id legacy-qdrant-id",
      "compose: shared: up -d --wait",
      "compose: up -d",
      "network rm rei_storage",
    ]);
  });

  it("start refuses to run when a storage volume is missing and says to run setup", async () => {
    const rig = makeRig({ missingVolumes: ["rei_garage-meta", "rei_qdrant-data"] });

    expect(await lifecycle(rig.ctx, "start")).toBe(1);
    expect(rig.out.text).toContain("rei_garage-meta, rei_qdrant-data");
    expect(rig.out.text).toContain("./rei setup");
    expect(rig.stack.mutating).toEqual([]);
  });

  it("does not start Rei when the shared services fail to start", async () => {
    const rig = makeRig();
    rig.stack.interactive = async () => 9;

    expect(await lifecycle(rig.ctx, "start")).toBe(9);
    expect(rig.out.text).toContain("Could not start Rei");
  });

  it("reports a failed compose operation and returns its exit code", async () => {
    const rig = makeRig();
    rig.stack.interactive = async () => 17;

    expect(await lifecycle(rig.ctx, "restart")).toBe(17);
    expect(rig.out.text).toContain("Could not restart Rei (docker compose exited 17).");
  });

  it("runs the guided task and displays compose diagnostics on failure", async () => {
    const rig = makeRig();
    const messages: string[] = [];
    let task = "";
    rig.ctx.guide = {
      intro: () => {},
      outro: (message) => messages.push(message),
      message: (message) => messages.push(message),
      async task<T>(message: string, work: () => Promise<T>): Promise<T> {
        task = message;
        return work();
      },
    };
    const run = rig.stack.run.bind(rig.stack);
    rig.stack.run = async (cmd, args, opts) =>
      args[0] === "compose" ? { code: 3, stdout: "", stderr: "compose failed" } : run(cmd, args, opts);

    expect(await lifecycle(rig.ctx, "start")).toBe(3);
    expect(task).toBe("Starting Rei…");
    expect(messages).toEqual(["compose failed", "Could not start Rei (docker compose exited 3)."]);
  });
});
