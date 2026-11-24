// One read: fetch the URL through the reader's proxy, follow redirects by hand (a redirect to a host the caller did not
// allow is handed back, not followed), extract the text, and render the page in a browser when it needs JavaScript.
import { createHash } from "node:crypto";
import type { Logger } from "@rei/logging";
import type { ReadDetails, ReadEngine, ReadQuality, ReadRenderDetails, ReadResponse } from "@rei/protocol";
import { type ExtractedPage, extractBody, extractHtml, mediaType } from "./extract.ts";
import { sourceNote } from "./quality.ts";
import {
  type AttemptRow,
  type AttemptSink,
  type EngineResult,
  type Lease,
  RENDER_DEADLINE_MS,
  RENDER_MAX_HTML_CHARS,
  type RenderEngine,
  RenderFailure,
  type Slots,
} from "./render.ts";
import { hostOf, type ParsedRead, parseReadUrl } from "./request.ts";
import { type FetchResponse, type FetchViaProxy, ProxyRefused, ReaderError } from "./types.ts";

export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_BYTES = 5 * 1024 * 1024;
export const USER_AGENT = "rei/0.1 (+personal assistant)";
// Markdown first: sites that can send it (docs, blogs behind a content negotiation layer) skip the HTML-to-text step.
export const ACCEPT = "text/markdown, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.8, */*;q=0.1";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Statuses that mean "not for you" (or "not now"): the page is blocked, which never justifies another way in. */
const BLOCKED_STATUSES = new Set([401, 403, 429]);

export interface Traffic {
  connections: number;
  refused: number;
}

/** An engine with the slots that share it. */
export interface EngineEntry {
  engine: RenderEngine;
  slots: Slots;
}

export interface RenderDeps {
  /** In the order they are tried: the first renders, the second is the fallback. */
  engines: EngineEntry[];
  /** A job token for one render: its connections reach any public host, never the local network. */
  openJob(deadlineMs: number): { token: string; revoke(): Traffic };
  attempts: AttemptSink;
  /** The share of Moli successes that Chromium also renders, after the answer (0 to 1). */
  shadowRate: number;
  random?: () => number;
  deadlineMs?: number;
}

export interface ReadDeps {
  fetch: FetchViaProxy;
  /** A job token whose connections reach only `allowHosts` (and the local addresses `localNetworks` allows). */
  openFetchJob(request: ParsedRead): { token: string; revoke(): unknown };
  render?: RenderDeps | undefined;
  log?: Logger | undefined;
  now?: () => number;
  timeoutMs?: number;
}

/** What the caller of one read knows about it. */
export interface ReadContext {
  readId: string;
  caller: string;
  /** Runs `task` once the answer has been sent (the shadow comparisons). */
  defer(task: () => Promise<void>): void;
}

const NO_CONTEXT: ReadContext = { readId: "", caller: "unknown", defer: () => {} };

function networkMessage(error: unknown, host: string): string {
  if (error instanceof ProxyRefused) return `Could not reach ${host}: ${error.message.replace(/[.\s]+$/, "")}.`;
  const code = (error as { code?: unknown } | null)?.code;
  return `Could not fetch the page from ${host} (${typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : "network error"}).`;
}

/** A page read only from its summary or embedded data: the classifier says it needs JavaScript. */
export const needsJs = (page: ExtractedPage): boolean =>
  page.quality === "low_quality" && ["meta", "json-ld", "next-data", "nuxt-data"].includes(page.extractor);

const rank = (page: ExtractedPage): number => (page.quality === "success" ? 2 : page.quality === "low_quality" ? 1 : 0);
/** The better of two results: quality first, then readable characters. */
const better = (a: ExtractedPage, b: ExtractedPage): ExtractedPage =>
  rank(a) !== rank(b) ? (rank(a) > rank(b) ? a : b) : a.text.length >= b.text.length ? a : b;

const BLOCKED_TEXT = (host: string, loginWall: boolean): string =>
  loginWall
    ? `${host} asks you to sign in before it shows this page; web_fetch reads public pages only.`
    : `${host} showed a bot check instead of the page, so there is nothing to read. Do not try to get around it: use another source or tell the user.`;
const REQUIRES_JS_TEXT = "The page has no readable text without JavaScript, and web_fetch does not run JavaScript.";
const STILL_EMPTY_TEXT = "The page still had no readable text after it was rendered in the browser.";

type Trigger = AttemptRow["trigger"];
const REASON: Record<Trigger, NonNullable<ReadRenderDetails["reason"]>> = {
  requires_js: "requires_js",
  thin_low_quality: "low_quality",
  force: "forced",
};

