import { expect, it } from "vitest";
import { MemoryBlobStore } from "../src/blobs/blob-store.ts";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import { instrumentModels } from "../src/pi/instrument.ts";
import { createModelRuntime } from "../src/pi/models.ts";
import { StepRecorder } from "../src/pi/steps.ts";
import { systemClock } from "../src/util/clock.ts";
import { nullLogger } from "../src/util/log.ts";

it("rejects oversized private input before a provider response and caps streamed output locally", async () => {
  const db = openSqliteDb(":memory:");
  initializeDatabase(db);
  const runtime = await createModelRuntime({ mode: "faux", fauxTokensPerSecond: 100_000 });
  const ref = runtime.ref("faux");
  const model = runtime.models.getModel(ref.provider, ref.modelId)!;
  const recorder = new StepRecorder(db, new MemoryBlobStore(), systemClock, nullLogger);
  try {
    const base = {
      recorder,
      resolveCall: () => ({
        sessionId: undefined,
        runId: undefined,
        purpose: "memory" as const,
        deadlines: { firstEventMs: 1000, idleMs: 1000, totalMs: 3000 },
      }),
      syntheticPayload: true,
      beforeCall: () => runtime.arm(),
    };
    const input = instrumentModels(runtime.models, { ...base, maxInputTokens: 10 });
    const tooLarge = await input.completeSimple(model, {
      messages: [{ role: "user", content: "A long source message. ".repeat(100), timestamp: 0 }],
    });
    expect(tooLarge.stopReason).toBe("error");
    expect(tooLarge.errorMessage).toContain("input-token budget");
    const output = instrumentModels(runtime.models, { ...base, maxOutputTokens: 64 });
    const tooLong = await output.completeSimple(model, {
      messages: [{ role: "user", content: "Long reply [len=5000]", timestamp: 0 }],
    });
    expect(tooLong.stopReason).toBe("error");
    expect(tooLong.errorMessage).toContain("output budget");
  } finally {
    db.close();
  }
});
