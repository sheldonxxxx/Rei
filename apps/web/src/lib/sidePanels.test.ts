import { describe, expect, it } from "vitest";
import { sidePanelReducer as reduce, type SidePanel } from "./sidePanels.ts";

const none: SidePanel = { kind: "none" };
const focus = { nonce: 1, runId: "run_1", stepId: null };

describe("side panels", () => {
  it("opens one panel at a time", () => {
    let s = reduce(none, { type: "toggle-sessions" });
    expect(s).toEqual({ kind: "sessions" });
    s = reduce(s, { type: "toggle-browser" });
    expect(s).toEqual({ kind: "browser", autoStart: 0 });
    s = reduce(s, { type: "inspect", focus });
    expect(s).toEqual({ kind: "inspector", focus });
    s = reduce(s, { type: "toggle-sessions" });
    expect(s).toEqual({ kind: "sessions" });
  });

  it("toggling the open panel closes it", () => {
    expect(reduce({ kind: "sessions" }, { type: "toggle-sessions" })).toEqual(none);
    expect(reduce({ kind: "browser", autoStart: 2 }, { type: "toggle-browser" })).toEqual(none);
  });

  it("take-over raises autoStart only while the browser stays open", () => {
    let s = reduce({ kind: "inspector", focus }, { type: "take-over" });
    expect(s).toEqual({ kind: "browser", autoStart: 1 });
    s = reduce(s, { type: "take-over" });
    expect(s).toEqual({ kind: "browser", autoStart: 2 });
    s = reduce(reduce(s, { type: "close", panel: "browser" }), { type: "take-over" });
    expect(s).toEqual({ kind: "browser", autoStart: 1 });
  });

  it("show-browser keeps an open browser untouched", () => {
    const open: SidePanel = { kind: "browser", autoStart: 3 };
    expect(reduce(open, { type: "show-browser" })).toBe(open);
    expect(reduce({ kind: "sessions" }, { type: "show-browser" })).toEqual({ kind: "browser", autoStart: 0 });
  });

  it("closing a panel that is not open leaves the current one alone", () => {
    const open: SidePanel = { kind: "sessions" };
    expect(reduce(open, { type: "close", panel: "inspector" })).toBe(open);
    expect(reduce(open, { type: "close", panel: "sessions" })).toEqual(none);
  });
});
