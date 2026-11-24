import { describe, expect, it } from "vitest";
import { classifyError, createLogger, type LogFields, type LogLevel, parseLogLevel } from "../src/index.ts";
import { canaryError, leakedCanaries } from "./canaries.ts";

const capture = (level?: LogLevel) => {
  const lines: string[] = [];
  const log = createLogger({
    service: "control",
    write: (line) => lines.push(line),
    now: () => Date.UTC(2026, 10, 8),
    ...(level ? { level } : {}),
  });
  return { lines, log, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
};

describe("createLogger", () => {
  it("writes timestamp, level, service and event first, then the safe fields", () => {
    const { lines, log } = capture();
    log.info("run.started", { runId: "run_1", durationMs: 12 });
    expect(lines[0]).toBe(
      '{"timestamp":"2026-11-08T00:00:00.000Z","level":"info","service":"control","event":"run.started","runId":"run_1","durationMs":12}',
    );
  });

  it("filters below the configured level (default info)", () => {
    const def = capture();
    def.log.debug("a");
    def.log.info("b");
    expect(def.parsed().map((l) => l.event)).toEqual(["b"]);
    const warn = capture("warn");
    for (const level of ["debug", "info", "warn", "error"] as const) warn.log[level](`at.${level}`);
    expect(warn.parsed().map((l) => l.level)).toEqual(["warn", "error"]);
    const debug = capture("debug");
    debug.log.debug("c");
    expect(debug.parsed()).toMatchObject([{ level: "debug", event: "c" }]);
  });

  it("applies the same content rules at debug", () => {
    const { lines, log } = capture("debug");
    log.debug("detail", { note: canaryError().message, ...classifyError(canaryError()) });
    expect(leakedCanaries(lines.join("\n"))).toEqual([]);
  });

  it("keeps protected keys and an unsafe event name under its control", () => {
    const { parsed, log } = capture();
    log.warn("two words", { service: "evil", level: "error", timestamp: "x" } as unknown as LogFields);
    expect(parsed()[0]).toEqual({
      timestamp: "2026-11-08T00:00:00.000Z",
      level: "warn",
      service: "control",
      event: "[dropped]",
    });
  });

  it("runs the service redactor over fields", () => {
    const lines: string[] = [];
    const log = createLogger({
      service: "gateway",
      write: (l) => lines.push(l),
      redact: (s) => s.replace("abc", "[r]"),
    });
    log.info("x", { v: "abc" });
    expect(JSON.parse(lines[0]!).v).toBe("[r]");
  });
});

describe("parseLogLevel", () => {
  it("accepts the four levels in any case, and falls back when unset or empty", () => {
    expect(parseLogLevel("DEBUG")).toBe("debug");
    expect(parseLogLevel(" warn ")).toBe("warn");
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("", "error")).toBe("error");
  });

  it("rejects anything else so a typo stops startup", () => {
    expect(() => parseLogLevel("verbose")).toThrow(/REI_LOG_LEVEL must be one of debug, info, warn, error/);
    expect(() => parseLogLevel("trace")).toThrow();
  });
});
