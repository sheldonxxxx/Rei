import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { USAGE_METRICS, USAGE_PURPOSES, type UsagePurpose, type UsageResponse } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { parseUsage } from "../../gateway/src/core/meter.ts";
import { SqliteCallLog } from "../../gateway/src/node/calllog.ts";
import { MemoryBlobStore } from "../src/blobs/blob-store.ts";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import { instrumentModels } from "../src/pi/instrument.ts";
import { DEFAULT_DEADLINES } from "../src/pi/model-config.ts";
import { createModelRuntime } from "../src/pi/models.ts";
import { StepHandle, StepRecorder } from "../src/pi/steps.ts";
import { normalizeUsage, type UsageEvidence, usageEvidenceFromEvent } from "../src/usage/accounting.ts";
import { readUsage, type UsageRange } from "../src/usage/read.ts";
import { nullLogger } from "../src/util/log.ts";
import { until } from "./helpers/client.ts";
import { type FakeGateway, startFakeGateway } from "./helpers/fake-gateway.ts";
import { STANDIN, startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, say, settled } from "./helpers/sessions.ts";

const activation = Date.parse("2026-11-01T00:00:00Z");
const raw = {
  input_tokens: 1000,
  output_tokens: 150,
  total_tokens: 1150,
  input_tokens_details: { cached_tokens: 600 },
  output_tokens_details: { reasoning_tokens: 50 },
};
const evidence = usageEvidenceFromEvent({ type: "response.completed", response: { usage: raw } })!;
function message(usage: Partial<AssistantMessage["usage"]> = {}): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "test",
    content: [],
    stopReason: "stop",
    timestamp: activation,
    usage: {
      input: 400,
      cacheRead: 600,
      cacheWrite: 0,
      output: 150,
      totalTokens: 1150,
      reasoning: 50,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      ...usage,
    },
  };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rei-usage-"));
  const path = join(dir, "app.sqlite");
  let db = openSqliteDb(path);
  initializeDatabase(db, () => activation);
  let now = activation;
  const clock = { now: () => now };
  let recorder = new StepRecorder(db, new MemoryBlobStore(), clock, nullLogger);
  const begin = (purpose: UsagePurpose = "chat", agentId?: string, runId?: string) =>
    recorder.begin({
      sessionId: undefined,
      runId,
      provider: "openai",
      model: "test",
      purpose,
      agentId,
      deadlines: DEFAULT_DEADLINES,
    });
  const finish = (
    purpose: UsagePurpose = "chat",
    report: AssistantMessage | undefined = message(),
    ev: UsageEvidence | null = evidence,
    runId?: string,
  ) => {
    const step = begin(purpose, undefined, runId);
    step.usageEvidence = ev;
    step.finish("ok", report);
    return step;
  };
  return {
    dir,
    path,
    get db() {
      return db;
    },
    get recorder() {
      return recorder;
    },
    begin,
    finish,
    at: (n: number) => {
      now = n;
    },
    read: (period = "all", range?: UsageRange) => readUsage(db, period, now, {}, range),
    reopen: () => {
      db.close();
      db = openSqliteDb(path);
      recorder = new StepRecorder(db, new MemoryBlobStore(), clock, nullLogger);
    },
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("permanent daily usage", () => {
  it("starts usage tracking at installation and preserves it on restart", () => {
    const f = fixture();
    try {
      expect(f.read().summary.modelCalls).toBe(0);
      expect(f.read().trackingSince).toBe("2026-11-01T00:00:00.000Z");
      expect(initializeDatabase(f.db)).toBe(false);
      f.finish();
      f.reopen();
      expect(f.read().summary.tokens).toMatchObject({
        inputTotal: 1000,
        inputCached: 600,
        inputUncached: 400,
        outputTotal: 150,
        totalProcessed: 1150,
        reasoningOutput: 50,
      });
    } finally {
      f.close();
    }
  });

  it("increments ten events in one canonical no-agent bucket, counts each purpose, and uses UTC completion day", () => {
    const f = fixture();
    try {
      // One run: its first call is left out of cache hit, the other nine pair at 600 of 1000 input.
      for (let i = 0; i < 10; i++) f.finish("chat", message(), evidence, "run-1");
      expect(f.db.all("SELECT * FROM usage_daily")).toHaveLength(1);
      expect(f.read().summary.modelCalls).toBe(10);
      expect(f.read().summary.tokens.totalProcessed).toBe(11500);
      const spanning = f.begin("memory", "agent-1");
      spanning.usageEvidence = evidence;
      f.at(Date.parse("2026-11-02T08:00:00+08:00"));
      spanning.finish("ok", message());
      for (const purpose of USAGE_PURPOSES.filter((p) => p !== "memory" && p !== "chat")) f.finish(purpose);
      const usage = f.read();
      expect(usage.daily.map((d) => d.day)).toEqual(["2026-11-01", "2026-11-02"]);
      expect(usage.byPurpose.map((p) => [p.purpose, p.usage.modelCalls])).toEqual([
        ["chat", 10],
        ["memory", 1],
        ["title", 1],
        ["agent_task", 1],
        ["other", 1],
      ]);
      for (const m of USAGE_METRICS)
        expect(usage.byPurpose.reduce((n, p) => n + (p.usage.tokens[m] ?? 0), 0)).toBe(usage.summary.tokens[m]);
      expect(usage.byAgent.find((a) => a.agentId === "agent-1")?.usage.modelCalls).toBe(1);
      expect(usage.summary.cacheHitPercent).toBe(60);
    } finally {
      f.close();
    }
  });

  it("is idempotent across repeated finishes, separate DB handles and restart", () => {
    const f = fixture();
    try {
      const step = f.finish();
      step.finish("error");
      const second = openSqliteDb(f.path);
      const duplicate = new StepHandle(
        new StepRecorder(second, new MemoryBlobStore(), { now: () => activation + 1 }, nullLogger),
        step.id,
        activation,
        DEFAULT_DEADLINES,
      );
      duplicate.finish("error");
      second.close();
      f.reopen();
      new StepHandle(f.recorder, step.id, activation, DEFAULT_DEADLINES).finish("error");
      expect(f.read().summary.modelCalls).toBe(1);
      expect(f.db.get<{ status: string }>("SELECT status FROM steps WHERE id = ?", step.id)?.status).toBe("ok");
      expect(f.read().summary.tokens.inputTotal).toBe(1000);
    } finally {
      f.close();
    }
  });

  it("serializes concurrent SQLite writers and counts repeated completions exactly once", async () => {
    const f = fixture();
    const workers: Worker[] = [];
    try {
      const ids = Array.from({ length: 10 }, () => f.begin().id);
      const ready: Promise<void>[] = [];
      const finished: Promise<void>[] = [];
      for (let i = 0; i < 3; i++) {
        const worker = new Worker(
          `
          const { parentPort, workerData: d } = require("node:worker_threads");
          (async () => {
            const [{ openSqliteDb }, { StepHandle, StepRecorder }, { MemoryBlobStore }, { DEFAULT_DEADLINES }, { nullLogger }] = await Promise.all(d.modules.map((url) => import(url)));
            const db = openSqliteDb(d.path);
            const recorder = new StepRecorder(db, new MemoryBlobStore(), { now: () => d.now }, nullLogger);
            parentPort.once("message", () => {
              try {
                for (const id of d.ids) {
                  const step = new StepHandle(recorder, id, d.now, DEFAULT_DEADLINES);
                  step.usageEvidence = d.evidence;
                  step.finish("ok", d.message);
                }
                db.close(); parentPort.close();
              } catch (error) { throw error; }
            });
            parentPort.postMessage("ready");
          })().catch((error) => { throw error; });`,
          {
            eval: true,
            workerData: {
              path: f.path,
              ids,
              now: activation,
              evidence,
              message: message(),
              modules: [
                "../src/node/sqlite-db.ts",
                "../src/pi/steps.ts",
                "../src/blobs/blob-store.ts",
                "../src/pi/model-config.ts",
                "../src/util/log.ts",
              ].map((p) => new URL(p, import.meta.url).href),
            },
          },
        );
        workers.push(worker);
        ready.push(
          new Promise((resolve, reject) => {
            worker.once("message", () => resolve());
            worker.once("error", reject);
          }),
        );
        finished.push(
          new Promise((resolve, reject) => {
            worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
            worker.once("error", reject);
          }),
        );
      }
      await Promise.all(ready);
      for (const worker of workers) worker.postMessage("finish");
      await Promise.all(finished);
      expect(f.read().summary.modelCalls).toBe(10);
      expect(f.read().summary.tokens.totalProcessed).toBe(11500);
      expect(f.db.all("SELECT * FROM steps WHERE usage_accounted_at IS NOT NULL")).toHaveLength(10);
    } finally {
      await Promise.all(workers.map((w) => w.terminate()));
      f.close();
    }
  });

  it("rolls back status, marker and counters on failure; the same final step can safely retry after restart", () => {
    const f = fixture();
    try {
      const step = f.begin();
      step.usageEvidence = evidence;
      f.db.exec(
        "CREATE TRIGGER fail_usage BEFORE INSERT ON usage_daily BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
      );
      expect(() => step.finish("ok", message())).toThrow("injected failure");
      expect(f.db.get("SELECT status, usage_accounted_at FROM steps WHERE id = ?", step.id)).toMatchObject({
        status: "running",
        usage_accounted_at: null,
      });
      expect(f.read().summary.modelCalls).toBe(0);
      f.db.exec("DROP TRIGGER fail_usage");
      f.reopen();
      const retry = new StepHandle(f.recorder, step.id, activation, DEFAULT_DEADLINES);
      retry.usageEvidence = evidence;
      retry.finish("ok", message());
      retry.finish("ok", message());
      expect(f.read().summary.modelCalls).toBe(1);
    } finally {
      f.close();
    }
  });

  it("backfills the paired cache sums for a database that predates them, without changing cache hit", () => {
    const f = fixture();
    try {
      f.finish("chat", message(), evidence, "run-1");
      f.at(activation + 86_400_000);
      f.finish("chat", message(), evidence, "run-1");
      expect(f.read().summary.cacheHitPercent).toBe(60);
      f.db.exec(
        "ALTER TABLE usage_daily DROP COLUMN cache_pair_input; ALTER TABLE usage_daily DROP COLUMN cache_pair_cached;",
      );
      expect(initializeDatabase(f.db)).toBe(false);
      expect(f.read().summary.cacheHitPercent).toBe(60);
      expect(initializeDatabase(f.db)).toBe(false);
      expect(f.read().summary.cacheHitPercent).toBe(60);
    } finally {
      f.close();
    }
  });

  it("leaves only the first model call of each run out of cache hit, whatever its purpose, and keeps its tokens", () => {
    const f = fixture();
    try {
      const cold = { input: 1000, cached: 0, output: 150, reasoning: 50 };
      const coldCall = message({ input: 1000, cacheRead: 0 });
      f.finish("chat", coldCall, cold, "r1");
      f.finish("chat", message(), evidence, "r1");
      f.finish("agent_task", coldCall, cold, "r2");
      f.finish("agent_task", message(), evidence, "r2");
      f.finish("title", message(), evidence, "r3");
      f.finish("chat", message(), evidence, "r3");
      const usage = f.read();
      expect(usage.summary.tokens).toMatchObject({ inputTotal: 6000, inputCached: 2400 });
      // Three calls pair (600 of 1000 each); the three first calls of their runs do not.
      expect(usage.summary.cacheHitPercent).toBe(60);
    } finally {
      f.close();
    }
  });

  it("treats a call with no run as its own run, so it never pairs", () => {
    const f = fixture();
    try {
      f.finish("memory", message(), evidence);
      f.finish("other", message(), evidence);
      const usage = f.read();
      expect(usage.summary.tokens.inputCached).toBe(1200);
      expect(usage.summary.cacheHitPercent).toBeNull();
    } finally {
      f.close();
    }
  });

  it("counts a later call that reported zero cached tokens (a cold cache) in cache hit", () => {
    const f = fixture();
    try {
      const cold = { input: 1000, cached: 0, output: 150, reasoning: 50 };
      f.finish("chat", message(), evidence, "run-1");
      f.finish("chat", message({ input: 1000, cacheRead: 0 }), cold, "run-1");
      f.finish("chat", message(), evidence, "run-1");
      expect(f.read().summary.cacheHitPercent).toBe(30);
    } finally {
      f.close();
    }
  });

  it("leaves calls without a cached report out of cache hit, and only that call from both sides", () => {
    const f = fixture();
    try {
      f.finish("chat", message(), evidence, "run-1");
      f.finish("chat", message(), evidence, "run-1");
      f.finish("chat", message(), { input: 1000, cached: null, output: 150, reasoning: 50 }, "run-1");
      const usage = f.read();
      expect(usage.summary.tokens).toMatchObject({ inputTotal: 3000, inputCached: 1200 });
      expect(usage.summary.unknown.inputCached).toBe(1);
      expect(usage.summary.cacheHitPercent).toBe(60);
      expect(f.read("custom", { from: "2026-11-01", to: "2026-11-01" }).summary.cacheHitPercent).toBe(60);
    } finally {
      f.close();
    }
  });

  it("does not count incomplete steps and retains unknown/partial reports without presenting default zeros", () => {
    const f = fixture();
    try {
      f.begin();
      expect(f.read().summary.modelCalls).toBe(0);
      const missing = f.begin();
      missing.finish("error");
      const synthetic = f.begin();
      synthetic.finish("error", message({ input: 0, cacheRead: 0, output: 0, totalTokens: 0 }));
      expect(f.read().summary.tokens.inputTotal).toBeNull();
      expect(f.read().summary.callsUnreported).toBe(2);
      f.finish("title", message({ input: 0, cacheRead: 0, reasoning: undefined }), {
        input: null,
        cached: null,
        output: 150,
        reasoning: null,
      });
      let usage = f.read();
      expect(usage.summary.tokens).toMatchObject({ inputTotal: null, outputTotal: 150, totalProcessed: null });
      expect(usage.summary.unknown.outputTotal).toBe(2);
      f.finish();
      usage = f.read();
      expect(usage.summary.tokens.inputTotal).toBe(1000);
      expect(usage.summary.unknown.inputTotal).toBe(3);
      // A lone call with no run is the first call of its run, so cache hit has nothing to pair.
      expect(usage.summary.cacheHitPercent).toBeNull();
      expect(usage.summary.modelCalls).toBe(4);
      expect(usage.summary.callsReported).toBe(1);
    } finally {
      f.close();
    }
  });

  it("survives gateway pruning and source step deletion, with no second tally", () => {
    const f = fixture();
    let now = activation;
    const calls = new SqliteCallLog(join(f.dir, "gateway.sqlite"), { now: () => now });
    try {
      const step = f.finish();
      calls.insert({
        stepId: step.id,
        caller: "rei",
        provider: "openai",
        model: "test",
        startedAt: now,
        firstByteMs: 1,
        totalMs: 2,
        status: 200,
        usage: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 150 },
        error: null,
        limit: null,
      });
      const before = f.read().summary;
      now += 31 * 86400000;
      calls.prune();
      expect(calls.count()).toBe(0);
      f.db.run("DELETE FROM steps");
      step.finish("ok", message());
      f.reopen();
      expect(f.read().summary).toEqual(before);
    } finally {
      calls.close();
      f.close();
    }
  });

  it("validates and bounds the fixed UTC periods", () => {
    const f = fixture();
    try {
      f.finish();
      f.at(Date.parse("2027-02-02T23:30:00Z"));
      f.finish();
      for (const [period, from] of [
        ["7d", "2027-01-27"],
        ["30d", "2027-01-04"],
        ["month", "2027-02-01"],
        ["year", "2027-01-01"],
        ["all", "2026-11-01"],
      ]) {
        const res = f.read(period);
        expect(res.from).toBe(from);
        expect(res.to).toBe("2027-02-02");
        expect(res.summary.modelCalls).toBe(period === "all" ? 2 : 1);
      }
      expect(() => f.read("bad")).toThrow("period must be");
    } finally {
      f.close();
    }
  });

  it("adds today and a custom UTC range, clipped to tracking and today, and rejects impossible ranges", () => {
    const f = fixture();
    try {
      f.finish();
      f.at(Date.parse("2027-02-02T23:30:00Z"));
      f.finish();
      const today = f.read("today");
      expect([today.from, today.to, today.summary.modelCalls]).toEqual(["2027-02-02", "2027-02-02", 1]);
      const before = f.read("custom", { from: "2026-10-01", to: "2027-02-01" });
      expect([before.period, before.from, before.to, before.summary.modelCalls]).toEqual([
        "custom",
        "2026-11-01",
        "2027-02-01",
        1,
      ]);
      const future = f.read("custom", { from: "2027-01-30", to: "2099-01-01" });
      expect([future.from, future.to, future.summary.modelCalls]).toEqual(["2027-01-30", "2027-02-02", 1]);
      expect(f.read("custom", { from: "2027-02-02", to: "2027-02-02" }).summary.modelCalls).toBe(1);
      expect(() => f.read("custom")).toThrow("from must be a date");
      expect(() => f.read("custom", { from: "2027-02-30", to: "2027-03-01" })).toThrow("from must be a date");
      expect(() => f.read("custom", { from: "2027-02-03", to: "2027-02-02" })).toThrow("A custom range must start");
      expect(() => f.read("all", { from: "2027-02-01" })).toThrow("only used with the custom period");
    } finally {
      f.close();
    }
  });
});

