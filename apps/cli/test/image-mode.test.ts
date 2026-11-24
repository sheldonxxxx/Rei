import { describe, expect, it } from "vitest";
import { ASSET_FILES } from "../src/asset-files.ts";
import { redeploy } from "../src/commands/redeploy.ts";
import { setup } from "../src/commands/setup.ts";
import { upgrade } from "../src/commands/upgrade.ts";
import { locate, phrase, reiHome } from "../src/layout.ts";
import { UPDATE_CACHE, updateNotice } from "../src/update-check.ts";
import { compareVersions, isVersion } from "../src/version.ts";
import type { Rig } from "./fakes.ts";
import { ASSETS, assetText, HOME_REI, makeRig, SET_UP_SECRETS } from "./fakes.ts";

const MAJOR = /^(npm |compose: (shared: )?(up|pull|run|stop|rm|--profile)|smoke-exec\.sh)/;
const major = (rig: Rig) => rig.stack.calls.filter((c) => MAJOR.test(c));
const MARKER = `${HOME_REI}/.installed-version`;

describe("layout", () => {
  const exists = (paths: string[]) => (path: string) => paths.includes(path);

  it("a bundle with assets/ beside it runs from REI_HOME, default ~/.rei", () => {
    const here = "/npm/lib/node_modules/rei-ai/dist";
    const found = exists([`${ASSETS}/compose.yaml`]);
    expect(locate(here, {}, "/Users/tester", found)).toEqual({
      root: HOME_REI,
      containersDir: HOME_REI,
      assetsDir: ASSETS,
    });
    expect(locate(here, { REI_HOME: "~/rei-test" }, "/Users/tester", found).containersDir).toBe(
      "/Users/tester/rei-test",
    );
    expect(locate(here, { REI_HOME: "/srv/rei" }, "/Users/tester", found).containersDir).toBe("/srv/rei");
  });

  it("a checkout runs from <repo>/containers, whatever REI_HOME says", () => {
    expect(locate("/repo/apps/cli/src", { REI_HOME: "/srv/rei" }, "/Users/tester", exists([]))).toEqual({
      root: "/repo",
      containersDir: "/repo/containers",
    });
  });

  it("REI_HOME of ~ alone, or blank, still names a folder", () => {
    expect(reiHome({ REI_HOME: "~" }, "/home/u")).toBe("/home/u");
    expect(reiHome({ REI_HOME: "  " }, "/home/u")).toBe("/home/u/.rei");
  });

  it("an npm installation's messages say rei, its own folder and rei init; a checkout's are unchanged", () => {
    const text =
      "Run ./rei setup again. Edit containers/.env, then containers/init.sh (see docs/storage.md and /repo/containers/x).";
    expect(phrase(text, "image", HOME_REI, "/Users/tester")).toBe(
      "Run rei setup again. Edit ~/.rei/.env, then rei init (see docs/storage.md and /repo/containers/x).",
    );
    expect(phrase(text, "image", "/srv/rei", "/Users/tester")).toContain("Edit /srv/rei/.env");
    expect(phrase(text, "source", HOME_REI, "/Users/tester")).toBe(text);
  });
});

