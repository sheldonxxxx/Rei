import type { Message } from "@rei/protocol";
import { describe, expect, it } from "vitest";
import { liftApprovalCards } from "./approvals.ts";

const msg = (over: Partial<Message>): Message => ({ id: "m", role: "assistant", runId: "r1", ...over }) as Message;

describe("liftApprovalCards", () => {
  it("moves a run's approval card above its reply, under the activity row", () => {
    const user = msg({ id: "u1", role: "user" });
    const reply = msg({ id: "a1", role: "assistant", text: "Sent." });
    const card = msg({ id: "ap1", role: "approval" });
    const order = liftApprovalCards([user, reply, card]).map((m) => m.id);
    expect(order).toEqual(["u1", "ap1", "a1"]);
  });

  it("keeps several cards of one run in their own order", () => {
    const user = msg({ id: "u1", role: "user" });
    const reply = msg({ id: "a1", role: "assistant" });
    const first = msg({ id: "ap1", role: "approval" });
    const second = msg({ id: "ap2", role: "approval" });
    expect(
      liftApprovalCards([user, reply, first, second])
        .map((m) => m.id)
        .join(","),
    ).toBe("u1,ap1,ap2,a1");
  });

  it("leaves a card with no run, or whose reply is not in view, where it is", () => {
    const user = msg({ id: "u1", role: "user" });
    const reply = msg({ id: "a1", role: "assistant" });
    const loose = msg({ id: "ap1", role: "approval", runId: null });
    const other = msg({ id: "ap2", role: "approval", runId: "r9" });
    expect(
      liftApprovalCards([user, reply, loose, other])
        .map((m) => m.id)
        .join(","),
    ).toBe("u1,a1,ap1,ap2");
  });

  it("returns the same list when no reply is in view", () => {
    const list = [msg({ id: "u1", role: "user" }), msg({ id: "ap1", role: "approval" })];
    expect(liftApprovalCards(list)).toBe(list);
  });

  it("places the card before the run's last reply when a continue added another", () => {
    const user = msg({ id: "u1", role: "user" });
    const first = msg({ id: "a1", role: "assistant" });
    const second = msg({ id: "a2", role: "assistant" });
    const card = msg({ id: "ap1", role: "approval" });
    expect(
      liftApprovalCards([user, first, second, card])
        .map((m) => m.id)
        .join(","),
    ).toBe("u1,a1,ap1,a2");
  });
});
