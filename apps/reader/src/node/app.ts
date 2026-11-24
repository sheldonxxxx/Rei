// The reader's HTTP surface. It trusts its caller (the gateway, the only service on its network); there is no token here.

import type { Logger } from "@rei/logging";
import { READ_CALLER_HEADER, READ_ID_HEADER, type ReadResponse } from "@rei/protocol";
import { Hono } from "hono";
import { performRead, type ReadDeps } from "../core/read.ts";
import { type ParsedRead, parseReadRequest } from "../core/request.ts";
import { computeStats } from "../core/stats.ts";
import { ReaderError } from "../core/types.ts";
import type { SqliteAttempts } from "./attempts.ts";

export interface ReaderAppDeps extends ReadDeps {
  log: Logger;
  /** Where render attempts are kept; GET /stats reads them. Unset: no statistics. */
  attempts?: SqliteAttempts | undefined;
}

const DAY_MS = 86_400_000;

/** `30d`, `12h` or a bare number of days. */
export function parseSince(text: string | undefined): number | undefined {
  if (text === undefined || text === "") return 30 * DAY_MS;
  const m = /^(\d{1,4})([dh]?)$/.exec(text);
  if (!m) return undefined;
  return Number(m[1]) * (m[2] === "h" ? 3_600_000 : DAY_MS);
}

const MAX_BODY = 16 * 1024;

export function createReaderApp(deps: ReaderAppDeps): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/stats", (c) => {
    const since = parseSince(c.req.query("since"));
    if (since === undefined)
      return c.json({ error: { code: "bad_request", message: "since must look like 30d or 12h." } }, 400);
    if (!deps.attempts) return c.json({ error: { code: "unavailable", message: "No attempt store." } }, 503);
    return c.json(computeStats(deps.attempts.rows(since), since, Date.now()));
  });
  app.post("/read", async (c) => {
    const raw = await c.req.text();
    if (raw.length > MAX_BODY)
      return c.json({ error: { code: "bad_request", message: "The body is too large." } }, 400);
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      return c.json({ error: { code: "bad_request", message: "The body must be JSON." } }, 400);
    }
    let parsed: ParsedRead;
    try {
      parsed = parseReadRequest(input, c.req.header("x-rei-step-id"));
    } catch (error) {
      if (!(error instanceof ReaderError)) throw error;
      return c.json({ error: { code: "bad_request", message: error.message } }, 400);
    }
    const caller = c.req.header(READ_CALLER_HEADER) ?? "unknown";
    const readId = c.req.header(READ_ID_HEADER) ?? "";
    deps.log.debug("read.request", { caller: caller.slice(0, 32), host: parsed.url.hostname, readId });
    const after: (() => Promise<void>)[] = [];
    const response: ReadResponse = await performRead(parsed, deps, c.req.raw.signal, {
      readId,
      caller,
      defer: (task) => void after.push(task),
    });
    const res = c.json(response);
    // The shadow comparisons run once the answer is on its way.
    for (const task of after) setImmediate(() => void task().catch(() => undefined));
    return res;
  });
  return app;
}
