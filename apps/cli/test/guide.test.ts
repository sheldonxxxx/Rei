import { describe, expect, it } from "vitest";
import { type SetupOptions, setup } from "../src/commands/setup.ts";
import { useGuide } from "../src/guide.ts";
import type { Guide } from "../src/io.ts";
import { makeRig, ROOT } from "./fakes.ts";

const OPTIONS: SetupOptions = { nonInteractive: false, skipBuild: false };
const ENV = `${ROOT}/containers/.env`;

function guided(options: Parameters<typeof makeRig>[0] = {}) {
  const r = makeRig({ answers: [], ...options });
  const messages: string[] = [];
  const tasks: string[] = [];
  const guide: Guide = {
    intro: (text) => {
      messages.push(text);
    },
    outro: (text) => {
      messages.push(text);
    },
    message: (text) => {
      messages.push(text);
    },
    task: async (text, work) => {
      tasks.push(text);
      return work();
    },
  };
  r.ctx.guide = guide;
  // Captured commands in guided mode do the same scripted work as inherited commands in basic mode.
  const run = r.stack.run.bind(r.stack);
  r.stack.run = async (cmd, args, opts) => {
    if (cmd.endsWith("init.sh") || cmd === "npm" || (cmd === "docker" && args.includes("up"))) {
      return { code: await r.stack.interactive(cmd, args), stdout: "verbose build output", stderr: "" };
    }
    return run(cmd, args, opts);
  };
  return { ...r, messages, tasks };
}

describe("guided CLI", () => {
  it("uses the basic interface for scripts, JSON, CI and limited terminals", () => {
    expect(useGuide([], {}, true)).toBe(true);
    for (const args of [["--basic"], ["--json"], ["--non-interactive"]]) expect(useGuide(args, {}, true)).toBe(false);
    expect(useGuide([], { TERM: "dumb" }, true)).toBe(false);
    expect(useGuide([], { CI: "true" }, true)).toBe(false);
    expect(useGuide([], {}, false)).toBe(false);
  });

  it("sets up with included search, hides successful technical output and shows the account link/code", async () => {
    const r = guided({ setupRequired: true, setupCode: "REVIEW-CODE" });
    expect(await setup(r.ctx, OPTIONS)).toBe(0);
    expect(r.tasks).toContain("Starting Rei…");
    expect(r.out.text).toContain("http://localhost:8787");
    expect(r.out.text).toContain("REVIEW-CODE");
    expect(r.out.text).not.toContain("verbose build output");
    expect(r.messages.join("\n")).not.toContain("brave off");
    expect(r.prompter.asked).toEqual([]);
  });

  it("setup keeps existing settings and never downloads a model", async () => {
    const r = guided({ fresh: true });
    r.host.files.set(ENV, {
      text: "COMPOSE_PROFILES=searxng\nREI_TZ=Asia/Macau\nREI_PUBLISH=127.0.0.1:8788\n",
      mode: 0o644,
    });
    expect(await setup(r.ctx, OPTIONS)).toBe(0);
    expect(r.host.files.get(ENV)?.text).not.toContain("REI_EMBEDDER_PROVIDER");
    expect(r.host.files.get(ENV)?.text).toContain("REI_PUBLISH=127.0.0.1:8788");
    expect(r.messages.join("\n")).not.toContain("model download");
    expect(r.stack.calls.some((c) => c.includes("download"))).toBe(false);
  });

  it("fresh setup leaves memory configuration to the web", async () => {
    const r = guided({ fresh: true });
    expect(await setup(r.ctx, OPTIONS)).toBe(0);
    expect(r.prompter.asked).toEqual([]);
    expect(r.host.files.get(ENV)?.text).not.toContain("REI_EMBEDDER_PROVIDER");
  });

  it("reports failed preparation and never starts services or claims completion", async () => {
    const r = guided();
    const run = r.stack.run.bind(r.stack);
    r.stack.run = async (cmd, args, opts) =>
      cmd === "npm" ? { code: 1, stdout: "", stderr: "Build could not finish" } : run(cmd, args, opts);
    expect(await setup(r.ctx, OPTIONS)).toBe(1);
    expect(r.messages.join("\n")).toContain("Build could not finish");
    expect(r.messages.join("\n")).toContain("Setup stopped");
    expect(r.stack.mutating).toEqual([]);
    expect(r.out.text).not.toContain("Done.");
  });
});
