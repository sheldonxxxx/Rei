// A second stack on one machine: REI_ENV_DIR picks the directory of its .env and .secrets/, and REI_PROJECT and REI_NET
// (from the environment, else that .env) pick its compose projects, names and subnets. The defaults are the first stack's.
import { describe, expect, it } from "vitest";
import { clashes, parseNetworks, subnetCheck } from "../src/checks/subnets.ts";
import { doctor } from "../src/commands/doctor.ts";
import { dotenvPath, makeCtx, networkName, publishSetting, secretsPath, volumeName } from "../src/ctx.ts";
import { initSecrets } from "../src/init.ts";
import type { Runner, RunOptions } from "../src/io.ts";
import { phrase } from "../src/layout.ts";
import {
  dodaiProject,
  envDir,
  expandPath,
  projectPrefix,
  reiProject,
  stackNet,
  stackProblem,
  withStackVars,
} from "../src/stack.ts";
import { FakeClock, FakeHost, FakeOut, FakePrompter, HOME_REI, makeRig, ROOT, SET_UP_SECRETS } from "./fakes.ts";

const HOME = "/Users/tester";
const TEST_DIR = `${HOME}/.rei-test`;
const SECOND = "REI_PROJECT=rei-test\nREI_NET=10.90\nREI_PUBLISH=127.0.0.1:8788\nREI_COOKIE_SECURE=0\n";

/** A rig whose stack is the second one: .env and secrets.env in ~/.rei-test. */
const second = (env: Record<string, string | undefined> = {}, text = SECOND) =>
  makeRig({
    env,
    envDir: TEST_DIR,
    files: { [`${TEST_DIR}/.env`]: text, [`${TEST_DIR}/.secrets/secrets.env`]: SET_UP_SECRETS },
  });

describe("REI_ENV_DIR", () => {
  it("defaults to the compose files' directory", () => {
    expect(envDir({}, "/repo/containers", "/work", HOME)).toBe("/repo/containers");
    expect(envDir({ REI_ENV_DIR: "  " }, "/repo/containers", "/work", HOME)).toBe("/repo/containers");
  });

  it("takes a relative path from the current directory", () => {
    expect(envDir({ REI_ENV_DIR: "stacks/test" }, "/repo/containers", "/work", HOME)).toBe("/work/stacks/test");
    expect(envDir({ REI_ENV_DIR: "../other" }, "/repo/containers", "/work/here", HOME)).toBe("/work/other");
  });

  it("expands ~ and ~/ to the home directory, and keeps an absolute path", () => {
    expect(envDir({ REI_ENV_DIR: "~" }, "/repo/containers", "/work", HOME)).toBe(HOME);
    expect(envDir({ REI_ENV_DIR: "~/.rei-test" }, "/repo/containers", "/work", HOME)).toBe(TEST_DIR);
    expect(expandPath("/srv/rei-test", "/work", HOME)).toBe("/srv/rei-test");
  });

  it("is where the CLI reads and writes .env and secrets.env, while the compose files stay put", async () => {
    const r = makeRig({ checkout: false, envDir: TEST_DIR });
    expect(dotenvPath(r.ctx)).toBe(`${TEST_DIR}/.env`);
    expect(secretsPath(r.ctx)).toBe(`${TEST_DIR}/.secrets/secrets.env`);
    expect(r.ctx.composeFile).toBe(`${ROOT}/containers/compose.yaml`);
    expect(await initSecrets(r.ctx, () => {})).toBe(0);
    expect(r.host.files.get(`${TEST_DIR}/.env`)?.text).toBe("");
    expect(r.host.files.get(`${TEST_DIR}/.secrets/secrets.env`)?.mode).toBe(0o600);
    expect(r.host.files.has(`${ROOT}/containers/.secrets/secrets.env`)).toBe(false);
  });

  it("hands compose the env files of that directory, not the ones next to the compose files", () => {
    const r = second();
    const args = r.ctx.compose.args(["ps"]);
    expect(args.slice(0, 5)).toEqual([
      "compose",
      "--env-file",
      `${TEST_DIR}/.env`,
      "--env-file",
      `${TEST_DIR}/.secrets/secrets.env`,
    ]);
    expect(r.ctx.shared.command("ps")).toContain(`--env-file ${TEST_DIR}/.env`);
  });

  it("works in image mode too, where REI_HOME stays the default", () => {
    const own = makeRig({ image: true });
    expect(own.ctx.envDir).toBe(HOME_REI);
    const other = makeRig({ image: true, envDir: TEST_DIR, files: { [`${TEST_DIR}/.env`]: SECOND } });
    expect(other.ctx.containersDir).toBe(HOME_REI);
    expect(other.ctx.compose.files).toEqual([`${HOME_REI}/compose.yaml`]);
    expect(other.ctx.compose.project).toBe("rei-test");
    expect(dotenvPath(other.ctx)).toBe(`${TEST_DIR}/.env`);
  });

  it("is named in messages in place of containers/.env and containers/.secrets", () => {
    expect(phrase("fix REI_PUBLISH in containers/.env", "source", "/repo/containers", HOME, TEST_DIR)).toBe(
      "fix REI_PUBLISH in ~/.rei-test/.env",
    );
    expect(phrase("see containers/.secrets/secrets.env", "image", HOME_REI, HOME, "/srv/x")).toBe(
      "see /srv/x/.secrets/secrets.env",
    );
    expect(phrase("run ./rei setup with containers/.env", "source", "/repo/containers", HOME)).toBe(
      "run ./rei setup with containers/.env",
    );
    const r = second();
    r.ctx.out.line("set it in containers/.env");
    expect(r.out.text).toBe("set it in ~/.rei-test/.env");
  });
});

