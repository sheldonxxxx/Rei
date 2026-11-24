import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { titleProblem } from "../../scripts/check-pr-title.mjs";

const script = fileURLToPath(new URL("../../scripts/check-pr-title.mjs", import.meta.url));
const run = (args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, PR_TITLE: "", ...env } });

describe("the pull request title gate", () => {
  it.each([
    "feat: add chat export",
    "fix(server): handle session pagination",
    "docs: add the production development workflow",
    "feat(web)!: drop the legacy settings page",
    "chore(deps): bump the npm-minor-patch group across 1 directory with 24 updates",
    "chore(release): v0.2.0",
    "revert: feat(web): add chat export",
    "ci(android/gradle): cache the wrapper",
  ])("accepts %j", (title) => {
    expect(titleProblem(title)).toBeNull();
  });

  it.each([
    ["", /empty/],
    ["Add chat export", /not `type\(scope\): summary`/],
    ["feature: add chat export", /not `type\(scope\): summary`/],
    ["feat:add chat export", /not `type\(scope\): summary`/],
    ["feat(): add chat export", /not `type\(scope\): summary`/],
    ["Feat(web): add chat export", /not `type\(scope\): summary`/],
    ["feat(web): add chat export.", /period/],
    [" feat: add chat export", /whitespace/],
    [`feat: ${"x".repeat(150)}`, /characters/],
  ])("rejects %j", (title, reason) => {
    expect(titleProblem(title)).toMatch(reason);
  });

  it("reads the title from an argument or from PR_TITLE, and exits 1 on a bad one", () => {
    expect(run(["fix: a real fix"]).status).toBe(0);
    expect(run([], { PR_TITLE: "fix: from the environment" }).status).toBe(0);
    const bad = run([], { PR_TITLE: "WIP" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("check-pr-title:");
  });
});
