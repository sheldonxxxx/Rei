// The Code mode eval (ticket 08): does letting the agent write a script that calls its tools take fewer model turns and
// fewer tokens on multi-step work, without lowering task success? See RESULTS.md for the questions and the numbers.
//
// Faux part (this file, normal suite, no model): every scenario runs through the in-process server with the faux model,
// once without Code mode (the tool calls a good agent makes) and once with it (the one script a good agent writes). The
// faux model cannot reason, so this proves the fixtures, the assertions and the metrics, and that Code mode's tools
// work on the fixtures. It says nothing about how a real model behaves.
//
// Real-model part (skipped unless a stack is named): the same scenarios, natural-language prompts, against a deployed
// Rei with a real provider:
//   REI_EVAL_URL=http://127.0.0.1:8787 REI_EVAL_LOGIN=containers/.secrets/dev-login.json \
//   REI_EVAL_OUT=/tmp/codemode-run.json npx vitest run --project server apps/server/eval/codemode
// REI_EVAL_ARMS (off,on), REI_EVAL_ONLY (scenario ids, comma-separated), REI_EVAL_REPEAT (default 1) and
// REI_EVAL_LABEL (written into the output, e.g. "inline-budget-1500") narrow or label a run. The stack needs
// REI_DEMO_TOOLS=1 (the fixture connector) and Code mode available. The inline budget is the server's
// REI_CODEMODE_INLINE_BUDGET; set it on the stack before a run. `node apps/server/eval/codemode/report.ts <run.json>...`
// prints the tables RESULTS.md records.
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CODEMODE_LIMITS } from "../../src/pi/codemode.ts";
import { startSignedIn, type TestServer } from "../../test/helpers/server.ts";
import { type Arm, cleanup, liveClient, purge, type RunMetrics, runOnce, seed, setCodeMode } from "./driver.ts";
import { SCENARIOS, type SeedIds } from "./scenarios.ts";

const fauxText = (id: string, arm: Arm, ids: SeedIds): string => {
  const scenario = SCENARIOS.find((s) => s.id === id)!;
  return arm === "off"
    ? scenario.faux.off(ids)
    : `[tool: codemode ${JSON.stringify({ code: scenario.faux.script(ids) })}]`;
};

describe("code mode eval, faux model", () => {
  let server: TestServer;
  let ids: SeedIds;
  const runs: RunMetrics[] = [];
  beforeAll(async () => {
    server = await startSignedIn();
    ids = await seed(server.client);
  }, 60_000);
  afterAll(async () => {
    await server?.destroy();
  });

  it("has about ten scenarios, one of them a single lookup and one a Chinese request", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    expect(SCENARIOS.filter((s) => s.kind === "single")).toHaveLength(1);
    expect(SCENARIOS.filter((s) => s.kind === "approval")).toHaveLength(1);
    expect(SCENARIOS.some((s) => /[一-鿿]/.test(s.prompt))).toBe(true);
  });

  it("an answer that is wrong or empty fails its check", () => {
    for (const s of SCENARIOS)
      expect(s.check({ answer: "I could not find anything.", approvals: [] }), s.id).not.toEqual([]);
  });

  for (const scenario of SCENARIOS) {
    for (const arm of ["off", "on"] as const) {
      it(`${scenario.id} (${arm})`, async () => {
        await setCodeMode(server.client, arm === "on");
        const m = await runOnce(server.client, scenario, arm, {
          text: fauxText(scenario.id, arm, ids),
          timeoutMs: 40_000,
          answerFromTools: true,
        });
        runs.push(m);
        if (arm === "on") {
          // With a script the answer is what the script printed.
          expect(m.failures, `${scenario.id}: ${m.answer}`).toEqual([]);
          expect(m.scripts).toBe(1);
          expect(m.scriptFailures).toEqual({});
          expect(m.nestedCalls).toBeGreaterThanOrEqual(1);
          expect(m.directCalls).toBe(0);
          expect(m.firstCall.codemodeSection).toBeGreaterThan(0);
        } else {
          // The faux model cannot work out an answer from the results, so only the calls are checked.
          expect(m.scripts).toBe(0);
          expect(m.nestedCalls).toBe(0);
          expect(m.directCalls).toBeGreaterThanOrEqual(1);
          expect(m.firstCall.codemodeSection).toBe(0);
        }
        expect(m.firstCall.prompt).toBeGreaterThan(0);
        expect(m.wallMs).toBeGreaterThan(0);
        if (scenario.kind === "approval") expect(m.approvals).toEqual({ asked: 3, decided: 3 });
      }, 60_000);
    }
  }

  it("a script takes fewer model turns than the same calls made one by one", () => {
    const by = (id: string, arm: Arm) => runs.find((r) => r.scenario === id && r.arm === arm)!;
    for (const id of [
      "library-grep",
      "library-max",
      "knowledge-tag",
      "runbook-scan",
      "records-overdue",
      "records-sum",
    ]) {
      expect(by(id, "on").nestedCalls, id).toBeGreaterThanOrEqual(9);
      expect(by(id, "off").directCalls, id).toBeGreaterThanOrEqual(9);
      expect(by(id, "on").turns, id).toBeLessThan(by(id, "off").turns);
    }
    // The setting on adds its section to every conversation's first call.
    for (const s of SCENARIOS)
      expect(by(s.id, "on").firstCall.prompt, s.id).toBeGreaterThan(by(s.id, "off").firstCall.prompt);
    if (process.env.REI_EVAL_OUT && !process.env.REI_EVAL_URL)
      writeFileSync(process.env.REI_EVAL_OUT, JSON.stringify({ label: "faux", runs }, null, 2));
  });
});

