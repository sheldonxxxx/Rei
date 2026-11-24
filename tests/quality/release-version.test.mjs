import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/check-release-version.mjs", import.meta.url));
const repository = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = [];

/** A tiny workspace repository: the root manifest plus one manifest per `dir/name` pair. */
function workspace(rootVersion, members) {
  const root = mkdtempSync(join(tmpdir(), "rei-release-version-"));
  fixtures.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "rei", version: rootVersion, workspaces: ["packages/*", "apps/*"] }),
  );
  for (const [dir, version] of Object.entries(members)) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify({ name: `@rei/${dir}`, version }));
  }
  return root;
}

const check = (tag, root) => spawnSync(process.execPath, [script, tag, "--root", root], { encoding: "utf8" });

afterAll(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

describe("release version gate", () => {
  it("accepts a tag that matches the root and every workspace, and reports a stable release", () => {
    const root = workspace("1.2.3", { "apps/server": "1.2.3", "packages/protocol": "1.2.3" });
    const result = check("v1.2.3", root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["version=1.2.3", "minor=1.2", "prerelease=false"]);
  });

  it("marks a suffixed tag as a pre-release", () => {
    const root = workspace("1.2.3-rc.1", { "apps/server": "1.2.3-rc.1" });
    const result = check("v1.2.3-rc.1", root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["version=1.2.3-rc.1", "minor=1.2", "prerelease=true"]);
  });

  it("names a workspace whose version differs from the tag", () => {
    const root = workspace("1.2.3", { "apps/server": "1.2.3", "packages/protocol": "1.2.2" });
    const result = check("v1.2.3", root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages/protocol/package.json");
    expect(result.stderr).not.toContain("apps/server/package.json");
  });

  it("fails when the root version differs from the tag", () => {
    const root = workspace("1.2.2", { "apps/server": "1.2.3" });
    const result = check("v1.2.3", root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package.json (rei): 1.2.2");
  });

  it.each(["1.2.3", "v1.2", "v01.2.3", "v1.2.3-", "v1.2.3+build", "vx", ""])("rejects the tag %j", (tag) => {
    const root = workspace("1.2.3", { "apps/server": "1.2.3" });
    const result = check(tag, root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not vX.Y.Z");
  });

  it("agrees with this repository's own manifests for its current version", () => {
    const { version } = JSON.parse(
      spawnSync("node", ["-p", "JSON.stringify(require('./package.json'))"], { cwd: repository, encoding: "utf8" })
        .stdout,
    );
    const result = spawnSync(process.execPath, [script, `v${version}`], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`version=${version}`);
  });
});
