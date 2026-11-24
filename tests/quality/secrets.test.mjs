import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("scans test files for new secrets and keeps exact synthetic regression fixtures allowed", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const scan = (token) =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../../node_modules/secretlint/bin/secretlint.js", import.meta.url)),
        "--stdinFileName=apps/cli/test/example.ts",
      ],
      {
        cwd: root,
        encoding: "utf8",
        input: `const value = "${token}";`,
      },
    );
  const detected = scan("ghp_" + "Z".repeat(36));
  expect(detected.error).toBeUndefined();
  expect(detected.status, detected.stderr).toBe(1);
  expect(detected.stdout).toContain("GITHUB_TOKEN");
  const fixture = scan("ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789");
  expect(fixture.status, fixture.stderr).toBe(0);
});
