import { describe, expect, it, vi } from "vitest";
import { backupCheck } from "../src/checks/backup.ts";
import { backupCommand } from "../src/commands/backup.ts";
import type { RunOptions } from "../src/io.ts";
import { makeRig } from "./fakes.ts";

type Rig = ReturnType<typeof makeRig>;
const CLI = "src/node/backup-cli.ts";

/** What each interactive docker call was given (the environment included), and optionally one that fails. */
function watch(rig: Rig, failOn?: string) {
  const seen: { args: string[]; env: Record<string, string | undefined> | undefined }[] = [];
  const original = rig.stack.interactive.bind(rig.stack);
  rig.stack.interactive = async (cmd: string, args: string[], opts?: RunOptions) => {
    if (cmd === "docker") seen.push({ args, env: opts?.env });
    const sub = args[args.indexOf(CLI) + 1];
    if (failOn && sub === failOn) return 1;
    return original(cmd, args);
  };
  return seen;
}

/** The in-container subcommands that ran, in order. */
const subs = (seen: ReturnType<typeof watch>) =>
  seen.filter((s) => s.args.includes(CLI)).map((s) => s.args[s.args.indexOf(CLI) + 1]);
const tail = (seen: ReturnType<typeof watch>, sub: string) => {
  const call = seen.find((s) => s.args.includes(CLI) && s.args[s.args.indexOf(CLI) + 1] === sub);
  return call ? call.args.slice(call.args.indexOf(CLI) + 1) : undefined;
};

const base = { env: { REI_BACKUP_PASSWORD: "hunter2" } };

describe("rei backup snapshots", () => {
  it("lists through the running control plane when no repository is given", async () => {
    const rig = makeRig({});
    expect(await backupCommand(rig.ctx, ["snapshots"])).toBe(0);
    expect(rig.stack.compose).toContain(`exec -T control node ${CLI} snapshots`);
  });

  it("opens a repository folder with a one-off container, giving it the password only through the environment", async () => {
    const rig = makeRig(base);
    const seen = watch(rig);
    expect(await backupCommand(rig.ctx, ["snapshots", "--repo", "/mnt/backups", "--json"])).toBe(0);
    const call = seen.at(-1);
    expect(call?.args).toContain("/mnt/backups:/repo:ro");
    expect(call?.args.join(" ")).not.toContain("hunter2");
    expect(call?.env?.RESTIC_PASSWORD).toBe("hunter2");
    expect(tail(seen, "snapshots")).toEqual(["snapshots", "--json", "--repo", "/repo"]);
  });

  it("also reads RESTIC_PASSWORD", async () => {
    const rig = makeRig({ env: { RESTIC_PASSWORD: "legacy" } });
    const seen = watch(rig);
    expect(await backupCommand(rig.ctx, ["snapshots", "--repo", "/mnt/backups"])).toBe(0);
    expect(seen.at(-1)?.env?.RESTIC_PASSWORD).toBe("legacy");
  });

  it("needs a password it can ask for", async () => {
    const rig = makeRig({ answers: null });
    expect(await backupCommand(rig.ctx, ["snapshots", "--repo", "/mnt/backups"])).toBe(1);
  });
});

