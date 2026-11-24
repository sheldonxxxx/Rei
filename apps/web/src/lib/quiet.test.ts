import type { Message, RunTrace, StepSummary } from "@rei/protocol";
import { describe, expect, it } from "vitest";
import { activityStatus, stepNeedsAttention } from "./activity.ts";
import { approvalOutcomes, isSimpleNoise, quietRunIds } from "./quiet.ts";

const step = (over: Partial<StepSummary>): StepSummary =>
  ({ id: "s", type: "tool.call", status: "ok", ...over }) as StepSummary;
const trace = (id: string, steps: StepSummary[], over: Partial<RunTrace> = {}): RunTrace =>
  ({ run: { id, status: "completed" }, triggerMessageId: null, steps, totals: {}, ...over }) as unknown as RunTrace;
const msg = (over: Record<string, unknown>) => ({ id: "m", ...over }) as unknown as Message;

describe("approved steps", () => {
  const blocked = step({ status: "blocked", decision: "ask", approvalId: "ap1" });
  it("reads Approved once the approval is decided, Needs approval until then", () => {
    expect(activityStatus(blocked)).toBe("Needs approval");
    expect(activityStatus(blocked, new Map([["ap1", "pending"]]))).toBe("Needs approval");
    expect(activityStatus(blocked, new Map([["ap1", "approved"]]))).toBe("Approved");
    expect(activityStatus(blocked, new Map([["ap1", "denied"]]))).toBe("Denied");
  });
  it("stops asking for attention once decided", () => {
    expect(stepNeedsAttention(blocked)).toBe(true);
    expect(stepNeedsAttention(blocked, new Map([["ap1", "approved"]]))).toBe(false);
  });
});

describe("Simple mode noise", () => {
  const outcomes = approvalOutcomes([
    msg({ role: "approval", approval: { id: "ap1", status: "approved" } }),
    msg({ role: "approval", approval: { id: "ap2", status: "pending" } }),
  ]);
  const memorySave = (id: string, over: Partial<RunTrace> = {}) =>
    trace(
      id,
      [
        step({ type: "llm.call" }),
        step({ toolName: "memory_add", status: "blocked", decision: "ask", approvalId: "ap1" }),
        step({ type: "llm.call" }),
      ],
      over,
    );

  it("quiets a self-started run that only saved memory", () => {
    expect([
      ...quietRunIds([memorySave("r1", { triggerMessageId: "u:r1" })], outcomes, [msg({ id: "u:r1", role: "notice" })]),
    ]).toEqual(["r1"]);
  });
  it("keeps your own runs, other work, failures and a save still waiting on you", () => {
    const research = trace("r2", [step({ toolName: "memory_add" }), step({ toolName: "web_search" })]);
    const failed = trace("r3", [step({ toolName: "memory_add", status: "error" })]);
    const waiting = trace("r4", [
      step({ toolName: "memory_add", status: "blocked", decision: "ask", approvalId: "ap2" }),
    ]);
    const mine = memorySave("r5", { triggerMessageId: "u1" });
    expect(quietRunIds([research, failed, waiting, mine], outcomes, [msg({ id: "u1", role: "user" })]).size).toBe(0);
  });
  it("leaves out approved cards, memory chips and the follow-ups, and nothing else", () => {
    const quiet = new Set(["r1"]);
    expect(isSimpleNoise(msg({ role: "memory" }), quiet)).toBe(true);
    expect(isSimpleNoise(msg({ role: "approval", approval: { status: "approved" } }), quiet)).toBe(true);
    expect(isSimpleNoise(msg({ role: "approval", approval: { status: "pending" } }), quiet)).toBe(false);
    expect(isSimpleNoise(msg({ role: "approval", approval: { status: "denied" } }), quiet)).toBe(false);
    expect(isSimpleNoise(msg({ role: "assistant", runId: "r1" }), quiet)).toBe(true);
    expect(isSimpleNoise(msg({ role: "assistant", runId: "r9" }), quiet)).toBe(false);
  });
});
