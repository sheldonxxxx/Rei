import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server",
    include: ["test/**/*.test.ts", "eval/**/*.test.ts"],
    testTimeout: 40_000,
    hookTimeout: 40_000,
    // Child processes, SQLite files and ports: keep files isolated from each other.
    pool: "forks",
  },
});
