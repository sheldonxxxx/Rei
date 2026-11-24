import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("formats and lints staged code and rejects a secret in another staged file type", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const fixture = mkdtempSync(join(tmpdir(), "rei-hooks-"));
  const run = (command, args) =>
    spawnSync(command, args, {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}` },
    });
  const git = (...args) => {
    const result = run("git", args);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    git("init", "--quiet");
    symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"));
    mkdirSync(join(fixture, "scripts"));
    for (const path of ["biome.json", ".secretlintrc.json", ".secretlintignore", "scripts/lint.mjs"]) {
      copyFileSync(join(root, path), join(fixture, path));
    }
    const config = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({ private: true, type: "module", "lint-staged": config["lint-staged"] }),
    );
    writeFileSync(join(fixture, "lint-baseline.json"), JSON.stringify({ findings: {} }));
    writeFileSync(join(fixture, "example.ts"), "export const value=1;\n");
    git("add", "example.ts");
    const hook = () =>
      run(process.execPath, [join(root, "node_modules/lint-staged/bin/lint-staged.js"), "--concurrent", "false"]);
    const formatted = hook();
    expect(formatted.status, formatted.stdout + formatted.stderr).toBe(0);
    expect(git("show", ":example.ts")).toBe("export const value = 1;\n");
    // Construct a dummy credential so the regression test itself contains no token-shaped literal.
    writeFileSync(join(fixture, "notes.md"), "ghp_" + "Z".repeat(36));
    git("add", "notes.md");
    const blocked = hook();
    expect(blocked.status, blocked.stdout + blocked.stderr).toBeGreaterThan(0);
    expect(blocked.stdout + blocked.stderr).toContain("GITHUB_TOKEN");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
