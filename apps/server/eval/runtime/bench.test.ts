// Runtime benchmark for comparing Pi runtimes (1.4 on main, 1.5 here): SQLite commits per run, stream latency, CPU and
// memory, and the context each model call sends. It uses only the HTTP API and the test helpers, so the same file runs on
// both. Opt-in: REI_BENCH=1 npx vitest run --project server eval/runtime/bench.test.ts (REI_BENCH_RUNS, default 30).
// Results go to stdout as one JSON line prefixed with "BENCH ".
import { writeFileSync } from "node:fs";
import { Session as Inspector } from "node:inspector/promises";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { SseReader } from "../../test/helpers/client.ts";
import { startSignedIn, type TestServer } from "../../test/helpers/server.ts";
import { chat, settled } from "../../test/helpers/sessions.ts";

const RUNS = Number(process.env.REI_BENCH_RUNS ?? 30);
const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER)\b/i;

// Every commit, on every connection (Rei's database and each Pi tree): an autocommit write, or the end of a transaction.
let commits = 0;
const owner = new WeakMap<StatementSync, DatabaseSync>();
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string, ...rest: unknown[]) {
  const st = (prepare as (...a: unknown[]) => StatementSync).call(this, sql, ...rest);
  owner.set(st, this);
  return st;
} as typeof prepare;
const countStatement = (db: DatabaseSync | undefined, sql: string) => {
  if (/^\s*(COMMIT|END)\b/i.test(sql)) commits++;
  else if (db && !db.isTransaction && WRITE.test(sql)) commits++;
};
for (const method of ["run", "all", "get", "iterate"] as const) {
  const original = StatementSync.prototype[method] as (...a: unknown[]) => unknown;
  (StatementSync.prototype as unknown as Record<string, unknown>)[method] = function (
    this: StatementSync,
    ...args: unknown[]
  ) {
    countStatement(owner.get(this), this.sourceSQL);
    return original.apply(this, args);
  };
}
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
  for (const part of sql.split(";")) if (part.trim()) countStatement(this, part);
  return exec.call(this, sql);
};

let server: (TestServer & { totpSecret: string }) | undefined;
afterAll(async () => server?.destroy());

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]! : 0;
};

describe.skipIf(!process.env.REI_BENCH)("runtime benchmark", () => {
  it(`${RUNS} sequential runs in one chat`, { timeout: 600_000 }, async () => {
    server = await startSignedIn();
    const s = server;
    const id = await chat(s);
    const sse = new SseReader(await s.client.raw("GET", `/api/sessions/${id}/stream`));
    // Warm up: open the tree and compile the paths once.
    await s.client.post(`/api/sessions/${id}/messages`, { requestId: "warm", text: "warm up" });
    await settled(s, id, 1);

    const firstText: number[] = [];
    const total: number[] = [];
    // REI_BENCH_PROFILE=<file> writes a CPU profile of the measured runs.
    const profiler = process.env.REI_BENCH_PROFILE ? new Inspector() : undefined;
    if (profiler) {
      profiler.connect();
      await profiler.post("Profiler.enable");
      await profiler.post("Profiler.start");
    }
    const cpu0 = process.cpuUsage();
    const commits0 = commits;
    const t0 = performance.now();
    for (let i = 1; i <= RUNS; i++) {
      const marker = `bench-${i}-reply`;
      const start = performance.now();
      const sent = await s.client.post(`/api/sessions/${id}/messages`, {
        requestId: `r${i}`,
        text: `Say ${marker} please`,
      });
      const runId = (sent.body as { runId: string }).runId;
      await sse.waitFor((e) => JSON.stringify(e.data).includes(`Echo: Say ${marker}`));
      firstText.push(performance.now() - start);
      // The run's completion as the stream reports it: a run.upserted (1.4) or a patch's runs (1.5). No polling.
      await sse.waitFor((e) => {
        const d = e.data as { run?: { id: string; status: string }; runs?: { id: string; status: string }[] };
        const runs = d.runs ?? (d.run ? [d.run] : []);
        return runs.some((r) => r.id === runId && r.status === "completed");
      });
      total.push(performance.now() - start);
    }
    const wall = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const runCommits = commits - commits0;
    // Memory after a full collection, so the two runtimes compare what they keep, not when the collector last ran.
    setFlagsFromString("--expose-gc");
    (runInNewContext("gc") as () => void)();
    const mem = process.memoryUsage();
    if (profiler) {
      const { profile } = await profiler.post("Profiler.stop");
      writeFileSync(process.env.REI_BENCH_PROFILE!, JSON.stringify(profile));
      profiler.disconnect();
    }

    // The context each model call sent: its size, and how much of it repeats the previous call's (a prompt-cache proxy).
    const trace = (await s.client.get(`/api/sessions/${id}/trace?limit=30`)).body as {
      runs: { steps: { id: string; type: string }[] }[];
    };
    const llmSteps = trace.runs
      .slice()
      .reverse()
      .flatMap((r) => r.steps)
      .filter((x) => x.type === "llm.call");
    const requests: string[][] = [];
    let tokensIn = 0;
    let tokensCached = 0;
    for (const step of llmSteps) {
      const d = (await s.client.get(`/api/steps/${step.id}`)).body as {
        llm?: { request?: { messages?: unknown[] }; response?: { usage?: { input?: number; cacheRead?: number } } };
      };
      requests.push((d.llm?.request?.messages ?? []).map((m) => JSON.stringify(m)));
      tokensIn += d.llm?.response?.usage?.input ?? 0;
      tokensCached += d.llm?.response?.usage?.cacheRead ?? 0;
    }
    const bytes = requests.map((r) => r.reduce((n, m) => n + m.length, 0));
    // REI_BENCH_DUMP=<file> writes the last model call's messages (to compare what each runtime sends).
    if (process.env.REI_BENCH_DUMP)
      writeFileSync(process.env.REI_BENCH_DUMP, JSON.stringify(requests.at(-1) ?? [], null, 1));
    let reused = 0;
    let sent = 0;
    for (let i = 1; i < requests.length; i++) {
      const prev = requests[i - 1]!;
      const cur = requests[i]!;
      let k = 0;
      while (k < prev.length && k < cur.length && prev[k] === cur[k]) k++;
      reused += cur.slice(0, k).reduce((n, m) => n + m.length, 0);
      sent += bytes[i]!;
    }
    await sse.close();

    const result = {
      runs: RUNS,
      sqliteCommitsPerRun: +(runCommits / RUNS).toFixed(1),
      firstTextMsMedian: +median(firstText).toFixed(1),
      firstTextMsP95: +p95(firstText).toFixed(1),
      runMsMedian: +median(total).toFixed(1),
      runMsP95: +p95(total).toFixed(1),
      cpuMsPerRun: +((cpu.user + cpu.system) / 1000 / RUNS).toFixed(1),
      wallMs: Math.round(wall),
      rssMb: +(mem.rss / 2 ** 20).toFixed(1),
      heapUsedMb: +(mem.heapUsed / 2 ** 20).toFixed(1),
      modelCalls: llmSteps.length,
      requestBytesLast: bytes.at(-1) ?? 0,
      requestBytesMedian: median(bytes),
      contextPrefixReuse: sent ? +(reused / sent).toFixed(3) : 0,
      usageInputTokens: tokensIn,
      usageCacheReadTokens: tokensCached,
    };
    console.log(`BENCH ${JSON.stringify(result)}`);
    expect(llmSteps.length).toBeGreaterThanOrEqual(Math.min(RUNS, 30));
  });
});