describe("code mode eval, inline budget (faux model)", () => {
  it("the codemode section grows with the budget and stays near it", async () => {
    const sizes: Record<number, number> = {};
    for (const inlineBudget of [0, 1500, 3000]) {
      const server = await startSignedIn({ config: { codemode: { ...DEFAULT_CODEMODE_LIMITS, inlineBudget } } });
      try {
        await setCodeMode(server.client, true);
        const scenario = SCENARIOS.find((s) => s.id === "single-lookup")!;
        const m = await runOnce(server.client, scenario, "on", { text: "hello", timeoutMs: 40_000 });
        sizes[inlineBudget] = m.firstCall.codemodeSection;
      } finally {
        await server.destroy();
      }
    }
    console.log(`codemode section tokens by inline budget: ${JSON.stringify(sizes)}`);
    expect(sizes[0]).toBeLessThan(sizes[1500]!);
    expect(sizes[1500]).toBeLessThan(sizes[3000]!);
    // Without declarations the section is the instructions only; the rest of the budget is declarations.
    expect(sizes[3000]! - sizes[0]!).toBeLessThanOrEqual(3000 + 200);
  }, 120_000);
});

const live = process.env.REI_EVAL_URL;
describe.skipIf(!live)("code mode eval, real model (REI_EVAL_URL)", () => {
  it(
    "runs every scenario with Code mode off and on and writes the metrics",
    async () => {
      const login = JSON.parse(
        readFileSync(process.env.REI_EVAL_LOGIN ?? "containers/.secrets/dev-login.json", "utf8"),
      ) as {
        password: string;
      };
      const client = await liveClient(live!, login.password);
      const arms = (process.env.REI_EVAL_ARMS ?? "off,on").split(",") as Arm[];
      const only = process.env.REI_EVAL_ONLY?.split(",");
      const repeat = Number(process.env.REI_EVAL_REPEAT ?? 1);
      const wasOn =
        ((await client.get("/api/settings/behavior")).body as { codeMode?: { enabled?: boolean } }).codeMode?.enabled ??
        false;
      await purge(client); // fixtures a killed run left behind
      const ids = await seed(client);
      const runs: RunMetrics[] = [];
      try {
        for (const arm of arms) {
          await setCodeMode(client, arm === "on");
          for (const scenario of SCENARIOS.filter((s) => !only || only.includes(s.id)))
            for (let i = 0; i < repeat; i++) {
              const m = await runOnce(client, scenario, arm, { text: scenario.prompt, timeoutMs: 15 * 60_000 });
              runs.push(m);
              console.log(
                `${scenario.id} ${arm}: ${m.success ? "ok" : `FAIL ${m.failures.join("; ")}`} turns=${m.turns} in=${m.inputTokens} scripts=${m.scripts} nested=${m.nestedCalls} wall=${(m.wallMs / 1000).toFixed(1)}s`,
              );
              if (process.env.REI_EVAL_OUT)
                writeFileSync(
                  process.env.REI_EVAL_OUT,
                  JSON.stringify({ label: process.env.REI_EVAL_LABEL ?? "", runs }, null, 2),
                );
            }
        }
      } finally {
        await setCodeMode(client, wasOn);
        await cleanup(client, ids);
      }
      expect(runs.length).toBeGreaterThan(0);
    },
    3 * 60 * 60_000,
  );
});