describe("the stack's variables", () => {
  it("come from the env directory's .env when the environment does not set them", () => {
    const r = second();
    expect(r.ctx.env.REI_PROJECT).toBe("rei-test");
    expect(r.ctx.env.REI_NET).toBe("10.90");
    expect(publishSetting(r.ctx)).toBe("127.0.0.1:8788");
  });

  it("the environment wins over the .env, and an empty value counts as unset", () => {
    const merged = withStackVars(
      { REI_PROJECT: "rei-other", REI_NET: "" },
      new Map([
        ["REI_PROJECT", "rei-test"],
        ["REI_NET", "10.90"],
      ]),
    );
    expect(merged.REI_PROJECT).toBe("rei-other");
    expect(merged.REI_NET).toBe("10.90");
    const r = second({ REI_PROJECT: "rei-other", REI_NET: "10.91", REI_PUBLISH: "127.0.0.1:8789" });
    expect(r.ctx.compose.project).toBe("rei-other");
    expect(r.ctx.shared.project).toBe("rei-other-dodai");
    expect(r.ctx.env.REI_NET).toBe("10.91");
    expect(publishSetting(r.ctx)).toBe("127.0.0.1:8789");
  });

  it("give each project its own compose -p, volumes and network names", () => {
    const r = second();
    expect(r.ctx.compose.args(["ps"])).toEqual(expect.arrayContaining(["-p", "rei-test"]));
    expect(r.ctx.shared.args(["ps"])).toEqual(expect.arrayContaining(["-p", "rei-test-dodai"]));
    expect(volumeName(r.ctx, "gateway-data")).toBe("rei-test_gateway-data");
    expect(networkName(r.ctx, "storage-shared")).toBe("rei-test-storage-shared");
  });

  it("leave the first stack exactly as it was: no -p, and rei-… names, also when REI_PROJECT=rei is written out", () => {
    for (const r of [makeRig(), makeRig({ env: { REI_PROJECT: "rei" } })]) {
      expect(r.ctx.compose.project).toBeUndefined();
      expect(r.ctx.shared.project).toBeUndefined();
      expect(r.ctx.compose.args(["ps"])).not.toContain("-p");
      expect(volumeName(r.ctx, "qdrant-data")).toBe("rei_qdrant-data");
      expect(networkName(r.ctx, "gateway-shared")).toBe("rei-gateway-shared");
    }
    expect(reiProject({ REI_PROJECT: " rei " })).toBeUndefined();
    expect(dodaiProject({})).toBeUndefined();
    expect(projectPrefix({ REI_PROJECT: "" })).toBe("rei");
    expect(stackNet({})).toBe("10.89");
  });

  it("reach every process the CLI starts, so compose and the smoke scripts mean the same stack", async () => {
    const seen: { cmd: string; env: RunOptions["env"] }[] = [];
    const runner: Runner = {
      run: async (cmd, _args, opts) => {
        seen.push({ cmd, env: opts?.env });
        return { code: 0, stdout: "", stderr: "" };
      },
      interactive: async (cmd, _args, opts) => {
        seen.push({ cmd, env: opts?.env });
        return 0;
      },
    };
    const host = new FakeHost();
    host.files.set(`${TEST_DIR}/.env`, { text: SECOND, mode: 0o644 });
    const ctx = makeCtx({
      root: ROOT,
      envDir: TEST_DIR,
      runner,
      out: new FakeOut(),
      clock: new FakeClock(),
      host,
      prompter: new FakePrompter(null),
      fetch: globalThis.fetch,
      env: {},
    });
    await ctx.compose.run(["ps"], { env: { EXTRA: "1" } });
    await ctx.shared.interactive(["up", "-d"]);
    await ctx.runner.run("/repo/containers/smoke-exec.sh", []);
    const want = { REI_ENV_DIR: TEST_DIR, REI_PROJECT: "rei-test", REI_NET: "10.90" };
    expect(seen[0]?.env).toEqual({ EXTRA: "1", ...want });
    expect(seen[1]?.env).toEqual(want);
    expect(seen[2]).toEqual({ cmd: "/repo/containers/smoke-exec.sh", env: want });
  });
});

