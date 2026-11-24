import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/cli-package.mjs", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "rei-cli-package-"));
const IMAGES = ["control", "gateway", "reader", "egress", "exec", "browser"];
const digest = (i) => `sha256:${String(i).repeat(64)}`;

afterAll(() => rmSync(temp, { recursive: true, force: true }));

const pack = (name, ...args) => {
  const out = join(temp, name);
  return { out, result: spawnSync(process.execPath, [script, "--out", out, ...args], { encoding: "utf8" }) };
};

/** The image-ref files images-merge writes: one per image, `name|registry/rei-name:version|digest`. */
function refs(name, version, images = IMAGES) {
  const dir = join(temp, name);
  mkdirSync(dir, { recursive: true });
  for (const [i, image] of images.entries())
    writeFileSync(join(dir, `${image}.txt`), `${image}|ghcr.io/someone/rei-${image}:${version}|${digest(i + 1)}\n`);
  return dir;
}

describe("the rei-ai package", { timeout: 60_000 }, () => {
  const dir = refs("refs-ok", "1.2.3");
  const { out, result } = pack("pkg", "--version", "1.2.3", "--tag", "v1.2.3", "--refs", dir, "--require-digests");

  it("is a package of its own: the bin, Node 24, only dist/ and assets/, the repository for provenance", () => {
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
    expect(manifest).toMatchObject({
      name: "rei-ai",
      version: "1.2.3",
      license: "MIT",
      bin: { rei: "dist/rei.mjs" },
      files: ["dist/", "assets/"],
      engines: { node: ">=24" },
      repository: { type: "git", url: "git+https://github.com/sheldonxxxx/Rei.git" },
    });
    expect(manifest.dependencies).toBeUndefined();
    for (const file of ["README.md", "LICENSE", "assets/edge/forward.mjs", "assets/garage/garage.toml"])
      expect(statSync(join(out, file)).isFile(), file).toBe(true);
    expect(statSync(join(out, "assets/smoke-exec.sh")).mode & 0o111).not.toBe(0);
    expect(statSync(join(out, "dist/rei.mjs")).mode & 0o111).not.toBe(0);
  });

  it("names every Rei image for its release, pinned by digest, and keeps REI_IMAGES as the override", () => {
    const compose = readFileSync(join(out, "assets/compose.yaml"), "utf8");
    const dodai = readFileSync(join(out, "assets/compose.dodai.yaml"), "utf8");
    const lines = `${compose}\n${dodai}`.split("\n").filter((l) => /^\s*image: \$\{REI_IMAGES/.test(l));
    expect(lines.length).toBe(7); // edge shares the control image
    for (const [i, image] of IMAGES.entries())
      expect(`${compose}\n${dodai}`).toContain(
        `image: \${REI_IMAGES:-ghcr.io/someone}/rei-${image}:1.2.3@${digest(i + 1)}`,
      );
    expect(`${compose}\n${dodai}`).not.toMatch(/^\s*image:.*REI_VERSION/m);
    expect(`${compose}\n${dodai}`).not.toMatch(/^\s*build:/m);
  });

  it("runs as one file with its version written in, and speaks as rei", () => {
    const bin = join(out, "dist/rei.mjs");
    expect(readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    const env = { ...process.env, REI_HOME: join(temp, "home"), REI_NO_UPDATE_CHECK: "1" };
    const version = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8", env });
    expect(version.stdout.trim()).toBe("1.2.3");
    const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8", env });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("rei setup");
    expect(help.stdout).toContain("rei upgrade");
    expect(help.stdout).not.toMatch(/\.\/rei|redeploy/);
    const status = spawnSync(process.execPath, [bin, "status"], { encoding: "utf8", env });
    expect(status.status).toBe(1);
    expect(status.stderr).toContain("Run rei setup first");
  });

  it("without --refs names the version only, under the default or the given prefix", () => {
    const plain = pack("plain", "--version", "2.0.0-rc.1", "--images", "localhost:5000/test");
    expect(plain.result.status, plain.result.stderr).toBe(0);
    expect(readFileSync(join(plain.out, "assets/compose.yaml"), "utf8")).toContain(
      `image: \${REI_IMAGES:-localhost:5000/test}/rei-control:2.0.0-rc.1\n`,
    );
  });

  it("refuses a version that is not the tag's, a missing digest, and a ref of another version", () => {
    expect(pack("bad-tag", "--version", "1.2.3", "--tag", "v1.2.4").result.stderr).toContain(
      "does not match the tag v1.2.4",
    );
    const partial = refs("refs-partial", "1.2.3", IMAGES.slice(1));
    expect(pack("partial", "--version", "1.2.3", "--refs", partial, "--require-digests").result.stderr).toContain(
      "no digest for rei-control",
    );
    const stale = refs("refs-stale", "1.2.2");
    const r = pack("stale", "--version", "1.2.3", "--refs", stale).result;
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pushed as 1.2.2, but the package is 1.2.3");
  });
});
