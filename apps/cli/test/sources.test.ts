import { describe, expect, it, vi } from "vitest";
import { sources } from "../src/commands/sources.ts";
import type { Ctx } from "../src/ctx.ts";

const ctxWith = (state: string, interactive = vi.fn(async () => 0)) =>
  ({
    cli: "./rei",
    compose: { ps: async () => [{ service: "control", state }], interactive },
  }) as unknown as Ctx;

describe("rei sources", () => {
  it("forwards its arguments unchanged to the control plane's admin entry", async () => {
    const interactive = vi.fn(async () => 0);
    const code = await sources(ctxWith("running", interactive), ["add", "my-service", "--name", "My service"]);
    expect(code).toBe(0);
    expect(interactive).toHaveBeenCalledWith([
      "exec",
      "-T",
      "control",
      "node",
      "src/node/events-cli.ts",
      "sources",
      "add",
      "my-service",
      "--name",
      "My service",
    ]);
  });

  it("returns the admin entry's exit code", async () => {
    expect(
      await sources(
        ctxWith(
          "running",
          vi.fn(async () => 3),
        ),
        ["list"],
      ),
    ).toBe(3);
  });

  it("says Rei is not running instead of starting it", async () => {
    const interactive = vi.fn(async () => 0);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sources(ctxWith("exited", interactive), ["list"])).toBe(1);
    expect(error.mock.calls[0]?.[0]).toContain("./rei start");
    expect(interactive).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