describe("Pi usage normalization", () => {
  it("recombines disjoint Pi input/cache fields and matches the gateway's inclusive contract", () => {
    const usage = normalizeUsage(message(), evidence);
    expect(usage).toMatchObject({
      inputTotal: 1000,
      inputCached: 600,
      inputUncached: 400,
      outputTotal: 150,
      totalProcessed: 1150,
    });
    expect(parseUsage(raw)).toEqual({
      inputTokens: usage.inputTotal,
      outputTokens: usage.outputTotal,
      cachedInputTokens: usage.inputCached,
    });
    expect(normalizeUsage(message({ input: 300, cacheWrite: 100 }), evidence).inputTotal).toBe(1000);
    expect(normalizeUsage(message({ input: 1000 }), evidence).inputTotal).toBeNull(); // never double-add to inclusive input
  });
  it("rejects invalid algebra, fractions, negative numbers, unsafe integers, missing input, and unsupported APIs", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(normalizeUsage(message({ input: bad }), evidence).inputTotal).toBeNull();
    }
    expect(normalizeUsage(message({ cacheRead: 1600 }), { ...evidence, cached: 1600 }).inputCached).toBeNull();
    expect(normalizeUsage(message({ reasoning: 151 }), { ...evidence, reasoning: 151 }).reasoningOutput).toBeNull();
    expect(normalizeUsage(undefined, evidence).inputTotal).toBeNull();
    expect(normalizeUsage(message(), null).outputTotal).toBeNull();
    expect(normalizeUsage({ ...message(), api: "faux" }, evidence).inputTotal).toBeNull();
    expect(usageEvidenceFromEvent({ type: "response.completed", response: {} })).toBeNull();
  });
});

