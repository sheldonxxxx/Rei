import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startTestServer } from "./helpers/server.ts";

describe("web model settings", () => {
  it("reads and saves model defaults and agent chat deadlines", async () => {
    const server = await startTestServer({
      modelsJson: {
        fast: { model: "local/fast-model", totalMs: 90_000 },
        standard: { model: "custom/steady", firstEventMs: 50_000, idleMs: 15_000, totalMs: 300_000 },
      },
    });
    try {
      await server.createAccount();
      const before = await server.client.get("/api/settings/models");
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({
        fast: { model: "local/fast-model", totalMs: 90_000 },
        standard: { model: "custom/steady", firstEventMs: 50_000, idleMs: 15_000, totalMs: 300_000 },
      });

      const saved = await server.client.call("PUT", "/api/settings/models", {
        body: {
          fast: { model: "gpt-6-luna" },
          standard: { model: "custom/steady", firstEventMs: 8_000, idleMs: 3_000, totalMs: 120_000 },
        },
      });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        fast: { model: "gpt-6-luna", totalMs: 90_000 },
        standard: { model: "custom/steady", firstEventMs: 8_000, idleMs: 3_000, totalMs: 120_000 },
      });
      expect(JSON.parse(readFileSync(join(server.dir, "models.json"), "utf8"))).toMatchObject({
        fast: { model: "gpt-6-luna", totalMs: 90_000 },
        standard: { model: "custom/steady", firstEventMs: 8_000, idleMs: 3_000, totalMs: 120_000 },
      });
    } finally {
      await server.destroy();
    }
  });

  it("saves per-model limits to models.json and refuses limits that cannot work", async () => {
    const server = await startTestServer();
    try {
      await server.createAccount();
      const saved = await server.client.call("PUT", "/api/settings/models", {
        body: {
          capabilities: {
            "custom/steady": { contextWindow: 32_768, maxTokens: 4_096 },
          },
        },
      });
      expect(saved.status).toBe(200);
      expect(JSON.parse(readFileSync(join(server.dir, "models.json"), "utf8"))).toMatchObject({
        models: {
          "custom/steady": { contextWindow: 32_768, maxTokens: 4_096 },
        },
      });

      const tooLarge = await server.client.call("PUT", "/api/settings/models", {
        body: { capabilities: { "custom/steady": { contextWindow: 1_000, maxTokens: 2_000 } } },
      });
      expect(tooLarge.status).toBe(400);
      const fraction = await server.client.call("PUT", "/api/settings/models", {
        body: { capabilities: { "custom/steady": { contextWindow: 1.5 } } },
      });
      expect(fraction.status).toBe(400);
    } finally {
      await server.destroy();
    }
  });

  it("rejects invalid model names and timeout values", async () => {
    const server = await startTestServer();
    try {
      await server.createAccount();
      const badModel = await server.client.call("PUT", "/api/settings/models", {
        body: { standard: { model: "not a model" } },
      });
      expect(badModel.status).toBe(400);
      const badTimeout = await server.client.call("PUT", "/api/settings/models", {
        body: { standard: { totalMs: 0 } },
      });
      expect(badTimeout.status).toBe(400);
    } finally {
      await server.destroy();
    }
  });
});
