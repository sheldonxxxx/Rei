import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "quality", include: ["*.test.mjs"], testTimeout: 30_000 },
});
