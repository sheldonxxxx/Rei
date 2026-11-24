import { describe, expect, it } from "vitest";
import { GLOBAL_TYPES } from "./hooks.ts";

describe("global stream types", () => {
  it("listens for the events that change the agent and session lists", () => {
    for (const type of ["snapshot", "agent.upserted", "agent.removed", "session.upserted", "session.removed"])
      expect(GLOBAL_TYPES).toContain(type);
  });

  it("listens for the companion change, so another tab's pick shows at once", () => {
    expect(GLOBAL_TYPES).toContain("companion.changed");
  });
});
