import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "e2e",
    include: ["**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
  },
});