interface Landed {
  page: ExtractedPage;
  finalUrl: string;
  method: "http" | "render";
}

/** Runs the read; every outcome the caller should hear about is a ReadResponse (never a throw). */
export async function performRead(
  request: ParsedRead,
  deps: ReadDeps,
  signal?: AbortSignal,
  context: ReadContext = NO_CONTEXT,
): Promise<ReadResponse> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let job: ReturnType<ReadDeps["openFetchJob"]> | undefined;
  let redirects = 0;
  const details: ReadDetails = { method: "http", redirects: 0, durationMs: 0 };
  const finish = (): ReadDetails => ({ ...details, redirects, durationMs: now() - startedAt });
  const failed = (message: string, quality?: ReadQuality): ReadResponse => ({
    outcome: "failed",
    message,
    details: finish(),
    ...(quality ? { quality } : {}),
  });
  const pageResponse = (landed: Landed): ReadResponse => {
    const note = sourceNote(landed.page.extractor, landed.page.quality);
    return {
      outcome: "page",
      finalUrl: landed.finalUrl,
      title: landed.page.title,
      text: landed.page.text,
      sections: landed.page.sections,
      quality: landed.page.quality as "success" | "low_quality",
      extractor: landed.page.extractor,
      method: landed.method,
      contentHash: createHash("sha256").update(landed.page.text).digest("hex"),
      ...(note ? { note } : {}),
      details: { ...finish(), method: landed.method },
    };
  };
  try {
    if (request.render === "force") {
      details.method = "render";
      const rendering = deps.render;
      if (!rendering || rendering.engines.length === 0) {
        details.render = { reason: "forced", skipped: "unavailable" };
        return failed("Web reading is not available: no browser engine is configured.");
      }
      const outcome = await renderPhase({
        request,
        deps,
        rendering,
        context,
        trigger: "force",
        url: request.url,
        fetched: undefined,
        signal: signal ?? AbortSignal.timeout(120_000),
        redirects,
      });
      details.render = outcome.render;
      if (outcome.kind === "redirect") return { outcome: "redirect", location: outcome.location, hops: 1 };
      if (outcome.kind === "failed") return failed(outcome.message, outcome.quality);
      return pageResponse(outcome.landed);
    }
    job = deps.openFetchJob(request);
    let current = request.url;
    let host = hostOf(current);
    for (let hop = 0; ; hop++) {
      let response: FetchResponse;
      try {
        response = await deps.fetch(current.href, job.token, {
          signal: combined,
          maxBytes: MAX_BYTES,
          headers: { accept: ACCEPT, "user-agent": USER_AGENT },
          stepId: request.stepId,
        });
      } catch (error) {
        if (signal?.aborted) return failed("The read was cancelled.");
        if (timeout.aborted)
          return failed(
            `${host} did not answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} seconds` : `${timeoutMs} ms`}.`,
          );
        return failed(networkMessage(error, host));
      }
      if (REDIRECTS.has(response.status)) {
        const location = response.headers.location;
        if (!location) return failed(`${host} redirected without saying where.`);
        if (hop >= request.maxRedirects) return failed(`Too many redirects (more than ${request.maxRedirects}).`);
        let next: URL;
        try {
          next = parseReadUrl(new URL(location, current).href);
        } catch (error) {
          return failed(
            `${host} redirected somewhere that cannot be fetched: ${error instanceof ReaderError ? error.message : "invalid address"}`,
          );
        }
        if (!request.allowHosts.has(hostOf(next)))
          return { outcome: "redirect", location: next.href, hops: redirects + 1 };
        redirects++;
        current = next;
        host = hostOf(next);
        continue;
      }
      details.status = response.status;
      details.bytes = response.body.byteLength;
      details.mediaType = mediaType(response.headers["content-type"]);
      if (response.status < 200 || response.status >= 300)
        return failed(
          `${host} answered HTTP ${response.status}, so there is no page to read.`,
          BLOCKED_STATUSES.has(response.status) ? "blocked" : undefined,
        );
      if (response.truncated)
        return failed(`The page is larger than ${MAX_BYTES / 1024 / 1024} MB, so it was not read.`);
      let page: ExtractedPage;
      try {
        page = extractBody(response.body, response.headers["content-type"], current.href);
      } catch (error) {
        if (error instanceof ReaderError) return failed(error.message, error.quality);
        throw error;
      }
      if (page.quality === "blocked") return failed(BLOCKED_TEXT(host, page.reasons.includes("login_wall")), "blocked");
      const shell = page.quality === "requires_js";
      if (!shell && page.text.trim() === "")
        return failed("The page has no readable text (it may need JavaScript to show its content).");
      if (page.quality === "unsupported_mime") return failed("That kind of file cannot be read as text.", page.quality);
      const fetched: Landed = { page, finalUrl: current.href, method: "http" };

      // Automatic rendering: only a page that needs JavaScript. A blocked page, an HTTP error or a
      // refusal never gets another way in.
      const trigger: Trigger | undefined = shell ? "requires_js" : needsJs(page) ? "thin_low_quality" : undefined;
      if (trigger === undefined) return pageResponse(fetched);
      const rendering = deps.render;
      const skipped =
        !rendering || rendering.engines.length === 0 ? "unavailable" : request.render === "off" ? "off" : undefined;
      if (skipped !== undefined || !rendering) {
        details.render = { reason: REASON[trigger], skipped: skipped ?? "unavailable" };
        return shell ? failed(REQUIRES_JS_TEXT, "requires_js") : pageResponse(fetched);
      }
      const outcome = await renderPhase({
        request,
        deps,
        rendering,
        context,
        trigger,
        url: current,
        fetched: shell ? undefined : fetched,
        signal: signal ?? combined,
        redirects,
      });
      details.render = outcome.render;
      if (outcome.kind === "redirect") return { outcome: "redirect", location: outcome.location, hops: redirects + 1 };
      if (outcome.kind === "failed") return failed(outcome.message, outcome.quality);
      return pageResponse(outcome.landed);
    }
  } finally {
    job?.revoke();
  }
}

interface RenderInput {
  request: ParsedRead;
  deps: ReadDeps;
  rendering: RenderDeps;
  context: ReadContext;
  trigger: Trigger;
  url: URL;
  /** The page as fetched, when there is one to fall back on (not for an app shell). */
  fetched: Landed | undefined;
  signal: AbortSignal;
  redirects: number;
}

type RenderOutcome =
  | { kind: "page"; landed: Landed; render: ReadRenderDetails }
  | { kind: "redirect"; location: string; render: ReadRenderDetails }
  | { kind: "failed"; message: string; quality?: ReadQuality; render: ReadRenderDetails };

interface Attempt {
  engine: RenderEngine;
  row: AttemptRow;
  page?: ExtractedPage;
  result?: EngineResult;
  failure?: RenderFailure;
  navigatedTo?: string;
  blocked?: string;
}

const clip = (text: string): string => text.replace(/\s+/g, " ").slice(0, 300);

async function runAttempt(
  input: RenderInput,
  entry: { engine: RenderEngine; slots: Slots },
  attemptNo: 1 | 2,
  role: AttemptRow["role"],
  fallbackReason: AttemptRow["fallbackReason"],
  lease?: Lease,
): Promise<Attempt> {
  const { request, rendering, context, url } = input;
  const { engine } = entry;
  const row: AttemptRow = {
    readId: context.readId,
    attempt: attemptNo,
    caller: context.caller,
    stepId: request.stepId,
    engine: engine.name,
    engineVersion: "unknown",
    role,
    trigger: input.trigger,
    outcome: "ok",
    errorDetail: undefined,
    quality: undefined,
    textChars: undefined,
    sections: undefined,
    ended: undefined,
    renderMs: undefined,
    slotWaitMs: undefined,
    connections: 0,
    bytes: undefined,
    refused: 0,
    blockedMedia: undefined,
    url: request.url.href,
    host: hostOf(request.url),
    fallbackReason,
    used: false,
  };
  const attempt: Attempt = { engine, row };
  let held = lease;
  try {
    held ??= await entry.slots.acquire(context.caller, role === "shadow" ? undefined : input.signal);
  } catch (error) {
    const failure = error instanceof RenderFailure ? error : new RenderFailure("cancelled", "The read was cancelled.");
    row.outcome = failure.outcome;
    attempt.failure = failure;
    row.engineVersion = engine.version();
    return attempt;
  }
  row.slotWaitMs = held.waitedMs;
  const deadlineMs = rendering.deadlineMs ?? RENDER_DEADLINE_MS;
  // The token outlives the deadline by a little, for the last read; it is revoked as soon as the render ends.
  const job = rendering.openJob(deadlineMs + 5_000);
  try {
    const result = await engine.render({
      url: url.href,
      token: job.token,
      deadlineMs,
      maxHtmlChars: RENDER_MAX_HTML_CHARS,
      signal: input.signal,
      checkNavigation: (href) => {
        let next: URL;
        try {
          next = parseReadUrl(href);
        } catch {
          return "The page sent the browser to an address that cannot be fetched, so the render was stopped.";
        }
        if (request.allowHosts.has(hostOf(next))) return undefined;
        attempt.navigatedTo = next.href;
        return `The page sent the browser to ${hostOf(next)}, which this read was not allowed to reach, so the render was stopped.`;
      },
    });
    attempt.result = result;
    row.renderMs = result.ms;
    row.ended = result.ended;
    row.blockedMedia = result.blockedMedia;
    row.bytes = result.html.length;
    const page = extractHtml(result.html, result.finalUrl);
    attempt.page = page;
    row.quality = page.quality;
    row.textChars = page.text.length;
    row.sections = page.sections.length;
  } catch (error) {
    const failure =
      error instanceof RenderFailure
        ? error
        : new RenderFailure(
            "crash",
            "The page could not be rendered in the browser.",
            String((error as Error)?.message),
          );
    attempt.failure = failure;
    row.outcome = failure.outcome;
    row.errorDetail = clip(failure.detail || failure.message);
  } finally {
    const traffic = job.revoke();
    row.connections = traffic.connections;
    row.refused = traffic.refused;
    held.release();
    row.engineVersion = engine.version();
  }
  return attempt;
}

function logAttempt(log: Logger | undefined, a: Attempt, event: "read.render" | "read.shadow"): void {
  if (!log) return;
  const r = a.row;
  const fields = {
    readId: r.readId,
    stepId: r.stepId,
    caller: r.caller,
    attempt: r.attempt,
    engine: r.engine,
    engineVersion: r.engineVersion,
    role: r.role,
    trigger: r.trigger,
    outcome: r.outcome,
    quality: r.quality,
    textChars: r.textChars,
    ended: r.ended,
    renderMs: r.renderMs,
    slotWaitMs: r.slotWaitMs,
    connections: r.connections,
    refused: r.refused,
    host: r.host,
    fallbackReason: r.fallbackReason,
  };
  if (event === "read.shadow") log.debug(event, fields);
  else if (r.outcome !== "ok" || r.role === "fallback") log.info(event, fields);
  else log.debug(event, fields);
}

const renderDetails = (input: RenderInput, attempts: Attempt[], used: Attempt | undefined): ReadRenderDetails => {
  const sum = (pick: (r: AttemptRow) => number | undefined) =>
    attempts.reduce((total, a) => total + (pick(a.row) ?? 0), 0);
  const details: ReadRenderDetails = {
    reason: REASON[input.trigger],
    slotWaitMs: sum((r) => r.slotWaitMs),
    renderMs: sum((r) => r.renderMs),
    connections: sum((r) => r.connections),
    refused: sum((r) => r.refused),
  };
  if (used?.result) {
    details.ended = used.result.ended;
    details.blockedMedia = used.result.blockedMedia;
    if (used.result.truncated) details.truncated = true;
  }
  const shown = used ?? attempts[attempts.length - 1];
  if (shown) {
    details.engine = shown.row.engine as ReadEngine;
    details.engineVersion = shown.row.engineVersion;
  }
  const second = attempts[1];
  if (second?.row.role === "fallback" && second.row.fallbackReason)
    details.fallback = { from: attempts[0]!.row.engine, reason: second.row.fallbackReason };
  return details;
};

async function renderPhase(input: RenderInput): Promise<RenderOutcome> {
  const { rendering, fetched, request, context, deps } = input;
  const [first, second] = rendering.engines;
  const attempts: Attempt[] = [];

  const record = (used: Attempt | undefined) => {
    if (used) used.row.used = true;
    for (const a of attempts) {
      rendering.attempts.record(a.row);
      logAttempt(deps.log, a, "read.render");
    }
  };
  const fail = (a: Attempt, usedFetched: boolean): RenderOutcome => {
    // What was fetched is still worth reading when there is something: the render only failed to add to it.
    record(undefined);
    const failure = a.failure!;
    const render = { ...renderDetails(input, attempts, undefined), ...(usedFetched ? { failed: true as const } : {}) };
    if (usedFetched && fetched && failure.outcome !== "cancelled") return { kind: "page", landed: fetched, render };
    return { kind: "failed", message: failure.message, render };
  };

  const a1 = await runAttempt(input, first!, 1, "primary", undefined);
  attempts.push(a1);

  // 1. The first engine could not render at all.
  // 2. It rendered, but the result still needs JavaScript or holds only the page's summary.
  let reason: "failed" | "requires_js" | "thin" | undefined;
  if (a1.failure) {
    if (a1.failure.outcome === "navigation_stopped" && a1.navigatedTo) {
      record(undefined);
      return { kind: "redirect", location: a1.navigatedTo, render: renderDetails(input, attempts, undefined) };
    }
    if (a1.failure.outcome === "cancelled" || a1.failure.outcome === "busy") return fail(a1, true);
    reason = "failed";
  } else if (a1.page) {
    if (a1.page.quality === "blocked") {
      record(a1);
      const host = hostOf(new URL(a1.result!.finalUrl));
      return {
        kind: "failed",
        message: BLOCKED_TEXT(host, a1.page.reasons.includes("login_wall")),
        quality: "blocked",
        render: renderDetails(input, attempts, a1),
      };
    }
    if (a1.page.quality === "requires_js" || a1.page.text.trim() === "") reason = "requires_js";
    else if (needsJs(a1.page)) reason = "thin";
  }

  if (reason === undefined) {
    // A good first result. A sample of Moli's is also rendered by Chromium, after the answer, to see whether it was as
    // good as it could be.
    record(a1);
    scheduleShadow(input, a1);
    return landed(input, a1, attempts);
  }
  if (!second) {
    // No fallback engine: the first result stands if it has any text, else the render failed.
    if (a1.failure) return fail(a1, true);
    return finalChoice(input, attempts, [a1], record);
  }
  if (input.signal.aborted) {
    record(undefined);
    return { kind: "failed", message: "The read was cancelled.", render: renderDetails(input, attempts, undefined) };
  }

  const a2 = await runAttempt(input, second, 2, "fallback", reason);
  attempts.push(a2);
  deps.log?.info("read.fallback", {
    readId: context.readId,
    stepId: request.stepId,
    caller: context.caller,
    from: first!.engine.name,
    to: second.engine.name,
    reason,
    host: hostOf(request.url),
    outcome: a2.row.outcome,
  });
  if (a2.failure?.outcome === "navigation_stopped" && a2.navigatedTo) {
    record(undefined);
    return { kind: "redirect", location: a2.navigatedTo, render: renderDetails(input, attempts, undefined) };
  }
  if (a2.page?.quality === "blocked") {
    record(a2);
    const host = hostOf(new URL(a2.result!.finalUrl));
    return {
      kind: "failed",
      message: BLOCKED_TEXT(host, a2.page.reasons.includes("login_wall")),
      quality: "blocked",
      render: renderDetails(input, attempts, a2),
    };
  }
  return finalChoice(input, attempts, [a1, a2], record);
}

function landed(input: RenderInput, a: Attempt, attempts: Attempt[]): RenderOutcome {
  return {
    kind: "page",
    landed: { page: a.page!, finalUrl: a.result!.finalUrl, method: "render" },
    render: renderDetails(input, attempts, a),
  };
}

/** After a fallback (or with none): the better readable result, else the page as fetched, else the failure. */
function finalChoice(
  input: RenderInput,
  attempts: Attempt[],
  tried: Attempt[],
  record: (used: Attempt | undefined) => void,
): RenderOutcome {
  const readable = tried.filter((a) => a.page && a.page.quality !== "requires_js" && a.page.text.trim() !== "");
  if (readable.length > 0) {
    const best = readable.reduce((x, y) => (better(x.page!, y.page!) === x.page ? x : y));
    record(best);
    return landed(input, best, attempts);
  }
  record(undefined);
  const render = renderDetails(input, attempts, undefined);
  if (input.fetched) return { kind: "page", landed: input.fetched, render: { ...render, failed: true } };
  const last = tried[tried.length - 1]!;
  if (last.failure) return { kind: "failed", message: last.failure.message, render };
  return { kind: "failed", message: STILL_EMPTY_TEXT, quality: "requires_js", render };
}

function scheduleShadow(input: RenderInput, primary: Attempt): void {
  const { rendering, context } = input;
  const chromium = rendering.engines.find((e) => e.engine.name === "chromium");
  if (!chromium || primary.engine.name !== "moli" || rendering.shadowRate <= 0) return;
  if ((rendering.random ?? Math.random)() >= rendering.shadowRate) return;
  const lease = chromium.slots.tryAcquire(context.caller);
  if (!lease) return;
  context.defer(async () => {
    const own = AbortSignal.timeout((rendering.deadlineMs ?? RENDER_DEADLINE_MS) + 10_000);
    const shadow = await runAttempt({ ...input, signal: own }, chromium, 2, "shadow", undefined, lease);
    rendering.attempts.record(shadow.row);
    logAttempt(input.deps.log, shadow, "read.shadow");
  });
}