describe("rei backup restore", () => {
  it("says where to look when no repository is known", async () => {
    const rig = makeRig(base);
    expect(await backupCommand(rig.ctx, ["restore", "--yes"])).toBe(2);
  });

  it("rejects an unknown part before touching anything", async () => {
    const rig = makeRig(base);
    expect(await backupCommand(rig.ctx, ["restore", "--repo", "/b", "--only", "db,mail"])).toBe(2);
    expect(rig.stack.compose).toEqual([]);
  });

  it("fetches and verifies first, then stops, keeps copies, writes, uploads, resets the index, starts and checks", async () => {
    const rig = makeRig(base);
    const seen = watch(rig);
    expect(await backupCommand(rig.ctx, ["restore", "--repo", "/b", "--yes"])).toBe(0);
    expect(subs(seen)).toEqual(["fetch", "rollback", "apply", "objects", "index"]);
    const calls = rig.stack.compose;
    const at = (text: string) => calls.findIndex((c) => c.includes(text));
    expect(at(`${CLI} fetch`)).toBeGreaterThan(-1);
    expect(at(`${CLI} fetch`)).toBeLessThan(at("stop control"));
    expect(at("stop control")).toBeLessThan(at(`${CLI} rollback`));
    expect(at("shared: stop gateway")).toBeGreaterThan(-1);
    expect(at("shared: stop gateway")).toBeLessThan(at(`${CLI} rollback`));
    expect(at(`${CLI} index`)).toBeLessThan(calls.findIndex((c) => c.startsWith("shared: up")));
    expect(rig.out.text).toContain("pre-restore");
    // The temporary volume goes away; the rollback copies stay.
    expect(rig.stack.calls.some((c) => c.startsWith("volume rm") && c.includes("restore-"))).toBe(true);
    expect(rig.stack.calls.some((c) => c.startsWith("volume rm") && c.includes("pre-restore"))).toBe(false);
    const fetch = seen.find((s) => s.args.includes(`${CLI}`) && s.args.includes("fetch"));
    expect(fetch?.args).toEqual(expect.arrayContaining(["--user", "0", "-e", "RESTIC_PASSWORD", "/b:/repo:ro"]));
  });

  it("with --only db it leaves the gateway and the bucket alone", async () => {
    const rig = makeRig(base);
    const seen = watch(rig);
    expect(await backupCommand(rig.ctx, ["restore", "--repo", "/b", "--yes", "--only", "db"])).toBe(0);
    expect(rig.stack.compose.some((c) => c.includes("stop gateway"))).toBe(false);
    expect(subs(seen)).toEqual(["fetch", "rollback", "apply", "index"]);
  });

  it("with --only objects it stops nothing, and --prune-bucket is passed on", async () => {
    const rig = makeRig(base);
    const seen = watch(rig);
    expect(
      await backupCommand(rig.ctx, ["restore", "--repo", "/b", "--yes", "--only", "objects", "--prune-bucket"]),
    ).toBe(0);
    expect(rig.stack.compose.some((c) => /(^| )stop /.test(c))).toBe(false);
    expect(tail(seen, "objects")).toContain("--prune-bucket");
    expect(subs(seen)).not.toContain("index");
  });

  it("changes nothing when the backup cannot be fetched or is damaged", async () => {
    const rig = makeRig(base);
    watch(rig, "fetch");
    expect(await backupCommand(rig.ctx, ["restore", "--repo", "/b", "--yes"])).toBe(1);
    expect(rig.stack.compose.some((c) => /(^| )stop /.test(c))).toBe(false);
    expect(rig.stack.calls.some((c) => c.startsWith("volume rm") && c.includes("restore-"))).toBe(true);
  });

  it("leaves Rei stopped and says where the old data is when a later step fails", async () => {
    const rig = makeRig(base);
    watch(rig, "apply");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await backupCommand(rig.ctx, ["restore", "--repo", "/b", "--yes"])).toBe(1);
      const said = [...err.mock.calls, ...stderr.mock.calls].flat().join("\n");
      expect(said).toContain("pre-restore");
      expect(said).toContain("left stopped");
    } finally {
      err.mockRestore();
      stderr.mockRestore();
    }
    expect(rig.stack.compose.some((c) => /^(shared: )?up/.test(c))).toBe(false);
  });

  it("asks first, and declining changes nothing", async () => {
    const rig = makeRig({ ...base, answers: [], confirms: [{ match: "Restore this backup", answer: false }] });
    watch(rig);
    expect(await backupCommand(rig.ctx, ["restore", "--repo", "/b"])).toBe(0);
    expect(rig.stack.compose.some((c) => /(^| )stop /.test(c))).toBe(false);
  });

  it("without a terminal it refuses to go on without --yes", async () => {
    const rig = makeRig({ env: { REI_BACKUP_PASSWORD: "x" }, answers: null });
    watch(rig);
    expect(await backupCommand(rig.ctx, ["restore", "--repo", "/b"])).toBe(1);
    expect(rig.stack.compose.some((c) => /(^| )stop /.test(c))).toBe(false);
  });

  it("takes the repository from REI_BACKUP_DIR in the stack's .env", async () => {
    const rig = makeRig({ ...base, files: { "/repo/containers/.env": "REI_BACKUP_DIR=/srv/rei-backups\n" } });
    const seen = watch(rig);
    expect(await backupCommand(rig.ctx, ["restore", "--yes"])).toBe(0);
    const fetch = seen.find((s) => s.args.includes("fetch"));
    expect(fetch?.args).toContain("/srv/rei-backups:/repo:ro");
  });
});

describe("the backups check of doctor", () => {
  const answering = (stdout: string, code = 0) => {
    const rig = makeRig({});
    const original = rig.stack.run.bind(rig.stack);
    rig.stack.run = async (cmd: string, args: string[], opts?: RunOptions) =>
      args.some((a) => a.endsWith("backup-cli.ts")) ? { code, stdout, stderr: "" } : original(cmd, args, opts);
    return rig;
  };
  const health = (over: object) =>
    JSON.stringify({ enabled: true, stale: false, lastSuccessAt: null, lastFailure: null, ...over });

  it("warns when backups are off", async () => {
    const result = await backupCheck(answering(health({ enabled: false })).ctx);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("off");
  });

  it("warns when the last success is stale or the last run failed, and passes when it is recent", async () => {
    const rig = answering(health({ stale: true }));
    const now = rig.clock.now();
    const hour = 3_600_000;
    const stale = answering(health({ stale: true, lastSuccessAt: now - 50 * hour }));
    expect((await backupCheck(stale.ctx)).status).toBe("warn");
    const failed = answering(health({ lastSuccessAt: now - hour, lastFailure: "restic backup failed" }));
    const failedResult = await backupCheck(failed.ctx);
    expect(failedResult.status).toBe("warn");
    expect(failedResult.detail).toContain("failed");
    const good = answering(health({ lastSuccessAt: now - hour }));
    expect((await backupCheck(good.ctx)).status).toBe("ok");
  });

  it("skips when the control plane cannot say", async () => {
    expect((await backupCheck(answering("", 1).ctx)).status).toBe("skip");
    expect((await backupCheck(answering("not json").ctx)).status).toBe("skip");
  });
});
