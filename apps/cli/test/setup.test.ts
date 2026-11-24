import { describe, expect, it } from "vitest";
import type { SetupOptions } from "../src/commands/setup.ts";
import { setup } from "../src/commands/setup.ts";
import type { Rig } from "./fakes.ts";
import { makeRig, ROOT, SECRET, SHARED, SHARED_BUILD } from "./fakes.ts";

const NON_INTERACTIVE: SetupOptions = { nonInteractive: true, skipBuild: false };
const MAJOR = /^(npm |compose: (shared: )?(up|run|stop|rm|--profile)|smoke-exec\.sh)/;
const major = (rig: Rig) => rig.stack.calls.filter((c) => MAJOR.test(c));
const ENV = `${ROOT}/containers/.env`;

describe("setup", () => {
  it("happy path on a fresh checkout: the commands in order, then the address and the setup code", async () => {
    const rig = makeRig({ fresh: true, checkout: false, setupRequired: true, setupCode: "ABCD-1234", answers: [] });
    expect(await setup(rig.ctx, { ...NON_INTERACTIVE, nonInteractive: false })).toBe(0);
    expect(major(rig)).toEqual([
      "npm ci",
      "npm run build -w @rei/web",
      "compose: shared: up -d --build --wait",
      "compose: up -d --build --remove-orphans",
      "smoke-exec.sh",
    ]);
    expect(rig.out.text).toContain("http://localhost:8787");
    expect(rig.out.text).toContain("ABCD-1234");
    expect(rig.prompter.asked).toEqual([]);
    // rei init ran first, in-process: the secrets exist before anything is started.
    expect(rig.host.files.get(`${ROOT}/containers/.secrets/secrets.env`)?.mode).toBe(0o600);
    expect(rig.out.text).toContain(`created ${ROOT}/containers/.secrets/secrets.env`);
  });

  it("polls until the services are healthy (a starting health check is waited for)", async () => {
    const rig = makeRig({ fresh: true, startingPolls: 3, answers: [] });
    const before = rig.clock.t;
    expect(await setup(rig.ctx, { ...NON_INTERACTIVE, nonInteractive: false })).toBe(0);
    expect(rig.clock.t - before).toBeGreaterThanOrEqual(2_000 * 3);
  });

  it("a second run on a set-up stack: no force-recreate, no key writes, no .env change", async () => {
    const rig = makeRig({ setupRequired: false });
    expect(await setup(rig.ctx, NON_INTERACTIVE)).toBe(0);
    expect(rig.stack.compose.some((c) => c.includes("--force-recreate"))).toBe(false);
    expect(rig.stack.compose.some((c) => c.startsWith("run"))).toBe(false);
    expect(rig.stack.compose.filter((c) => /^(shared: )?up/.test(c))).toEqual([
      "shared: up -d --build --wait",
      "up -d --build --remove-orphans",
    ]);
    expect(rig.host.writes).toEqual([]);
    expect(rig.out.text).toContain("Rei already has an account. Sign in at http://localhost:8787");
  });

  it("writes this machine's time zone to .env once, and keeps one that is set", async () => {
    const rig = makeRig();
    rig.host.files.set(ENV, { text: "COMPOSE_PROFILES=searxng\n", mode: 0o644 });
    rig.host.timeZone = "Europe/Lisbon";
    expect(await setup(rig.ctx, NON_INTERACTIVE)).toBe(0);
    expect(rig.host.files.get(ENV)?.text).toBe("COMPOSE_PROFILES=searxng\nREI_TZ=Europe/Lisbon\n");
    expect(rig.out.text).toContain("Europe/Lisbon set in containers/.env");

    const again = makeRig();
    again.host.timeZone = "Europe/Lisbon";
    expect(await setup(again.ctx, NON_INTERACTIVE)).toBe(0);
    expect(again.host.writes).toEqual([]);
    expect(again.out.text).toContain("Asia/Macau (REI_TZ in containers/.env)");
  });

  it("reports missing network names without recreating services", async () => {
    const rig = makeRig({ missingAlias: ["gateway"] });
    expect(await setup(rig.ctx, NON_INTERACTIVE)).toBe(1);
    expect(rig.stack.compose.filter((c) => c.includes("--force-recreate"))).toEqual([]);
    expect(rig.out.text).toContain("no network alias");
  });

  it("asks no questions: settings and the account are set up in the web app, even on an interactive terminal", async () => {
    const rig = makeRig({ answers: [] });
    expect(await setup(rig.ctx, { ...NON_INTERACTIVE, nonInteractive: false })).toBe(0);
    expect(rig.prompter.asked).toEqual([]);
    expect(rig.stack.compose.some((c) => c.startsWith("run"))).toBe(false);
  });

  it("services that do not become healthy: fail after 180 s, name them, point at their logs, and stop", async () => {
    const rig = makeRig({ fresh: true, stuck: ["gateway"], answers: [] });
    const before = rig.clock.t;
    expect(await setup(rig.ctx, { ...NON_INTERACTIVE, nonInteractive: false })).toBe(1);
    expect(rig.clock.t - before).toBeGreaterThanOrEqual(180_000);
    expect(rig.out.text).toMatch(/FAIL {1}services healthy +not healthy after 180 s: gateway \(running, unhealthy\)/);
    // In a checkout the fix names the build overlay too, so a command copied from it builds rather than pulls.
    expect(rig.out.text).toContain(
      `docker compose --env-file ${ROOT}/containers/.env --env-file ${ROOT}/containers/.secrets/secrets.env -f ${SHARED} -f ${SHARED_BUILD} logs gateway`,
    );
    expect(rig.out.text).toContain("Setup stopped");
    expect(major(rig)).not.toContain("smoke-exec.sh");
  });

  it("stops at the first failing preflight check: nothing is started", async () => {
    const busy = makeRig();
    busy.host.portIsFree = false;
    busy.stack.rows.delete("edge");
    expect(await setup(busy.ctx, NON_INTERACTIVE)).toBe(1);
    expect(busy.out.text).toContain("port 8787 is in use by something else");
    expect(busy.out.text).toContain("REI_PUBLISH");
    expect(major(busy)).toEqual([]);

    const noDocker = makeRig({ dockerMissing: true });
    expect(await setup(noDocker.ctx, NON_INTERACTIVE)).toBe(1);
    expect(noDocker.out.text).toContain("docker was not found");

    const oldNode = makeRig();
    oldNode.host.nodeVersion = "22.1.0";
    expect(await setup(oldNode.ctx, NON_INTERACTIVE)).toBe(1);
    expect(oldNode.out.text).toContain("node 22.1.0 is too old");
  });

  it("a port held by our own edge is fine; little disk space is only a warning", async () => {
    const rig = makeRig();
    rig.host.portIsFree = false;
    rig.host.free = 2 * 1024 ** 3;
    expect(await setup(rig.ctx, NON_INTERACTIVE)).toBe(0);
    expect(rig.out.text).toContain("held by this stack's edge");
    expect(rig.out.text).toMatch(/warn {1}disk +only 2\.0 GB free/);
  });

  it("--skip-build and a failing sandbox smoke", async () => {
    const rig = makeRig({
      smoke: { code: 1, stdout: "PASS  a\nFAIL  exec cannot reach control:8787 directly\n\n1 check(s) failed\n" },
    });
    expect(await setup(rig.ctx, { ...NON_INTERACTIVE, skipBuild: true })).toBe(1);
    expect(major(rig).some((c) => c.startsWith("npm run build"))).toBe(false);
    expect(rig.out.text).toContain("1 of 2 failed: exec cannot reach control:8787 directly");
  });

  it("passes the demo-tools variable on untouched: it never sets it", async () => {
    const rig = makeRig({ env: { REI_DEMO_TOOLS: "1" } });
    expect(await setup(rig.ctx, NON_INTERACTIVE)).toBe(0);
    expect(rig.ctx.env.REI_DEMO_TOOLS).toBe("1");
    expect(rig.host.writes).toEqual([]);
  });

  it("never writes a search or model key file, and never echoes a credential", async () => {
    const rig = makeRig({ answers: ["brave-key-AAAA1111BBBB2222", "", ""] });
    expect(await setup(rig.ctx, { ...NON_INTERACTIVE, nonInteractive: false })).toBe(0);
    expect(rig.prompter.asked).toEqual([]);
    expect([...rig.host.files.keys()].some((path) => path.includes(".secrets/search"))).toBe(false);
    expect(rig.host.writes).toEqual([]);
    expect(rig.out.text).not.toContain(SECRET);
  });
});

it("fresh setup stays free of memory settings and downloads no model", async () => {
  const r = makeRig({ fresh: true, checkout: false });
  expect(await setup(r.ctx, NON_INTERACTIVE)).toBe(0);
  expect(r.host.readText(ENV)).not.toContain("REI_EMBEDDER_PROVIDER");
  expect(r.stack.calls.some((c) => c.includes("download"))).toBe(false);
  expect(r.stack.mutating).toContain("up -d --build --remove-orphans");
});
