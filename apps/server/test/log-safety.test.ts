// Service-log content rules (ADR 0003) at the server's boundary: canary strings in thrown errors and caller fields
// never reach stdout, while the event, its level and the error's code still do.
import { CANARIES, canaryError, leakedCanaries } from "@rei/logging/canaries";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryIndexing } from "../src/memory/history-indexing.ts";
import { classifyError, createLogger, type LogFields } from "../src/util/log.ts";
import { FakeRetrieval } from "./helpers/retrieval.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";

const capture = () => {
  const lines: string[] = [];
  return {
    lines,
    log: createLogger(
      (line) => lines.push(line),
      () => Date.UTC(2026, 10, 7),
    ),
  };
};

describe("server logger", () => {
  it("writes the event and safe fields, and drops every canary", () => {
    const { lines, log } = capture();
    log.error("demo.failed", {
      runId: "run_1",
      status: 502,
      detail: CANARIES.personal,
      host: CANARIES.urlWithToken,
      who: CANARIES.email,
      key: CANARIES.apiKey,
      ...classifyError(canaryError()),
    });
    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: "2026-11-07T00:00:00.000Z",
      level: "error",
      service: "control",
      event: "demo.failed",
      runId: "run_1",
      status: 502,
      detail: "[dropped]",
      host: "[dropped]",
      who: "[dropped]",
      key: "[redacted-key]",
      errorCode: "unknown",
      errorClass: "Error",
    });
    expect(leakedCanaries(lines.join("\n"))).toEqual([]);
  });

  it("does not let caller fields overwrite the level or the event", () => {
    const { lines, log } = capture();
    log.info("real.event", {
      level: "error",
      event: "fake",
      t: "1999",
      service: "x",
      timestamp: "1999",
    } as unknown as LogFields);
    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: "2026-11-07T00:00:00.000Z",
      level: "info",
      service: "control",
      event: "real.event",
    });
  });
});

describe("history indexing failure", () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.destroy();
    server = undefined;
  });

  it("logs a search outage by code, without the upstream error text", async () => {
    server = await startSignedIn();
    const store = server.host.plane.store;
    const retrieval = new (class extends FakeRetrieval {
      override async searchLexical(): Promise<never> {
        throw Object.assign(canaryError(), { code: "ECONNRESET" });
      }
    })();
    const { lines, log } = capture();
    const history = new HistoryIndexing({
      store,
      clock: store.clock,
      log,
      embedder: undefined,
      onPurgeSession: () => {},
      retrieval,
    });
    await history.keywordSearch("anything", {});
    const failed = lines.map((line) => JSON.parse(line)).find((e) => e.event === "memory.retrieval_search_failed");
    expect(failed).toMatchObject({ level: "warn", side: "lexical", errorCode: "econnreset", errorClass: "Error" });
    expect(leakedCanaries(lines.join("\n"))).toEqual([]);
  });
});