describe("versions", () => {
  it("orders releases and pre-releases the semver way", () => {
    const sorted = ["0.9.0", "1.0.0-rc.1", "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0", "1.0.1", "1.10.0", "2.0.0-alpha"];
    for (let i = 1; i < sorted.length; i++) expect(compareVersions(sorted[i - 1]!, sorted[i]!)).toBeLessThan(0);
    expect(compareVersions("v1.2.3", "1.2.3+build.5")).toBe(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(isVersion("1.2")).toBe(false);
    expect(() => compareVersions("dev", "1.0.0")).toThrow(/not a version: dev/);
  });
});

describe("setup from an npm installation", () => {
  it("writes the package's files into REI_HOME, makes the secrets, pulls, starts without building", async () => {
    const rig = makeRig({ image: true, fresh: true, checkout: false, setupRequired: true, answers: [] });
    expect(rig.ctx.mode).toBe("image");
    expect(rig.ctx.cli).toBe("rei");
    expect(await setup(rig.ctx, { nonInteractive: true, skipBuild: false })).toBe(0);
    expect(major(rig)).toEqual([
      "compose: shared: pull",
      "compose: pull",
      "compose: shared: up -d --no-build --wait",
      "compose: up -d --no-build --wait --remove-orphans",
      "smoke-exec.sh",
    ]);
    for (const f of ASSET_FILES)
      expect(rig.host.files.get(`${HOME_REI}/${f.path}`), f.path).toEqual({ text: assetText(f.path), mode: f.mode });
    expect(rig.host.files.get(`${HOME_REI}/.secrets/secrets.env`)?.mode).toBe(0o600);
    expect(rig.host.readText(MARKER)).toBe("1.2.0\n");
    // Said the way this installation is run.
    expect(rig.out.text).not.toMatch(/\.\/rei|containers\//);
    expect(rig.out.text).toContain("set in ~/.rei/.env");
    expect(rig.host.writes.map((w) => w.path)).not.toContain(`${ASSETS}/compose.yaml`);
  });

  it("keeps an existing .env and secrets.env exactly, and rewrites only files that changed", async () => {
    const rig = makeRig({ image: true, answers: [] });
    rig.host.files.set(`${HOME_REI}/compose.yaml`, { text: "old\n", mode: 0o644 });
    expect(await setup(rig.ctx, { nonInteractive: true, skipBuild: false })).toBe(0);
    expect(rig.host.readText(`${HOME_REI}/.secrets/secrets.env`)).toBe(SET_UP_SECRETS);
    expect(rig.host.readText(`${HOME_REI}/.env`)).toBe("REI_TZ=Asia/Macau\n");
    expect(rig.host.writes.map((w) => w.path)).toEqual([
      `${HOME_REI}/compose.yaml.tmp`,
      `${HOME_REI}/compose.yaml`,
      MARKER,
    ]);
    expect(rig.host.readText(`${HOME_REI}/compose.yaml`)).toBe(assetText("compose.yaml"));
  });

  it("an installation of another release is moved with rei upgrade, not setup", async () => {
    const rig = makeRig({ image: true, installed: "1.1.0", answers: [] });
    expect(await setup(rig.ctx, { nonInteractive: true, skipBuild: false })).toBe(1);
    expect(rig.out.text).toContain(`${HOME_REI} runs Rei 1.1.0, and this is 1.2.0`);
    expect(rig.out.text).toContain("run rei upgrade");
    expect(rig.stack.compose.filter((c) => /pull|up/.test(c))).toEqual([]);
    expect(rig.host.writes).toEqual([]);
  });

  it("rei redeploy points an npm installation to rei upgrade", async () => {
    const rig = makeRig({ image: true });
    expect(await redeploy(rig.ctx)).toBe(2);
    expect(rig.out.text).toContain("rei upgrade");
    expect(rig.stack.mutating).toEqual([]);
  });
});

describe("rei upgrade", () => {
  it("copies the configuration aside, writes the new files, pulls, recreates, then checks", async () => {
    const rig = makeRig({ image: true, installed: "1.1.0" });
    rig.host.files.set(`${HOME_REI}/compose.yaml`, { text: "the 1.1.0 compose file\n", mode: 0o644 });
    const code = await upgrade(rig.ctx, { force: false });
    expect(code).toBe(0);
    expect(major(rig)).toEqual([
      "compose: shared: pull",
      "compose: pull",
      "compose: shared: up -d --no-build --wait",
      "compose: up -d --no-build --wait --remove-orphans",
      "smoke-exec.sh",
    ]);
    const backup = [...rig.host.files.keys()].find((p) => p.endsWith("-1.1.0/compose.yaml"));
    expect(backup).toMatch(new RegExp(`^${HOME_REI}/backups/2023-11-14T22-13-20-000Z-1\\.1\\.0/compose\\.yaml$`));
    const dir = backup!.replace(/\/compose\.yaml$/, "");
    expect(rig.host.readText(backup!)).toBe("the 1.1.0 compose file\n");
    expect(rig.host.files.get(`${dir}/.secrets/secrets.env`)).toEqual({ text: SET_UP_SECRETS, mode: 0o600 });
    expect(rig.host.readText(`${dir}/.installed-version`)).toBe("1.1.0\n");
    expect(rig.host.dirs).toContain(dir);
    expect(rig.host.readText(`${HOME_REI}/compose.yaml`)).toBe(assetText("compose.yaml"));
    expect(rig.host.readText(`${HOME_REI}/.secrets/secrets.env`)).toBe(SET_UP_SECRETS);
    expect(rig.host.readText(MARKER)).toBe("1.2.0\n");
    expect(rig.out.text).toContain("Upgrading Rei from 1.1.0 to 1.2.0");
    expect(rig.out.text).toContain("Data volumes are not copied");
    // doctor ran on the new stack.
    expect(rig.out.text).toMatch(/docker daemon/);
  });

  it("refuses a downgrade without --force, and changes nothing", async () => {
    const rig = makeRig({ image: true, installed: "1.3.0" });
    expect(await upgrade(rig.ctx, { force: false })).toBe(1);
    expect(rig.out.text).toContain("This installation runs Rei 1.3.0, newer than this CLI (1.2.0)");
    expect(rig.host.writes).toEqual([]);
    expect(rig.stack.compose).toEqual([]);

    const forced = makeRig({ image: true, installed: "1.3.0" });
    expect(await upgrade(forced.ctx, { force: true })).toBe(0);
    expect(forced.host.readText(MARKER)).toBe("1.2.0\n");
  });

  it("stops before recreating anything when the images cannot be pulled", async () => {
    const rig = makeRig({ image: true, installed: "1.1.0" });
    const run = rig.stack.interactive.bind(rig.stack);
    rig.stack.interactive = async (cmd: string, args: string[]) => (args.includes("pull") ? 1 : run(cmd, args));
    expect(await upgrade(rig.ctx, { force: false })).toBe(1);
    expect(rig.out.text).toContain("Could not pull Dodai's images");
    expect(rig.out.text).toContain("The running containers were not changed.");
    expect(rig.stack.mutating).toEqual([]);
    expect(rig.host.readText(MARKER)).toBe("1.1.0\n");
  });

  it("needs a set-up installation, and is not for a checkout", async () => {
    const empty = makeRig({ image: true, checkout: false });
    expect(await upgrade(empty.ctx, { force: false })).toBe(1);
    expect(empty.out.text).toContain(`Rei is not set up in ${HOME_REI} yet. Run rei setup.`);

    const checkout = makeRig();
    expect(await upgrade(checkout.ctx, { force: false })).toBe(2);
    expect(checkout.out.text).toContain("./rei redeploy");
  });
});

describe("the daily update notice", () => {
  it("says a newer rei-ai exists, and never more than once a day", async () => {
    const rig = makeRig({ image: true, registry: "1.3.0" });
    expect(await updateNotice(rig.ctx)).toBe(
      "Rei 1.3.0 is available (this is 1.2.0). To upgrade: npm i -g rei-ai@latest, then rei upgrade.",
    );
    expect(rig.host.files.get(`${HOME_REI}/${UPDATE_CACHE}`)?.mode).toBe(0o644);
    expect(await updateNotice(rig.ctx)).toBeUndefined();
    expect(rig.fetched.filter((u) => u.includes("registry"))).toHaveLength(1);
    rig.clock.t += 24 * 60 * 60 * 1000;
    expect(await updateNotice(rig.ctx)).toContain("1.3.0");
    expect(rig.fetched.filter((u) => u.includes("registry"))).toHaveLength(2);
  });

  it("is silent when up to date, offline, switched off, or in a checkout", async () => {
    expect(await updateNotice(makeRig({ image: true, registry: "1.2.0" }).ctx)).toBeUndefined();
    expect(await updateNotice(makeRig({ image: true, registry: "1.2.0-rc.1" }).ctx)).toBeUndefined();
    const offline = makeRig({ image: true });
    expect(await updateNotice(offline.ctx)).toBeUndefined();
    expect(offline.host.files.has(`${HOME_REI}/${UPDATE_CACHE}`)).toBe(false);
    for (const env of [{ CI: "true" }, { REI_NO_UPDATE_CHECK: "1" }, { NO_UPDATE_NOTIFIER: "1" }]) {
      const rig = makeRig({ image: true, registry: "9.0.0", env });
      expect(await updateNotice(rig.ctx)).toBeUndefined();
      expect(rig.fetched).toEqual([]);
    }
    const checkout = makeRig({ registry: "9.0.0" });
    expect(await updateNotice(checkout.ctx)).toBeUndefined();
    expect(checkout.fetched).toEqual([]);
  });
});
