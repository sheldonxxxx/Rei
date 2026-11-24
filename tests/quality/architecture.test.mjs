import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../../.dependency-cruiser.cjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

describe("architecture enforcement", () => {
  it("rejects forbidden imports while accepting shared contracts and adapter entry points", () => {
    const fixture = mkdtempSync(join(tmpdir(), "rei-architecture-"));
    const files = {
      "apps/gateway/src/core/bad.ts": 'import "../../../server/src/shared.ts"; import "../node/adapter.ts";',
      "apps/gateway/src/node/adapter.ts": "export const adapter = 1;",
      "apps/server/src/shared.ts": "export const shared = 1;",
      "apps/server/src/main.ts": 'import "./node/adapter.ts"; import "../../../packages/protocol/src/good.ts";',
      "packages/protocol/src/good.ts": "export const version = 1;",
      "apps/server/src/domain.ts": 'import "./node/adapter.ts"; import "../test/helper.ts"; import "./shared.test.ts";',
      "apps/server/src/shared.test.ts": "export const fixture = 1;",
      "apps/server/src/memory/embedder.ts": "export const embedder = 1;",
      "apps/cli/src/embedding.ts": 'import "../../server/src/memory/embedder.ts";',
      "apps/server/src/node/adapter.ts": "export const adapter = 1;",
      "apps/server/test/helper.ts": "export const helper = 1;",
      "apps/web/src/bad.ts": 'import "node:fs";',
      "packages/protocol/src/bad.ts": 'import "../../../apps/server/src/shared.ts";',
      "apps/cli/src/bad.ts": 'import "../../server/src/shared.ts";',
    };
    try {
      for (const [path, source] of Object.entries(files)) {
        mkdirSync(dirname(join(fixture, path)), { recursive: true });
        writeFileSync(join(fixture, path), source);
      }
      // The fixture has no aliases or packages; resolution should use its own tiny tsconfig.
      writeFileSync(join(fixture, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "nodenext" } }));
      const fixtureConfig = { ...config, options: { ...config.options, tsConfig: { fileName: "tsconfig.json" } } };
      writeFileSync(join(fixture, "rules.json"), JSON.stringify(fixtureConfig));
      const run = spawnSync(
        process.execPath,
        [
          join(root, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs"),
          "--config",
          "rules.json",
          "--output-type",
          "json",
          "apps",
          "packages",
        ],
        { cwd: fixture, encoding: "utf8" },
      );
      expect(run.error).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      const report = JSON.parse(run.stdout);
      expect(report.summary.advisedExitCode).toBeGreaterThan(0);
      const violations = report.summary.violations;
      const enforcement = spawnSync(
        process.execPath,
        [
          join(root, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs"),
          "--config",
          "rules.json",
          "apps",
          "packages",
        ],
        { cwd: fixture, encoding: "utf8" },
      );
      expect(enforcement.status, enforcement.stderr).toBeGreaterThan(0);
      expect(violations.filter((v) => v.from === "apps/server/src/main.ts")).toEqual([]);
      expect(
        violations.some((v) => v.from === "apps/cli/src/embedding.ts" && v.rule.name === "cli-workspace-boundary"),
      ).toBe(true);
      expect(
        violations.some(
          (v) => v.to === "apps/server/src/shared.test.ts" && v.rule.name === "production-does-not-import-tests",
        ),
      ).toBe(true);
      const rules = violations.map((violation) => violation.rule.name);
      for (const name of [
        "gateway-workspace-boundary",
        "gateway-core-does-not-import-node-adapters",
        "server-domain-does-not-import-node-adapters",
        "production-does-not-import-tests",
        "web-does-not-import-node",
        "protocol-is-independent",
        "cli-workspace-boundary",
      ]) {
        expect(rules).toContain(name);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
