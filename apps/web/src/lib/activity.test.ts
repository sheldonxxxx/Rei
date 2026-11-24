import type { ConversationLive } from "@rei/protocol";
import { describe, expect, it } from "vitest";
import { toolStep } from "../test/fixtures.ts";
import { activityStatus, isParkedStep, parkedCalls } from "./activity.ts";

describe("parked tool calls", () => {
  it("takes the sleeping and waiting slots of the live run as parked", () => {
    const live: ConversationLive = {
      runId: "run_1",
      tools: [
        { callId: "a", name: "x", status: "sleeping" },
        { callId: "b", name: "x", status: "waiting" },
        { callId: "c", name: "x", status: "running" },
        { callId: "d", name: "x", status: "pending" },
        { callId: "e", name: "x", status: "done" },
      ],
    };
    expect([...parkedCalls(live)]).toEqual(["a", "b"]);
    expect(parkedCalls(null).size).toBe(0);
  });

  it("reads a running step whose call is parked as waiting, and only a running one", () => {
    const parked = new Set(["a"]);
    expect(activityStatus(toolStep({ status: "running", toolCallId: "a" }), undefined, false, parked)).toBe("Waiting");
    expect(
      activityStatus(toolStep({ status: "running", toolCallId: "a", decision: "ask" }), undefined, false, parked),
    ).toBe("Waiting for approval");
    expect(activityStatus(toolStep({ status: "running", toolCallId: "b" }), undefined, false, parked)).toBe("Running");
    expect(isParkedStep(toolStep({ status: "ok", toolCallId: "a" }), parked)).toBe(false);
  });
});
