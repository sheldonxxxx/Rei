import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "gateway",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/offline-guard.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
