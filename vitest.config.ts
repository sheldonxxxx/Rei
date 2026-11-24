import { defineConfig } from "vitest/config";

// Each app (and tests/e2e) has its own vitest.config.ts (environment, timeouts); this runs them all as projects.
export default defineConfig({
  test: {
    projects: ["apps/*", "packages/logging", "packages/network", "tests/*"],
    coverage: {
      provider: "v8",
      include: [
        "apps/*/src/**/*.{ts,tsx}",
        "packages/logging/src/**/*.ts",
        "packages/network/src/**/*.ts",
        "packages/forward-proxy/src/**/*.ts",
      ],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts", "**/test/**", "**/main.ts", "**/main.tsx"],
      reporter: ["text-summary", "html", "json-summary"],
      reportsDirectory: "coverage",
      reportOnFailure: true,
      // Floors follow the measured full-suite baseline; protect policy, auth and session recovery first.
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 85,
        "apps/server/src/policy/decision.ts": { statements: 100, branches: 95, functions: 100, lines: 100 },
        "apps/server/src/auth/service.ts": { statements: 90, branches: 80, functions: 100, lines: 95 },
        "apps/server/src/pi/guard.ts": { statements: 90, branches: 80, functions: 85, lines: 90 },
        "apps/server/src/triggers/scheduler.ts": { statements: 90, branches: 85, functions: 90, lines: 95 },
        "apps/server/src/pi/trees.ts": { statements: 80, branches: 65, functions: 70, lines: 90 },
        "apps/server/src/pi/adapter.ts": { statements: 85, branches: 70, functions: 80, lines: 90 },
      },
    },
  },
});