let server: TestServer | undefined;
let gateway: FakeGateway | undefined;
afterEach(async () => {
  await server?.destroy();
  await gateway?.close();
  server = undefined;
  gateway = undefined;
});

describe("Usage API and real Pi instrumentation", () => {
  it("requires authentication and rejects invalid, repeated or unexpected query inputs", async () => {
    server = await startSignedIn();
    expect((await server.client.get("/api/usage", { cookie: false })).status).toBe(401);
    for (const query of [
      "period=wrong",
      "period=",
      "period=7d&period=30d",
      "from=2000-01-01",
      "period=all&to=2099-01-01",
    ])
      expect((await server.client.get(`/api/usage?${query}`)).status).toBe(400);
    const res = await server.client.get<UsageResponse>("/api/usage?period=all");
    expect(res.status).toBe(200);
    expect(res.body.summary.modelCalls).toBe(0);
    expect(res.body.timezone).toBe("UTC");
    for (const query of ["period=custom", "period=custom&from=2000-01-02&to=2000-01-01", "period=custom&to=2000-01-01"])
      expect((await server.client.get(`/api/usage?${query}`)).status).toBe(400);
    const custom = await server.client.get<UsageResponse>("/api/usage?period=custom&from=2000-01-01&to=2099-01-01");
    expect(custom.status).toBe(200);
    expect(custom.body).toMatchObject({ period: "custom", from: custom.body.trackingSince.slice(0, 10) });
    expect((await server.client.get<UsageResponse>("/api/usage?period=today")).body.period).toBe("today");
  });
  it("tags automated messages, spawned work and triggers as agent_task", async () => {
    gateway = await startFakeGateway({ bearer: STANDIN, behavior: () => ({ kind: "text", text: "ok", usage: raw }) });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const plane = server.host.plane;
    const id = await chat(server);
    await say(server, id, "Hello");
    await settled(server, id, 1);
    await plane.adapter.commands.admit({
      sessionId: id,
      requestId: "automated",
      role: "trigger",
      text: "An automated notice",
    });
    await settled(server, id, 2);
    await plane.adapter.commands.admit({
      sessionId: id,
      requestId: "assigned",
      role: "user",
      text: "An agent message",
      from: { sessionId: plane.store.getAgent(plane.store.defaultAgentId()!)!.homeSessionId, title: "Agent" },
    });
    await settled(server, id, 3);
    const child = plane.store.createSpawned({
      callerId: plane.store.getAgent(plane.store.defaultAgentId()!)!.homeSessionId,
      spawnKey: "usage-child",
      brief: "Do a task",
      title: "Child",
      agentId: plane.store.defaultAgentId()!,
      maxDepth: 3,
      maxActive: 3,
    });
    await plane.adapter.commands.admit({
      sessionId: child.session.id,
      requestId: "usage-child-brief",
      role: "user",
      text: "Do a task",
      assignedBy: child.session.parentSessionId!,
    });
    await settled(server, child.session.id);
    const trigger = plane.triggers.store.create({
      agentId: plane.store.defaultAgentId()!,
      createdBySessionId: null,
      fields: {
        name: "Usage trigger",
        start: { kind: "schedule", schedule: { kind: "daily", times: ["09:00"], timeZone: "UTC" } },
        action: { kind: "prompt", prompt: "Do scheduled work" },
        landing: "new",
        report: "never",
        latenessMinutes: 120,
        catchUp: "once",
        overlap: "skip",
        profile: "standard",
        allow: [],
      },
    });
    expect((await server.client.post(`/api/triggers/${trigger.id}/run`, {})).status).toBe(200);
    const triggerSession = plane.triggers.store.runsOfTrigger(trigger.id)[0]!.session_id!;
    await settled(server, triggerSession);
    for (const sid of [child.session.id, triggerSession]) {
      const rows = plane.store.db.all<{ usage_purpose: string }>(
        "SELECT usage_purpose FROM steps WHERE session_id = ? AND type = 'llm.call'",
        sid,
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((s) => s.usage_purpose === "agent_task")).toBe(true);
    }
    const usage = (await server.client.get<UsageResponse>("/api/usage?period=all")).body;
    expect(usage.byPurpose.find((p) => p.purpose === "chat")?.usage.modelCalls).toBe(1);
    expect(usage.byPurpose.find((p) => p.purpose === "agent_task")!.usage.modelCalls).toBeGreaterThanOrEqual(4);
  });

  it("keeps duplicate upstream attempts in a single logical model-call snapshot", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: (seen) => (seen.n === 1 ? { kind: "status", status: 500 } : { kind: "text", text: "ok", usage: raw }),
    });
    const f = fixture();
    try {
      const runtime = await createModelRuntime({ mode: "gateway", standin: { read: async () => STANDIN } });
      const ref = runtime.ref("gpt-6.1-sol");
      const models = instrumentModels(runtime.models, {
        recorder: f.recorder,
        gatewayUrl: gateway.url,
        resolveCall: () => ({ sessionId: undefined, runId: undefined, purpose: "chat", deadlines: DEFAULT_DEADLINES }),
      });
      const model = models.getModel(ref.provider, ref.modelId)!;
      const reply = await models.completeSimple(
        model,
        { messages: [{ role: "user", content: "Retry this call", timestamp: activation }] },
        { maxRetries: 1 },
      );
      expect(reply.stopReason).toBe("stop");
      expect(gateway.seen).toHaveLength(2);
      const usage = f.read();
      expect(usage.summary.modelCalls).toBe(1);
      expect(usage.summary.tokens.totalProcessed).toBe(1150);
      expect(new Set(gateway.seen.map((r) => r.headers["x-rei-step-id"])).size).toBe(1);
      expect(gateway.seen[0]!.headers["x-rei-step-id"]).toBeTruthy();
    } finally {
      f.close();
    }
  });

  it("counts the actual provider's cache semantics once, tags chat/title at begin and keeps failed/missing usages unknown", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: () => ({ kind: "text", text: "A title", usage: raw }),
    });
    server = await startSignedIn({ gatewayUrl: gateway.url, titles: true });
    const id = await chat(server);
    await say(server, id, "Hello");
    await settled(server, id, 1);
    await until(
      async () =>
        (await server!.client.get<UsageResponse>("/api/usage?period=all")).body.summary.modelCalls >= 2
          ? true
          : undefined,
      10000,
      "usage and title",
    );
    const res = (await server.client.get<UsageResponse>("/api/usage?period=all")).body;
    expect(res.summary.tokens).toMatchObject({
      inputTotal: 2000,
      inputCached: 1200,
      inputUncached: 800,
      outputTotal: 300,
      totalProcessed: 2300,
    });
    expect(res.byPurpose.find((p) => p.purpose === "chat")?.usage.modelCalls).toBe(1);
    expect(res.byPurpose.find((p) => p.purpose === "title")?.usage.modelCalls).toBe(1);
    expect(res.summary.modelCalls).toBe(gateway.seen.length);
    expect(JSON.stringify(res)).not.toContain("Hello");
    expect(JSON.stringify(res)).not.toContain(STANDIN);
    gateway.setBehavior(() => ({ kind: "text", text: "no usage", usage: null }));
    await say(server, id, "Missing report");
    await settled(server, id, 2);
    const missing = (await server.client.get<UsageResponse>("/api/usage?period=all")).body;
    expect(missing.summary.modelCalls).toBe(3);
    expect(missing.summary.callsUnreported).toBe(1);
    expect(missing.summary.tokens.inputTotal).toBe(2000);
    expect(missing.summary.unknown.inputTotal).toBe(1);
    gateway.setBehavior(() => ({ kind: "status", status: 400 }));
    await say(server, id, "Fail");
    await settled(server, id, 3);
    const failed = (await server.client.get<UsageResponse>("/api/usage?period=all")).body;
    expect(failed.summary.callsUnreported).toBe(2);
    expect(failed.summary.modelCalls).toBe(4);
  });
});
