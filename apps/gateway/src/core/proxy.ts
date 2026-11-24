// The policy gateway's HTTP surface (contract: packages/protocol/src/gateway.ts). Only Hono and Web APIs are used here,
// so this module also runs in a Worker; everything Node-specific (credential file, SQLite, CLI) is injected through
// GatewayDeps.
//
// Two apps share one state (docs/adr/0018): `internal` has every route, and `shared` has only what an outside caller
// may use (models, search, embeddings). One middleware authenticates every request and checks the route's scope.

import { classifyError } from "@rei/logging";
import type { ErrorInfo, GatewayCallRecord, GatewayCallsSummary, GatewayStatus } from "@rei/protocol";
import { PROVIDER_HEADER, READ_CALLER_HEADER, READ_ID_HEADER, STEP_ID_HEADER, UPSTREAM_HEADER } from "@rei/protocol";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { capFor, createBudgets, refusalResponse } from "./budget.ts";
import type { Caller } from "./callers.ts";
import { CallerRegistry, scopeFor } from "./callers.ts";
import { MAX_IMAGE_REQUEST_BYTES, renderCodexImage } from "./codex-images.ts";
import { embeddingHandler, embeddingTarget } from "./embedding.ts";
import { errorResponse, HttpError, readJsonObject } from "./http.ts";
import { createConnectorService } from "./mcp/connectors.ts";
import { registerMcpRoutes } from "./mcp/routes.ts";
import { classifyUpstreamError, SseMeter, usageFromJson } from "./meter.ts";
import { registerNotifyRoutes } from "./notify/routes.ts";
import { redactingLogger } from "./redact.ts";
import type { Freshness, SearchQuery } from "./search/service.ts";
import { createSearchService } from "./search/service.ts";
import type { GatewayDeps } from "./types.ts";
import { TokenError } from "./types.ts";
import { checkUpstream, downstreamResponseHeaders, upstreamRequestHeaders } from "./upstream.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BODY = 64 * 1024 * 1024;
const DEFAULT_CAPPED_CALL_MAX_MS = 600_000;
const OPENAI_V1 = "https://api.openai.com/v1/";
const ERROR_BODY_CAPTURE = 8 * 1024;
const JSON_BODY_CAPTURE = 2 * 1024 * 1024;
const SEARCH_BODY_MAX = 16 * 1024;
const READ_BODY_MAX = 16 * 1024;
/** The most the reader may answer with: a page cut at 2 million characters plus its sections. */
const READ_RESPONSE_MAX = 16 * 1024 * 1024;
/** A read is cut here whatever the reader does: its own limits (fetch, queue, render) add up to less. */
const DEFAULT_READ_TIMEOUT_MS = 120_000;
const FRESHNESS: readonly Freshness[] = ["day", "week", "month", "year"];

/** Printable ASCII only and bounded: values from headers and request bodies end up in log lines. */
const clean = (value: unknown, max = 128): string | null => {
  if (typeof value !== "string") return null;
  const out = value.replace(/[^\x21-\x7e]/g, "_").slice(0, max);
  return out || null;
};

/** The app with every route: what the control plane talks to. */
export function createGatewayApp(deps: GatewayDeps): Hono {
  return createGatewayApps(deps).internal;
}