describe("the guard", () => {
  it("accepts the first stack and a second one with its own REI_NET", () => {
    expect(stackProblem({})).toBeUndefined();
    expect(stackProblem({ REI_PROJECT: "rei" })).toBeUndefined();
    expect(stackProblem({ REI_PROJECT: "rei", REI_NET: "10.89" })).toBeUndefined();
    expect(stackProblem({ REI_NET: "172.30" })).toBeUndefined();
    expect(stackProblem({ REI_PROJECT: "rei-test", REI_NET: "10.90" })).toBeUndefined();
    expect(stackProblem({ REI_PROJECT: "rei_2", REI_NET: "0.255" })).toBeUndefined();
  });

  it("refuses another project on the first stack's subnets", () => {
    expect(stackProblem({ REI_PROJECT: "rei-test" })).toMatch(/REI_NET is not set \(10\.89\)/);
    expect(stackProblem({ REI_PROJECT: "rei-test", REI_NET: "10.89" })).toMatch(/REI_NET is the default/);
    const r = second({}, "REI_PROJECT=rei-test\n");
    expect(stackProblem(r.ctx.env)).toMatch(/for example 10\.90/);
  });

  it("refuses an REI_NET that is not two octets, and a project name compose or docker would reject", () => {
    for (const net of ["10", "10.90.1", "10.256", "a.b", "10.-1", "10.090", " . "])
      expect(stackProblem({ REI_PROJECT: "rei-test", REI_NET: net }), net).toMatch(/two octets/);
    for (const project of ["Rei", "-rei", "rei test", "rei/x"])
      expect(stackProblem({ REI_PROJECT: project, REI_NET: "10.90" }), project).toMatch(/lowercase/);
  });
});

describe("the subnet check", () => {
  const NETWORKS = [
    "bridge 172.17.0.0/16 ",
    "rei_internal 10.89.231.0/24 ",
    "rei-gateway-shared 10.89.234.0/24 ",
    "rei-storage 10.89.237.0/24 ",
    "host ",
    "other 10.90.0.0/16 fd00::/64 ",
  ].join("\n");

  it("parses docker's lines", () => {
    expect(parseNetworks("a 10.0.0.0/24 \nnone \n\n")).toEqual([
      { name: "a", subnets: ["10.0.0.0/24"] },
      { name: "none", subnets: [] },
    ]);
  });

  it("expects the stack's own networks on its subnets and names any other network there", () => {
    const nets = parseNetworks(NETWORKS);
    expect(clashes(nets, "10.89", "rei")).toEqual([]);
    expect(clashes(nets, "10.89", "rei-test")).toEqual([
      "rei_internal (10.89.231.0/24)",
      "rei-gateway-shared (10.89.234.0/24)",
      "rei-storage (10.89.237.0/24)",
    ]);
    expect(clashes(nets, "10.90", "rei-test")).toEqual(["other (10.90.0.0/16)"]);
    expect(clashes(nets, "10.91", "rei-test")).toEqual([]);
  });

  it("warns in doctor, and passes when the subnets are free", async () => {
    const busy = makeRig({
      networks: NETWORKS,
      envDir: TEST_DIR,
      files: { [`${TEST_DIR}/.env`]: "REI_PROJECT=rei-test\nREI_NET=10.90\n" },
    });
    expect(await subnetCheck(busy.ctx)).toMatchObject({ status: "warn", detail: expect.stringContaining("other") });
    const free = makeRig({ networks: NETWORKS });
    expect(await subnetCheck(free.ctx)).toMatchObject({ status: "ok" });
    await doctor(free.ctx, { json: false });
    expect(free.out.text).toMatch(/ok {3}subnets +10\.89\.231\.0\/24 to 10\.89\.238\.0\/24 free/);
  });

  it("warns instead of failing when docker cannot list its networks", async () => {
    const r = makeRig();
    const runner: Runner = { ...r.ctx.runner, run: async () => ({ code: 1, stdout: "", stderr: "boom" }) };
    expect(await subnetCheck({ ...r.ctx, runner })).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("boom"),
    });
  });
});
