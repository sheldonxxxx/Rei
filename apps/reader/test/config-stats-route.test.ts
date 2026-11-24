import { describe, expect, it } from "vitest";
import type { ReadDeps } from "../src/core/read.ts";
import { createReaderApp, parseSince } from "../src/node/app.ts";
import { SqliteAttempts } from "../src/node/attempts.ts";
import { loadConfig, parseEngines, parseShadowRate } from "../src/node/config.ts";

const silent = { debug() {}, info() {}, warn() {}, error() {} } as never;
const deps = (attempts?: SqliteAttempts) =>
  ({
    log: silent,
    attempts,
    fetch: async () => {
      throw new Error("no");
    },
    openFetchJob: () => ({ token: "t", revoke() {} }),
  }) as unknown as ReadDeps & { log: never };

describe("config parsers", () => {
  it("parses engines in order, dedupes and rejects unknown ones", () => {
    expect(parseEngines(undefined)).toEqual(["moli", "chromium"]);
    expect(parseEngines(" chromium , moli,chromium")).toEqual(["chromium", "moli"]);
    expect(() => parseEngines("firefox")).toThrow(/unknown engine/);
    expect(() => parseEngines(",")).toThrow(/at least one/);
  });
  it("parses the shadow rate", () => {
    expect(parseShadowRate(undefined)).toBe(0.1);
    expect(parseShadowRate("0")).toBe(0);
    expect(parseShadowRate("1")).toBe(1);
    expect(() => parseShadowRate("2")).toThrow();
    expect(() => parseShadowRate("x")).toThrow();
  });
  it("loads the render settings", () => {
    const config = loadConfig({
      READER_ENGINES: "moli",
      READER_RENDER_SLOTS: "3",
      READER_SHADOW_RATE: "0.5",
      READER_MOLI_PATH: "/m",
    });
    expect(config).toMatchObject({
      engines: ["moli"],
      renderSlots: 3,
      shadowRate: 0.5,
      moliPath: "/m",
      chromiumPath: "/usr/bin/chromium",
    });
    expect(loadConfig({})).toMatchObject({
      engines: ["moli", "chromium"],
      renderSlots: 2,
      shadowRate: 0.1,
      moliPath: "/usr/local/bin/moli",
    });
    expect(() => loadConfig({ READER_RENDER_SLOTS: "0" })).toThrow();
  });
});

describe("GET /stats", () => {
  it("parses windows", () => {
    expect(parseSince(undefined)).toBe(30 * 86_400_000);
    expect(parseSince("7d")).toBe(7 * 86_400_000);
    expect(parseSince("12h")).toBe(12 * 3_600_000);
    expect(parseSince("3")).toBe(3 * 86_400_000);
    expect(parseSince("soon")).toBeUndefined();
  });
  it("answers statistics, 400 for a bad window and 503 without a store", async () => {
    const attempts = new SqliteAttempts(":memory:");
    const app = createReaderApp(deps(attempts));
    const ok = await app.request("/stats?since=7d");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ primaryRenders: 0, decision: { ready: false } });
    expect((await app.request("/stats?since=x")).status).toBe(400);
    expect((await createReaderApp(deps()).request("/stats")).status).toBe(503);
  });
});
