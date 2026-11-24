import { describe, expect, it } from "vitest";
import { initializeDatabase } from "../src/db/schema.ts";
import { openSqliteDb } from "../src/node/sqlite-db.ts";
import {
  behaviorSettings,
  CEILINGS,
  CONFIGLESS,
  defaultBehavior,
  updateBehavior,
} from "../src/pi/behavior-settings.ts";
import { EventLog } from "../src/store/events.ts";
import { AppStore } from "../src/store/store.ts";

function fixture() {
  const db = openSqliteDb(":memory:");
  initializeDatabase(db);
  const clock = { now: () => 1 };
  const store = new AppStore(db, clock, new EventLog(clock));
  return { store, agent: store.seedDefaultAgent() };
}

describe("behavior settings", () => {
  it("ignores the retired rendering switch in saved settings", () => {
    const { store } = fixture();
    store.metaSet("behavior_settings", JSON.stringify({ web: { jsRendering: "off" }, memory: { historyHits: 4 } }));
    const settings = behaviorSettings(store, CONFIGLESS);
    expect(settings).not.toHaveProperty("web");
    expect(settings.memory.historyHits).toBe(4);
  });

  it("defaults come from server config", () => {
    const { store } = fixture();
    expect(behaviorSettings(store, CONFIGLESS)).toEqual(defaultBehavior(CONFIGLESS));
    expect(behaviorSettings(store, CONFIGLESS).runLimits).toEqual({ maxModelCalls: 50, maxRunMinutes: 30 });
    const retryOff = defaultBehavior({ ...CONFIGLESS, retry: { enabled: false, maxRetries: 0, baseDelayMs: 2000 } });
    expect(retryOff.retry.maxRetries).toBe(0);
  });

  it("saves partial updates, keeps other groups, and resets with null", () => {
    const { store } = fixture();
    updateBehavior(store, CONFIGLESS, { runLimits: { maxModelCalls: 10 } });
    updateBehavior(store, CONFIGLESS, {
      memory: { historyHits: 3, injectRecent: false },
      generation: { maxOutputTokens: 800 },
    });
    const s = behaviorSettings(store, CONFIGLESS);
    expect(s.runLimits).toEqual({ maxModelCalls: 10, maxRunMinutes: 30 });
    expect(s.memory).toEqual({ injectProfile: true, injectRecent: false, historyHits: 3 });
    expect(s.generation.maxOutputTokens).toBe(800);
    updateBehavior(store, CONFIGLESS, { generation: { maxOutputTokens: null } });
    expect(behaviorSettings(store, CONFIGLESS).generation.maxOutputTokens).toBeNull();
    updateBehavior(store, CONFIGLESS, null);
    expect(behaviorSettings(store, CONFIGLESS)).toEqual(defaultBehavior(CONFIGLESS));
  });

  it("saves the OpenAI native search switch, off by default, and rejects non-booleans", () => {
    const { store } = fixture();
    expect(behaviorSettings(store, CONFIGLESS).search.useOpenAiNativeSearch).toBe(false);
    updateBehavior(store, CONFIGLESS, { search: { useOpenAiNativeSearch: true } });
    expect(behaviorSettings(store, CONFIGLESS).search.useOpenAiNativeSearch).toBe(true);
    expect(() => updateBehavior(store, CONFIGLESS, { search: { useOpenAiNativeSearch: "yes" } })).toThrow(/on or off/);
  });

  it("saves the code mode switch, off by default, and rejects non-booleans", () => {
    const { store } = fixture();
    expect(behaviorSettings(store, CONFIGLESS).codeMode.enabled).toBe(false);
    updateBehavior(store, CONFIGLESS, { codeMode: { enabled: true } });
    expect(behaviorSettings(store, CONFIGLESS).codeMode.enabled).toBe(true);
    expect(() => updateBehavior(store, CONFIGLESS, { codeMode: { enabled: 1 } })).toThrow(/on or off/);
    updateBehavior(store, CONFIGLESS, null);
    expect(behaviorSettings(store, CONFIGLESS).codeMode.enabled).toBe(false);
  });

  it("never allows a zero or above-ceiling run limit, and rejects bad input without saving", () => {
    const { store } = fixture();
    expect(() => updateBehavior(store, CONFIGLESS, { runLimits: { maxModelCalls: 0 } })).toThrow(/Model calls/);
    expect(() =>
      updateBehavior(store, CONFIGLESS, { runLimits: { maxRunMinutes: CEILINGS.maxRunMinutes + 1 } }),
    ).toThrow();
    expect(() => updateBehavior(store, CONFIGLESS, { retry: { maxRetries: 11 } })).toThrow(/Retries/);
    expect(() => updateBehavior(store, CONFIGLESS, { memory: { injectProfile: "no" } })).toThrow(/on or off/);
    expect(() => updateBehavior(store, CONFIGLESS, { bogus: {} })).toThrow(/Unknown/);
    expect(behaviorSettings(store, CONFIGLESS)).toEqual(defaultBehavior(CONFIGLESS));
  });

  it("falls back per group when a stored value is corrupt", () => {
    const { store } = fixture();
    store.metaSet(
      "behavior_settings",
      JSON.stringify({ runLimits: { maxModelCalls: 0 }, discovery: { maxSkills: 1 } }),
    );
    const s = behaviorSettings(store, CONFIGLESS);
    expect(s.runLimits.maxModelCalls).toBe(50);
    expect(s.discovery.maxSkills).toBe(1);
  });
});

describe("sending while a reply runs", () => {
  it("steers by default, saves queue, refuses other values, and keeps the default for a bad stored value", () => {
    const { store } = fixture();
    expect(behaviorSettings(store, CONFIGLESS).chat).toEqual({ whenBusy: "steer" });
    expect(updateBehavior(store, CONFIGLESS, { chat: { whenBusy: "queue" } }).settings.chat.whenBusy).toBe("queue");
    expect(() => updateBehavior(store, CONFIGLESS, { chat: { whenBusy: "interrupt" } })).toThrow(/steer or queue/);
    store.metaSet("behavior_settings", JSON.stringify({ chat: { whenBusy: 3 }, memory: { historyHits: 4 } }));
    expect(behaviorSettings(store, CONFIGLESS).chat.whenBusy).toBe("steer");
    expect(behaviorSettings(store, CONFIGLESS).memory.historyHits).toBe(4);
  });
});

describe("agent instructions", () => {
  it("edits are logged, readable per session, and restorable from history", () => {
    const { store, agent } = fixture();
    const id = agent.agent.id;
    store.updateAgentSettings(id, { instructions: "Be brief." });
    store.updateAgentSettings(id, { instructions: "Be formal." });
    expect(store.instructionsOf(agent.session.id)).toBe("Be formal.");
    const history = store.instructionHistory(id);
    expect(history.map((h) => h.text)).toEqual(["Be brief.", expect.any(String)]);
    store.updateAgentSettings(id, { instructions: history[0]!.text });
    expect(store.instructionsOf(agent.session.id)).toBe("Be brief.");
  });
});
