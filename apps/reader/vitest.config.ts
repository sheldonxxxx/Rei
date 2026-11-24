import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "reader",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