export function createGatewayApps(deps: GatewayDeps): { internal: Hono; shared: Hono } {
  const fetchFn: typeof fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? Date.now;
  const connectMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const cappedMs = deps.cappedCallMaxMs ?? DEFAULT_CAPPED_CALL_MAX_MS;
  const { redactor } = deps;
  deps.redactor.add(deps.standin);
  const startedAt = now();
  const registry = new CallerRegistry({
    reiToken: deps.standin,
    redactor,
    now,
    ...(deps.reiBudget ? { reiBudget: deps.reiBudget } : {}),
    ...(deps.secrets ? { secrets: deps.secrets } : {}),
  });
  const budgets = createBudgets({
    onRefusal: (callerId, code) => {
      try {
        deps.calls.recordRefusal(callerId, code, now());
      } catch (cause) {
        log.error("calllog.refusal_write_failed", classifyError(cause));
      }
    },
  });
  /** Who made each request; set by the authentication middleware before any guarded handler runs. */
  const authenticated = new WeakMap<Request, Caller>();
  const callerOf = (req: Request): Caller => {
    const caller = authenticated.get(req);
    if (!caller) throw new Error("no caller on a guarded route");
    return caller;
  };

  const log = redactingLogger(deps.log, redactor);
  const search = deps.search
    ? createSearchService(deps.search, { fetch: fetchFn, now, addSecret: (...secrets) => redactor.add(...secrets) })
    : null;

  function finish(record: GatewayCallRecord, method: string): void {
    // Codes only: an error's message (which can quote an upstream or a connector) is not stored (ADR 0003).
    const safe: GatewayCallRecord = { ...record, error: record.error ? { code: record.error.code } : null };
    try {
      deps.calls.insert(safe);
    } catch (cause) {
      log.error("calllog.write_failed", classifyError(cause));
    }
    // A served call is routine; a refusal is worth seeing; a limit or an upstream failure is a warning.
    const level = safe.status === 429 || safe.status >= 500 ? "warn" : safe.status >= 400 ? "info" : "debug";
    log[level]("call", {
      caller: safe.caller,
      provider: safe.provider,
      stepId: safe.stepId,
      model: safe.model,
      method,
      status: safe.status,
      firstByteMs: safe.firstByteMs,
      totalMs: safe.totalMs,
      inputTokens: safe.usage?.inputTokens,
      outputTokens: safe.usage?.outputTokens,
      cachedInputTokens: safe.usage?.cachedInputTokens,
      errorCode: safe.error?.code,
    });
  }

  /** The upstream URL for a request that names none: the provider's own base plus the path after /v1/. */
  async function deriveUpstream(providerId: string, url: URL): Promise<string | null> {
    const rest = url.pathname.slice("/v1/".length) + url.search;
    if (providerId === "openai") return OPENAI_V1 + rest;
    const connection = (await deps.providers?.list().catch(() => []))?.find((p) => p.id === providerId);
    return connection?.baseUrl ? `${connection.baseUrl.replace(/\/+$/, "")}/${rest}` : null;
  }

  /**
   * The id of the provider a header names. An id wins; otherwise the provider's name is accepted (any case, a run of
   * spaces written as `_`, as `clean` writes them) when exactly one provider has it. A name shared by several
   * providers is `ambiguous`; an unknown reference is returned unchanged and fails later as a missing upstream.
   */
  async function resolveProvider(reference: string): Promise<{ id: string; ambiguous: boolean }> {
    if (reference === "openai" || !deps.providers) return { id: reference, ambiguous: false };
    const rows = (await deps.providers.list().catch(() => [])) ?? [];
    if (rows.some((p) => p.id === reference)) return { id: reference, ambiguous: false };
    const wanted = reference.toLowerCase();
    const named = rows.filter((p) => clean(p.name, 80)?.toLowerCase() === wanted);
    if (named.length === 1 && named[0]) return { id: named[0].id, ambiguous: false };
    return { id: reference, ambiguous: named.length > 1 };
  }

  async function handleProxy(req: Request, caller: Caller): Promise<Response> {
    const startedAt = now();
    const t0 = performance.now();
    const elapsed = () => Math.round(performance.now() - t0);
    const method = req.method;
    const stepId = clean(req.headers.get(STEP_ID_HEADER));
    let model: string | null = null;
    const { id: providerId, ambiguous } = await resolveProvider(
      clean(req.headers.get(PROVIDER_HEADER), 80) ?? "openai",
    );
    const who = { caller: caller.id, provider: providerId };
    /** Frees the budget slot and stops the ceiling timer. Runs with every call record, so exactly once per call. */
    let settle = () => {};

    const fail = (status: number, code: string, message: string): Response => {
      const error = { code, message };
      settle();
      finish(
        {
          ...who,
          stepId,
          model,
          startedAt,
          firstByteMs: null,
          totalMs: elapsed(),
          status,
          usage: null,
          limit: null,
          error,
        },
        method,
      );
      return errorResponse(status, error);
    };

    if (ambiguous)
      return fail(400, "ambiguous_provider", "More than one provider has this name; send the provider's id instead.");
    const allowed = [...deps.upstreams, ...((await deps.providers?.upstreams()) ?? [])];
    const named = req.headers.get(UPSTREAM_HEADER);
    const derived = named ? null : await deriveUpstream(providerId, new URL(req.url));
    if (!named && !derived)
      return fail(
        400,
        "missing_upstream",
        `No upstream is known for this provider; send the ${UPSTREAM_HEADER} header or a connected provider id.`,
      );
    const target = checkUpstream(named ?? derived, allowed);
    if (!target) return fail(403, "upstream_not_allowed", "The requested upstream is not on the gateway allowlist.");

    const admission = budgets.admit(caller, "models", providerId);
    if (!admission.ok) {
      log.info("budget.refused", { ...who, code: admission.code });
      return refusalResponse(admission);
    }
    const ac = new AbortController();
    let abortedBy: "connect" | "idle" | "client" | "ceiling" | null = null;
    const abort = (reason: "connect" | "idle" | "client" | "ceiling") => {
      abortedBy ??= reason;
      ac.abort();
    };
    /** Set once the response is streaming: cuts the stream and writes the record without waiting for a reader. */
    let cutStream: (() => void) | null = null;
    // A call that holds a slot must give it back even when its client stops reading (nothing else would end it).
    const ceiling = admission.capped
      ? setTimeout(() => {
          abort("ceiling");
          cutStream?.();
        }, cappedMs)
      : undefined;
    settle = () => {
      clearTimeout(ceiling);
      admission.release();
    };
    const CEILING = { code: "capped_call_timeout", message: "The call ran past the limit for a capped call." };

    let body: ArrayBuffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      if (Number(req.headers.get("content-length") ?? 0) > maxBody)
        return fail(413, "body_too_large", "The request body is too large.");
      body = await req.arrayBuffer();
      if (body.byteLength > maxBody) return fail(413, "body_too_large", "The request body is too large.");
      if (body.byteLength > 0 && body.byteLength < 32 * 1024 * 1024) {
        try {
          const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
          if (typeof parsed === "object" && parsed !== null) model = clean((parsed as { model?: unknown }).model);
        } catch {
          // not JSON; the model stays unknown
        }
      }
    }

    let bearer: string;
    try {
      bearer =
        deps.providers && providerId !== "openai"
          ? await deps.providers.token(providerId)
          : await deps.tokens.accessToken();
    } catch (cause) {
      if (cause instanceof TokenError) {
        log.warn("credential.unavailable", { providerId, errorCode: cause.code });
        return cause.code === "not_signed_in"
          ? fail(503, "not_signed_in", "Connect a model provider in Rei Settings → Providers.")
          : fail(502, cause.code, "The gateway could not obtain a valid credential for the upstream.");
      }
      log.warn("credential.unavailable", { providerId, ...classifyError(cause) });
      return fail(502, "credential_error", "The gateway could not obtain a valid credential for the upstream.");
    }
    redactor.add(bearer);

    const onClientAbort = () => abort("client");
    req.signal.addEventListener("abort", onClientAbort, { once: true });
    const detach = () => req.signal.removeEventListener("abort", onClientAbort);

    const connectTimer = setTimeout(() => abort("connect"), connectMs);
    let up: Response;
    try {
      up = await fetchFn(target, {
        method,
        headers: upstreamRequestHeaders(req.headers, bearer),
        ...(body ? { body } : {}),
        signal: ac.signal,
        redirect: "manual",
      });
    } catch (cause) {
      clearTimeout(connectTimer);
      detach();
      if (abortedBy === "ceiling") return fail(504, CEILING.code, CEILING.message);
      if (abortedBy === "connect") return fail(504, "upstream_timeout", "The upstream did not answer in time.");
      if (abortedBy === "client") return fail(499, "client_aborted", "The client closed the request.");
      const code =
        cause instanceof Error && cause.cause && typeof cause.cause === "object" && "code" in cause.cause
          ? String((cause.cause as { code: unknown }).code)
          : "fetch_failed";
      log.warn("upstream.unreachable", { stepId, errorCode: code });
      return fail(502, "upstream_unreachable", "The gateway could not reach the upstream.");
    }
    clearTimeout(connectTimer);

    const headers = downstreamResponseHeaders(up.headers, redactor.redact);
    const status = up.status;
    const contentType = up.headers.get("content-type") ?? "";
    const wantsText = status >= 400;
    const sse = new SseMeter();
    let mode: "sse" | "json" | "other" | null = contentType.includes("text/event-stream")
      ? "sse"
      : contentType
        ? contentType.includes("json")
          ? "json"
          : "other"
        : null;
    const captured: Uint8Array[] = [];
    let capturedBytes = 0;
    let firstByteMs: number | null = null;
    let done = false;
    let streamError: ErrorInfo | null = null;

    const finalize = () => {
      if (done) return;
      done = true;
      detach();
      settle();
      sse.end();
      const total = elapsed();
      const text = () => new TextDecoder().decode(concat(captured, capturedBytes));
      let usage: GatewayCallRecord["usage"] = null;
      let limit: GatewayCallRecord["limit"] = null;
      let error: ErrorInfo | null = null;
      if (wantsText) {
        ({ error, limit } = classifyUpstreamError(status, text(), up.headers, now()));
      } else if (mode === "sse") {
        usage = sse.outcome.usage;
        error = sse.outcome.error;
        if (!error && !sse.outcome.sawTerminal && !streamError)
          error = { code: "stream_truncated", message: "The upstream stream ended without a final event." };
      } else if (mode === "json") {
        usage = usageFromJson(text());
      }
      error = streamError ?? error;
      finish(
        {
          ...who,
          stepId,
          model,
          startedAt,
          firstByteMs: firstByteMs ?? (up.body ? null : total),
          totalMs: total,
          status,
          usage,
          limit,
          error,
        },
        method,
      );
    };

    const observe = (chunk: Uint8Array) => {
      if (firstByteMs === null) {
        firstByteMs = elapsed();
        if (mode === null)
          mode = /^\s*(event:|data:)/.test(new TextDecoder().decode(chunk.subarray(0, 16)))
            ? "sse"
            : chunk[0] === 0x7b
              ? "json"
              : "other";
      }
      if (mode === "sse" && !wantsText) sse.feed(chunk);
      const cap = wantsText ? ERROR_BODY_CAPTURE : mode === "json" ? JSON_BODY_CAPTURE : 0;
      if (capturedBytes < cap) {
        const part = chunk.subarray(0, cap - capturedBytes);
        captured.push(part.slice());
        capturedBytes += part.length;
      }
    };

    if (!up.body || status === 204 || status === 205 || status === 304) {
      finalize();
      return new Response(null, { status, headers });
    }

    const reader = up.body.getReader();
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          cutStream = () => {
            if (done) return;
            streamError = CEILING;
            controller.error(new Error(CEILING.code));
            reader.cancel().catch(() => {});
            finalize();
          };
        },
        async pull(controller) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const idle = new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                abort("idle");
                reject(new Error("idle"));
              }, idleMs);
            });
            const next = await Promise.race([reader.read(), idle]);
            if (next.done) {
              controller.close();
              finalize();
              return;
            }
            observe(next.value);
            controller.enqueue(next.value);
          } catch {
            if (done) return;
            streamError =
              abortedBy === "idle"
                ? { code: "upstream_idle_timeout", message: "The upstream stopped sending data." }
                : abortedBy === "client"
                  ? { code: "client_aborted", message: "The client closed the request." }
                  : { code: "upstream_stream_error", message: "The upstream connection broke mid-stream." };
            controller.error(new Error(streamError.code));
            finalize();
          } finally {
            clearTimeout(timer);
          }
        },
        cancel() {
          abort("client");
          streamError = { code: "client_aborted", message: "The client closed the request." };
          reader.cancel().catch(() => {});
          finalize();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(stream, { status, headers });
  }

  /** The query text is never logged or stored: a call-log row only says which provider answered, how fast and how it ended. */
  async function handleSearch(req: Request, caller: Caller): Promise<Response> {
    const startedAt = now();
    const t0 = performance.now();
    const stepId = clean(req.headers.get(STEP_ID_HEADER));
    const who = { caller: caller.id, provider: "search" };
    const bad = (message: string) => errorResponse(400, { code: "bad_request", message });

    if (Number(req.headers.get("content-length") ?? 0) > SEARCH_BODY_MAX) return bad("The request body is too large.");
    const text = await req.text();
    if (text.length > SEARCH_BODY_MAX) return bad("The request body is too large.");
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return bad("The body must be a JSON object.");
    }
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (query.length < 1 || query.length > 400) return bad("query must be a string of 1 to 400 characters.");
    const count = body.count ?? 5;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 10)
      return bad("count must be an integer from 1 to 10.");
    const freshness = body.freshness ?? undefined;
    if (freshness !== undefined && !FRESHNESS.includes(freshness as Freshness))
      return bad("freshness must be day, week, month or year.");
    if (!search)
      return errorResponse(503, {
        code: "search_unavailable",
        message: "Web search is not configured on the gateway.",
      });

    const q: SearchQuery = { query, count, freshness: freshness as Freshness | undefined };
    const admission = budgets.admit(caller, "search");
    if (!admission.ok) {
      log.info("budget.refused", { ...who, code: admission.code });
      return refusalResponse(admission);
    }
    let outcome: Awaited<ReturnType<typeof search.run>>;
    try {
      // Subscription search spends the same subscription as model calls, so a caller barred from it skips it here too.
      outcome = await search.run(q, req.signal, {
        exclude: capFor(caller, "models", "openai") === 0 ? ["codex-subscription"] : [],
      });
    } finally {
      admission.release();
    }
    let offset = 0;
    for (const a of outcome.attempts) {
      // Codes only: no query, no key, no provider message.
      log[a.error ? "info" : "debug"]("search.attempt", {
        caller: caller.id,
        stepId,
        provider: a.provider,
        results: a.results,
        errorCode: a.error?.code,
        reason: a.error?.reason,
      });
      finish(
        {
          ...who,
          stepId,
          model: `search:${a.provider}`,
          startedAt: startedAt + offset,
          firstByteMs: null,
          totalMs: a.totalMs,
          status: a.status,
          usage: a.usage ?? null,
          limit: null,
          error: a.error,
        },
        "POST",
      );
      offset += a.totalMs;
    }
    if (outcome.ok)
      return new Response(
        JSON.stringify({
          provider: outcome.provider,
          results: outcome.results,
          ...(outcome.answer ? { answer: outcome.answer } : {}),
          attempts: outcome.trace,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    const error = { code: outcome.code, message: outcome.message };
    if (outcome.attempts.length === 0)
      finish(
        {
          ...who,
          stepId,
          model: "search",
          startedAt,
          firstByteMs: null,
          totalMs: Math.round(performance.now() - t0),
          status: outcome.status,
          usage: null,
          limit: null,
          error,
        },
        "POST",
      );
    return new Response(JSON.stringify({ error, attempts: outcome.trace }), {
      status: outcome.status,
      headers: {
        "content-type": "application/json",
        ...(outcome.retryAfterS ? { "retry-after": String(outcome.retryAfterS) } : {}),
      },
    });
  }

  /**
   * POST /read: one read of one page, done by the shared reader. The gateway checks the token, the `read` scope, the
   * caller's budget and (for a read that may reach the local network) the `read-local` scope, records the call, and hands
   * the body to the reader with the caller's id and its own id for the call. The reader holds no secrets and trusts both
   * headers because only the gateway can reach it. The URL is not logged or stored here: the reader keeps it (decision 7).
   */
  async function handleRead(req: Request, caller: Caller): Promise<Response> {
    const startedAt = now();
    const t0 = performance.now();
    const stepId = clean(req.headers.get(STEP_ID_HEADER));
    const who = { caller: caller.id, provider: "read" };
    const bad = (message: string) => errorResponse(400, { code: "bad_request", message });
    if (Number(req.headers.get("content-length") ?? 0) > READ_BODY_MAX) return bad("The request body is too large.");
    const text = await req.text();
    if (text.length > READ_BODY_MAX) return bad("The request body is too large.");
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return bad("The body must be a JSON object.");
    }
    // A read that may reach the user's local network needs the scope; anything but "none" asks for it.
    if (body.localNetworks !== undefined && body.localNetworks !== "none" && !caller.scopes.includes("read-local")) {
      log.info("auth.route_not_allowed", { path: "/read", caller: caller.id, reason: "local_networks" });
      return errorResponse(403, {
        code: "route_not_allowed",
        message:
          'This caller may not read local-network pages: send localNetworks "none", or ask for the read-local scope.',
      });
    }
    if (!deps.reader)
      return errorResponse(503, {
        code: "read_unavailable",
        message: "Page reading is not configured on the gateway.",
      });
    const admission = budgets.admit(caller, "read");
    if (!admission.ok) {
      log.info("budget.refused", { ...who, code: admission.code });
      return refusalResponse(admission);
    }
    const readId = crypto.randomUUID();
    let status = 502;
    let payload: string | undefined;
    let headers: Record<string, string> = { "content-type": "application/json" };
    try {
      const upstream = await fetchFn(`${deps.reader.url}/read`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [READ_CALLER_HEADER]: caller.id,
          [READ_ID_HEADER]: readId,
          ...(stepId ? { [STEP_ID_HEADER]: stepId } : {}),
        },
        body: text,
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(deps.reader.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS)]),
      });
      const buffer = await upstream.text();
      if (buffer.length <= READ_RESPONSE_MAX && /json/i.test(upstream.headers.get("content-type") ?? "")) {
        status = upstream.status;
        payload = buffer;
        const retryAfter = upstream.headers.get("retry-after");
        if (retryAfter) headers = { ...headers, "retry-after": retryAfter };
      }
    } catch (cause) {
      log.warn("read.upstream_failed", { ...who, stepId, ...classifyError(cause) });
    } finally {
      admission.release();
    }
    const totalMs = Math.round(performance.now() - t0);
    const error = status >= 400 ? { code: status === 502 && !payload ? "read_unavailable" : `http_${status}` } : null;
    finish(
      {
        ...who,
        stepId,
        model: "read",
        startedAt,
        firstByteMs: totalMs,
        totalMs,
        status,
        usage: null,
        limit: null,
        error,
      },
      "POST",
    );
    if (!payload) return errorResponse(502, { code: "read_unavailable", message: "The page reader did not answer." });
    return new Response(payload, { status, headers: { ...headers, "x-rei-read-id": readId } });
  }

  const bearerOf = (c: Context): string => {
    const header = c.req.header("authorization") ?? "";
    return /^Bearer /i.test(header) ? header.slice(7).trim() : "";
  };
  const notFound = () => errorResponse(404, { code: "not_found", message: "Not found." });

  /**
   * The one guard. The scope comes from the path the router itself matches on, and a path that is not listed needs
   * `admin`, so a route added later is closed until it is given a scope. On the shared app nothing outside the three
   * outside scopes exists at all, whoever asks.
   */
  const guard =
    (kind: "internal" | "shared"): MiddlewareHandler =>
    async (c, next) => {
      const path = c.req.path;
      const needed = scopeFor(path);
      if (kind === "shared" && (needed === "admin" || (needed === "open" && path !== "/healthz"))) return notFound();
      if (needed === "open") return next();
      const presented = bearerOf(c);
      const caller = presented ? await registry.authenticate(presented) : null;
      if (!caller) {
        log.info("auth.bad_token", { method: c.req.method, path: clean(path) ?? "" });
        return errorResponse(401, { code: "bad_token", message: "Missing or wrong gateway token." });
      }
      if (!caller.scopes.includes(needed)) {
        log.info("auth.route_not_allowed", { method: c.req.method, path: clean(path) ?? "", caller: caller.id });
        return errorResponse(403, { code: "route_not_allowed", message: "This caller may not use this route." });
      }
      authenticated.set(c.req.raw, caller);
      await next();
    };

  const connectors = deps.secrets
    ? createConnectorService({
        secrets: deps.secrets,
        fetch: fetchFn,
        now,
        redactor,
        log,
        calls: deps.calls,
        version: deps.version,
        devHosts: (deps.mcp?.devHosts ?? []).map((h) => h.toLowerCase()),
        ...(deps.mcp?.callTimeoutMs ? { callTimeoutMs: deps.mcp.callTimeoutMs } : {}),
      })
    : null;

  const finalize = (app: Hono): Hono => {
    app.notFound(notFound);
    app.onError((cause) => {
      if (cause instanceof HttpError) return errorResponse(cause.status, { code: cause.code, message: cause.message });
      log.error("http.internal_error", classifyError(cause));
      return errorResponse(500, { code: "internal_error", message: "The gateway hit an internal error." });
    });
    return app;
  };

  /** What an outside caller may use. Mounted on both apps with the same handlers, so they share every counter. */
  const mountShared = (app: Hono): void => {
    app.post("/search", (c) => handleSearch(c.req.raw, callerOf(c.req.raw)));
    app.post("/read", (c) => handleRead(c.req.raw, callerOf(c.req.raw)));
    app.all("/embedding/*", (c) => handleEmbedding(c.req.raw, callerOf(c.req.raw)));
    app.all("/v1/*", (c) => handleProxy(c.req.raw, callerOf(c.req.raw)));
  };

  async function handleEmbedding(req: Request, caller: Caller): Promise<Response> {
    const saved = await deps.secrets?.read<import("@rei/protocol").SaveEmbeddingSetupSettings>("setup-embedding");
    const route = saved
      ? saved.provider === "off"
        ? undefined
        : {
            baseUrl: saved.baseUrl,
            apiModel: saved.apiModel,
            key: async () => saved.apiKey ?? "",
          }
      : deps.embedding;
    if (!route) return errorResponse(503, { code: "embedding_off", message: "Embeddings are off." });
    const who = { caller: caller.id, provider: "embedding" };
    const admission = budgets.admit(caller, "embeddings");
    if (!admission.ok) {
      log.info("budget.refused", { ...who, code: admission.code });
      return refusalResponse(admission);
    }
    const callStarted = now();
    const t0 = performance.now();
    let promptTokens: number | null = null;
    let response: Response;
    try {
      response = await embeddingHandler(
        route,
        fetchFn,
        (reason) => log.warn("embedding.upstream_failed", { ...reason }),
        (tokens) => {
          promptTokens = tokens;
        },
      )(req);
    } finally {
      admission.release();
    }
    const totalMs = Math.round(performance.now() - t0);
    finish(
      {
        ...who,
        stepId: clean(req.headers.get(STEP_ID_HEADER)),
        model: clean(route.apiModel),
        startedAt: callStarted,
        firstByteMs: totalMs,
        totalMs,
        status: response.status,
        usage: promptTokens === null ? null : { inputTokens: promptTokens, outputTokens: 0, cachedInputTokens: 0 },
        limit: null,
        error: response.ok ? null : { code: `http_${response.status}` },
      },
      req.method,
    );
    return response;
  }

  const shared = new Hono();
  shared.get("/healthz", (c) => c.text("ok"));
  shared.use("*", guard("shared"));
  mountShared(shared);
  finalize(shared);

  const app = new Hono();
  app.get("/healthz", (c) => c.text("ok"));
  app.use("*", guard("internal"));
  const images = deps.codexImages;
  if (images) {
    app.post("/codex-images", bodyLimit({ maxSize: MAX_IMAGE_REQUEST_BYTES }), (c) =>
      renderCodexImage(c.req.raw, images),
    );
  }
  const codexSetup = deps.codexImagesSetup;
  app.get("/setup/codex-images", async (c) =>
    c.json(codexSetup ? await codexSetup.status() : { enabled: false, signedIn: false, pending: false }),
  );
  if (codexSetup) {
    app.post("/setup/codex-images/signin", async (c) => {
      try {
        return c.json(await codexSetup.start());
      } catch (error) {
        return errorResponse(409, {
          code: "codex_signin_failed",
          message: error instanceof Error ? error.message : "Codex Images sign-in could not start.",
        });
      }
    });
    app.delete("/setup/codex-images/signin", (c) => {
      codexSetup.cancel();
      return c.body(null, 204);
    });
    app.delete("/setup/codex-images", async (c) => {
      await codexSetup.signOut();
      return c.body(null, 204);
    });
  }
  // Admin only (the scope of every unlisted path): the state a backup needs and nothing else can read.
  app.get("/backup", async (c) => {
    if (!deps.backup)
      return errorResponse(503, { code: "backup_unavailable", message: "Backups are not configured on the gateway." });
    try {
      return c.json(await deps.backup());
    } catch (cause) {
      log.error("backup.failed", classifyError(cause));
      return errorResponse(500, { code: "backup_failed", message: "The gateway could not read its state." });
    }
  });
  app.get("/status", async (c) => {
    const state = await deps.tokens.status().catch(() => ({ signedIn: false, accessExpiresInS: null }));
    const searchStatus = { providers: (await search?.status()) ?? [], searxngUrl: deps.search?.searxngUrl ?? null };
    const connected = deps.providers
      ? (await deps.providers.list().catch(() => []))
          .filter((p) => p.connected)
          .map(({ id, name, kind }) => ({ id, name, kind }))
      : [];
    const status: GatewayStatus = {
      ...state,
      models: deps.models(),
      version: deps.version,
      search: searchStatus,
      providers: connected,
    };
    return c.json(status);
  });
  app.get("/setup/search", async (c) => {
    if (!deps.setupSearch)
      return c.json({ error: { code: "unavailable", message: "Search settings unavailable." } }, 503);
    return c.json({ ...(await deps.setupSearch.read()), providerStatus: (await search?.status(true)) ?? [] });
  });
  app.post("/setup/search", async (c) => {
    if (!deps.setupSearch)
      return c.json({ error: { code: "unavailable", message: "Search settings unavailable." } }, 503);
    const body = await readJsonObject(c.req.raw);
    const ids = ["brave", "tavily", "searxng", "exa", "codex-subscription"];
    if (
      !Array.isArray(body.providers) ||
      body.providers.some((id) => !ids.includes(String(id))) ||
      new Set(body.providers).size !== body.providers.length ||
      typeof body.searxngUrl !== "string"
    )
      return c.json({ error: { code: "bad_request", message: "Choose valid search providers." } }, 400);
    if (
      body.providerOrder !== undefined &&
      (!Array.isArray(body.providerOrder) ||
        body.providerOrder.length !== ids.length ||
        new Set(body.providerOrder).size !== ids.length ||
        body.providerOrder.some((id) => !ids.includes(String(id))))
    )
      return c.json(
        { error: { code: "bad_request", message: "Include every search provider exactly once in the order." } },
        400,
      );
    if (body.searxngUrl) {
      try {
        const url = new URL(body.searxngUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
          throw new Error();
      } catch {
        return c.json(
          {
            error: {
              code: "bad_request",
              message: "Enter an HTTP(S) SearXNG URL without credentials, query or fragment.",
            },
          },
          400,
        );
      }
    }
    if (body.exaAuth !== undefined && body.exaAuth !== "keyless" && body.exaAuth !== "api_key")
      return c.json({ error: { code: "bad_request", message: "Choose a valid Exa authentication mode." } }, 400);
    if (
      body.codexModel !== undefined &&
      (typeof body.codexModel !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(body.codexModel.trim()))
    )
      return c.json({ error: { code: "bad_request", message: "Enter a valid search model ID." } }, 400);
    const apiKeys: Record<string, string> = {};
    if (body.apiKeys !== undefined) {
      if (!body.apiKeys || typeof body.apiKeys !== "object" || Array.isArray(body.apiKeys))
        return c.json({ error: { code: "bad_request", message: "Invalid search credentials." } }, 400);
      for (const [id, key] of Object.entries(body.apiKeys)) {
        if (
          !ids.includes(id) ||
          id === "codex-subscription" ||
          typeof key !== "string" ||
          (key && !(id === "searxng" ? /^[\x20-\x7e]{3,512}$/ : /^[\x21-\x7e]{8,512}$/).test(key))
        )
          return c.json({ error: { code: "bad_request", message: "Invalid search credential." } }, 400);
        if (key) {
          apiKeys[id] = key;
          redactor.add(key);
        }
      }
    }
    const savedSearch = await deps.setupSearch.save({
      providers: body.providers as import("@rei/protocol").SearchSetupSettings["providers"],
      searxngUrl: body.searxngUrl,
      exaAuth: body.exaAuth === "api_key" ? "api_key" : "keyless",
      apiKeys,
      ...(typeof body.codexModel === "string" ? { codexModel: body.codexModel.trim() } : {}),
      ...(Array.isArray(body.providerOrder)
        ? { providerOrder: body.providerOrder as import("@rei/protocol").SearchProviderId[] }
        : {}),
    });
    return c.json({ ...savedSearch, providerStatus: (await search?.status(true)) ?? [] });
  });
  if (deps.providers) {
    app.get("/providers", async (c) => c.json({ connections: await deps.providers!.list() }));
    app.post("/providers/openai/oauth/start", async (c) => {
      try {
        return c.json(await deps.providers!.startOpenAiOAuth());
      } catch (error) {
        return errorResponse(409, {
          code: "oauth_start_failed",
          message: error instanceof Error ? error.message : "OpenAI sign-in could not start.",
        });
      }
    });
    app.get("/providers/openai/oauth/status", (c) => c.json(deps.providers!.openAiOAuthStatus()));
    app.post("/providers/openai/oauth/callback", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { url?: unknown };
      if (typeof body.url !== "string")
        return errorResponse(400, { code: "bad_callback", message: "Paste the full redirect URL." });
      try {
        await deps.providers!.submitOpenAiOAuthCallback(body.url);
        return c.json({ ok: true });
      } catch (error) {
        return errorResponse(400, {
          code: "bad_callback",
          message: error instanceof Error ? error.message : "Callback could not be submitted.",
        });
      }
    });
    app.delete("/providers/openai/oauth", (c) => {
      deps.providers!.cancelOpenAiOAuth();
      return c.body(null, 204);
    });
    app.post("/providers/scan", async (c) => {
      const body = await c.req.json();
      if (typeof body.baseUrl !== "string")
        return c.json({ error: { code: "bad_request", message: "Enter a base URL." } }, 400);
      try {
        return c.json(
          await deps.providers!.scanModels({
            baseUrl: body.baseUrl,
            ...(typeof body.id === "string" ? { id: body.id } : {}),
            ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
          }),
        );
      } catch (error) {
        return c.json(
          {
            error: {
              code: "model_scan_failed",
              message: error instanceof Error ? error.message : "Model scan failed.",
            },
          },
          400,
        );
      }
    });
    app.post("/providers", async (c) => {
      const body = await c.req.json();
      try {
        return c.json(await deps.providers!.save(body), 201);
      } catch (error) {
        return errorResponse(400, {
          code: "bad_provider",
          message: error instanceof Error ? error.message : "Provider settings are invalid.",
        });
      }
    });
    app.delete("/providers/:id", async (c) => {
      await deps.providers!.remove(c.req.param("id"));
      return c.body(null, 204);
    });
  }
  app.get("/calls", (c) => {
    const stepId = c.req.query("stepId");
    if (stepId) return c.json(deps.calls.byStep(stepId, callerOf(c.req.raw).id));
    const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
    return c.json(deps.calls.recent(limit, clean(c.req.query("caller"), 40) ?? undefined));
  });
  app.get("/calls/summary", (c) => {
    const asked = Number(c.req.query("since"));
    const since = Number.isFinite(asked) && asked > 0 ? asked : now() - 24 * 3_600_000;
    const summary: GatewayCallsSummary = {
      since,
      rows: deps.calls.summary(since),
      refusals: budgets.snapshot().refusals,
      refusalsSince: startedAt,
    };
    return c.json(summary);
  });
  app.get("/usage", (c) => {
    const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const parseDay = (raw: string | undefined, fallback: string, name: string): string | Response => {
      if (raw === undefined || raw === "") return fallback;
      const ms = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(`${raw}T00:00:00Z`) : Number.NaN;
      if (!Number.isFinite(ms) || dayStr(ms) !== raw)
        return errorResponse(400, { code: "bad_request", message: `${name} must be a date as YYYY-MM-DD.` });
      return raw;
    };
    const today = dayStr(now());
    const trackingDay = deps.calls.trackingSince().slice(0, 10);
    let defaultFrom = trackingDay;
    if (defaultFrom > today) defaultFrom = today;
    const from = parseDay(c.req.query("from"), defaultFrom, "from");
    if (from instanceof Response) return from;
    const to = parseDay(c.req.query("to"), today, "to");
    if (to instanceof Response) return to;
    if (from > to) return errorResponse(400, { code: "bad_request", message: "from must be on or before to." });
    const caller = clean(c.req.query("caller"), 40) ?? undefined;
    return c.json(deps.calls.usage(from, to, caller));
  });
  app.get("/callers", async (c) => c.json({ callers: await registry.list(deps.calls.lastUsed()) }));
  app.post("/callers", async (c) => {
    const created = await registry.create(await readJsonObject(c.req.raw));
    log.info("callers.created", { caller: created.caller.id });
    return c.json(created, 201);
  });
  app.patch("/callers/:id", async (c) => {
    const caller = await registry.patch(c.req.param("id"), await readJsonObject(c.req.raw));
    log.info("callers.changed", { caller: caller.id });
    return c.json({ caller });
  });
  app.post("/callers/:id/rotate", async (c) => {
    const body = await readJsonObject(c.req.raw);
    const rotated = await registry.rotate(c.req.param("id"), body.graceSeconds);
    log.info("callers.rotated", { caller: rotated.caller.id });
    return c.json(rotated);
  });
  app.post("/callers/:id/revoke", async (c) => {
    const caller = await registry.revoke(c.req.param("id"));
    log.info("callers.revoked", { caller: caller.id });
    return c.json({ caller });
  });
  mountShared(app);
  app.post("/setup/embedding/detect", async (c) => {
    const body = await readJsonObject(c.req.raw);
    if (
      typeof body.baseUrl !== "string" ||
      typeof body.apiModel !== "string" ||
      !body.apiModel.trim() ||
      (body.apiKey !== undefined && (typeof body.apiKey !== "string" || /[\r\n\0]/.test(body.apiKey)))
    )
      return c.json({ error: { code: "bad_request", message: "Enter a valid URL, key and model ID." } }, 400);
    let stage = "setup";
    // Each refusal names one cause the person can act on. Upstream bodies and key values never appear in these texts.
    const refuse = (message: string) => c.json({ error: { code: "embedding_failed", message } }, 400);
    try {
      const base = embeddingTarget(body.baseUrl);
      const saved = await deps.secrets?.read<import("@rei/protocol").SaveEmbeddingSetupSettings>("setup-embedding");
      // A typed key wins; otherwise the key saved for this same endpoint. No key is read from any file.
      let key = typeof body.apiKey === "string" ? body.apiKey : "";
      if (!key && saved?.baseUrl && embeddingTarget(saved.baseUrl) === base) key = saved.apiKey ?? "";
      if (key) redactor.add(key);
      stage = "probe";
      const response = await embeddingHandler(
        { baseUrl: base, apiModel: body.apiModel, key: async () => key || "" },
        fetchFn,
        (reason) => log.warn("embedding.detect_upstream_failed", { ...reason }),
      )(
        new Request("http://gateway/embedding/v1/embeddings", {
          method: "POST",
          body: JSON.stringify({ model: body.apiModel, input: ["embedding health check"], encoding_format: "float" }),
          signal: c.req.raw.signal,
        }),
      );
      if (!response.ok) {
        const status = response.status;
        if (status === 401 || status === 403)
          return refuse(
            `oMLX rejected this API key (HTTP ${status}). Enter the oMLX inference key, not the admin key, and test again.`,
          );
        if (status === 404)
          return refuse("This URL does not serve the embeddings API (HTTP 404). Check the port oMLX serves on.");
        // oMLX answers 507 when the model does not fit its memory ceiling: a RAM problem, not a key or URL problem.
        if (status === 507)
          return refuse(
            "oMLX does not have enough free memory to load the embedding model (HTTP 507). Close other apps to free RAM, then test again.",
          );
        return refuse(
          `The endpoint could not produce an embedding (HTTP ${status}). Check that oMLX is running, the URL and the model ID.`,
        );
      }
      stage = "validate";
      const result = (await response.json()) as { model?: unknown; data?: { index?: unknown; embedding?: unknown }[] };
      const vector = result.data?.[0]?.embedding;
      // A different served name is the usual cause of a failed test with a correct key: say so, without a vector error.
      if (result.model !== undefined && result.model !== body.apiModel) {
        log.warn("embedding.detect_model_mismatch", {
          requested: body.apiModel.slice(0, 120),
          served: String(result.model).slice(0, 120),
        });
        return refuse(
          `oMLX serves this model as "${String(result.model).slice(0, 80)}", not "${body.apiModel.slice(0, 80)}". Enter the name oMLX lists and test again.`,
        );
      }
      if (
        result.data?.length !== 1 ||
        result.data[0]?.index !== 0 ||
        !Array.isArray(vector) ||
        vector.length < 1 ||
        vector.length > 65536 ||
        !vector.every((n) => typeof n === "number" && Number.isFinite(n)) ||
        !vector.some((n) => n !== 0)
      )
        return refuse("The endpoint answered without one valid embedding vector. Check the model ID and URL.");
      return c.json({ dims: vector.length });
    } catch (error) {
      // Stage and error name only; the detail was logged above or is a fixed message from this code.
      log.warn("embedding.detect_rejected", {
        stage,
        errorClass: error instanceof Error ? error.name : "unknown",
      });
      return c.json(
        { error: { code: "embedding_failed", message: "Connection test failed. Check the URL, key and model ID." } },
        400,
      );
    }
  });
  app.get("/setup/embedding", async (c) => {
    const saved = await deps.secrets?.read<import("@rei/protocol").SaveEmbeddingSetupSettings>("setup-embedding");
    if (!saved)
      return c.json(
        deps.embedding
          ? { provider: "openai", baseUrl: deps.embedding.baseUrl, apiModel: deps.embedding.apiModel, profile: null }
          : null,
      );
    const { apiKey: _key, ...settings } = saved;
    return c.json(settings);
  });
  app.post("/setup/embedding", async (c) => {
    if (!deps.secrets)
      return c.json({ error: { code: "unavailable", message: "Embedding settings unavailable." } }, 503);
    const body = await readJsonObject(c.req.raw);
    if (
      !["off", "omlx", "openai"].includes(String(body.provider)) ||
      typeof body.baseUrl !== "string" ||
      typeof body.apiModel !== "string"
    )
      return c.json({ error: { code: "bad_request", message: "Invalid embedding settings." } }, 400);
    try {
      if (body.provider !== "off") embeddingTarget(body.baseUrl);
    } catch {
      return c.json(
        { error: { code: "bad_request", message: "Enter an HTTP(S) origin, optionally ending in /v1." } },
        400,
      );
    }
    if (body.apiKey !== undefined && (typeof body.apiKey !== "string" || /[\r\n\0]/.test(body.apiKey)))
      return c.json({ error: { code: "bad_request", message: "Invalid embedding key." } }, 400);
    if (typeof body.apiKey === "string" && body.apiKey) redactor.add(body.apiKey);
    if (body.provider !== "off" && (!body.apiModel.trim() || /[\r\n\0]/.test(body.apiModel)))
      return c.json({ error: { code: "bad_request", message: "Enter an embedding model ID." } }, 400);
    const input: import("@rei/protocol").SaveEmbeddingSetupSettings = {
      provider: body.provider as "off" | "omlx" | "openai",
      baseUrl: body.baseUrl,
      apiModel: body.apiModel,
      profile: body.profile as import("@rei/protocol").EmbeddingSetupSettings["profile"],
      ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
    };
    await deps.secrets.modify<import("@rei/protocol").SaveEmbeddingSetupSettings>("setup-embedding", (current) => ({
      ...input,
      apiKey: input.apiKey || (current?.baseUrl === input.baseUrl ? current.apiKey : undefined),
    }));
    const { apiKey: _key, ...settings } = input;
    return c.json(settings);
  });
  registerMcpRoutes(app, connectors);
  if (deps.secrets)
    registerNotifyRoutes(app, {
      secrets: deps.secrets,
      fetch: fetchFn,
      now,
      log,
      redactor,
      ...(deps.fcm ? { fcm: deps.fcm } : {}),
      ...(deps.vapidSubject ? { vapidSubject: deps.vapidSubject } : {}),
      ...(deps.pushEncrypt ? { encrypt: deps.pushEncrypt } : {}),
    });
  else
    app.all("/notify/*", () =>
      errorResponse(503, { code: "notify_unavailable", message: "Notifications are not configured on the gateway." }),
    );
  return { internal: finalize(app), shared };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
