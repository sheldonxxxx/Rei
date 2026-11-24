// Reads what a response says about itself (usage, failure, limits) without altering it.
import type { ErrorInfo, GatewayCallRecord } from "@rei/protocol";

type Usage = NonNullable<GatewayCallRecord["usage"]>;
type Limit = NonNullable<GatewayCallRecord["limit"]>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
/** A short identifier that is safe to put in a message (never free text from upstream). */
const safeId = (v: unknown): string | undefined =>
  typeof v === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : undefined;

/** OpenAI Responses usage (input_tokens/output_tokens) or chat-completions style (prompt_tokens/completion_tokens). */
export function parseUsage(value: unknown): Usage | null {
  if (!isRecord(value)) return null;
  const input = num(value.input_tokens) ?? num(value.prompt_tokens);
  const output = num(value.output_tokens) ?? num(value.completion_tokens);
  if (input === undefined && output === undefined) return null;
  const details = isRecord(value.input_tokens_details)
    ? value.input_tokens_details
    : isRecord(value.prompt_tokens_details)
      ? value.prompt_tokens_details
      : {};
  return { inputTokens: input ?? 0, outputTokens: output ?? 0, cachedInputTokens: num(details.cached_tokens) ?? 0 };
}

export interface StreamOutcome {
  usage: Usage | null;
  /** Set when the stream reported a failed response or an error event. */
  error: ErrorInfo | null;
  /** True once a Responses terminal event, Chat Completions finish, or [DONE] went by. */
  sawTerminal: boolean;
}

/**
 * Incremental SSE reader. Only the lines that can carry a terminal event are JSON-parsed; the bytes themselves are
 * never touched (the caller forwards them separately).
 */
export class SseMeter {
  readonly outcome: StreamOutcome = { usage: null, error: null, sawTerminal: false };
  #buf = "";
  #decoder = new TextDecoder();

  feed(chunk: Uint8Array): void {
    this.#buf += this.#decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      this.#line(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    if (this.#buf.length > 4_000_000) this.#buf = ""; // a single enormous line cannot be a terminal event
  }

  end(): void {
    if (this.#buf) this.#line(this.#buf);
    this.#buf = "";
  }

  #line(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      this.outcome.sawTerminal = true;
      return;
    }
    if (
      !/"(?:choices|error)"\s*:/.test(data) &&
      !/"type"\s*:\s*"(response\.completed|response\.incomplete|response\.failed|error)"/.test(data)
    )
      return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    const type = str(event.type);
    const error = isRecord(event.error) ? event.error : type === "error" ? event : undefined;
    if (error) {
      this.outcome.sawTerminal = true;
      const code = safeId(error.code);
      this.outcome.error = {
        code: code ?? "stream_error",
        message: `The upstream stream reported an error${code ? ` (${code})` : ""}.`,
      };
      return;
    }
    if (Array.isArray(event.choices)) {
      this.outcome.usage = parseUsage(event.usage) ?? this.outcome.usage;
      for (const choice of event.choices) {
        if (!isRecord(choice) || typeof choice.finish_reason !== "string") continue;
        this.outcome.sawTerminal = true;
        if (choice.finish_reason === "content_filter") {
          this.outcome.error = { code: "content_filter", message: "The upstream content filter stopped the response." };
        } else if (choice.finish_reason === "network_error") {
          this.outcome.error = { code: "network_error", message: "The upstream stream was interrupted." };
        }
      }
      return;
    }
    if (type !== "response.completed" && type !== "response.incomplete" && type !== "response.failed") return;
    this.outcome.sawTerminal = true;
    const response = isRecord(event.response) ? event.response : {};
    this.outcome.usage = parseUsage(response.usage) ?? this.outcome.usage;
    if (type === "response.failed") {
      const code = isRecord(response.error) ? safeId(response.error.code) : undefined;
      this.outcome.error = {
        code: code ?? "response_failed",
        message: `The upstream response failed${code ? ` (${code})` : ""}.`,
      };
    } else if (type === "response.incomplete") {
      const reason = isRecord(response.incomplete_details) ? response.incomplete_details.reason : undefined;
      if (reason === "content_filter")
        this.outcome.error = { code: "content_filter", message: "The upstream content filter stopped the response." };
      else if (reason !== "max_output_tokens")
        this.outcome.error = { code: "response_incomplete", message: "The upstream response did not finish." };
    }
  }
}

/** Usage from a complete (non-streaming) JSON body. */
export function usageFromJson(text: string): Usage | null {
  try {
    const body: unknown = JSON.parse(text);
    return isRecord(body) ? parseUsage(body.usage) : null;
  } catch {
    return null;
  }
}

// Only these limit headers are kept, and only with short token values (counts, seconds, percentages, dates).
const LIMIT_HEADER = /^(retry-after|x-ratelimit-[a-z0-9-]+|x-codex-(primary|secondary)-[a-z0-9-]+)$/i;
const LIMIT_VALUE = /^[\w.:+-]{1,64}$/;

/** The allowlisted headers that describe rate or usage limits. */
export function limitHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) if (LIMIT_HEADER.test(name) && LIMIT_VALUE.test(value)) out[name] = value;
  return out;
}

function retryAfterSeconds(headers: Headers, nowMs: number): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  if (/^\d+$/.test(raw.trim())) return Number(raw);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, Math.round((at - nowMs) / 1000));
}

export interface ErrorClass {
  error: ErrorInfo;
  limit: Limit | null;
}

/**
 * Describes an upstream HTTP error (status >= 400). The error message is built from the status and short identifiers
 * only, never from the body. A 429, or a body that says usage_limit/rate_limit, also yields limit details with
 * `resets_in_seconds` when the body or the headers give one.
 */
export function classifyUpstreamError(status: number, bodyText: string, headers: Headers, nowMs: number): ErrorClass {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = undefined;
  }
  const err = isRecord(body) && isRecord(body.error) ? body.error : isRecord(body) ? body : {};
  const type = safeId(err.type);
  const code = safeId(err.code);
  const kind = `${type ?? ""} ${code ?? ""}`;
  const usageLimit = /usage_limit/.test(kind);
  const isLimit = status === 429 || usageLimit || /rate_limit/.test(kind);

  let resets = num(err.resets_in_seconds) ?? (isRecord(body) ? num(body.resets_in_seconds) : undefined);
  const resetsAt = num(err.resets_at) ?? (isRecord(body) ? num(body.resets_at) : undefined);
  if (resets === undefined && resetsAt !== undefined) resets = Math.max(0, Math.round(resetsAt - nowMs / 1000));
  if (resets === undefined) {
    const header = Number(headers.get("x-codex-primary-reset-after-seconds"));
    if (Number.isFinite(header) && headers.get("x-codex-primary-reset-after-seconds")) resets = header;
  }
  if (resets === undefined) resets = retryAfterSeconds(headers, nowMs) ?? undefined;

  let error: ErrorInfo;
  if (usageLimit) {
    error = {
      code: "usage_limit_reached",
      message: `ChatGPT usage limit reached${resets !== undefined ? `; it resets in ${formatDuration(resets)}` : ""}.`,
    };
  } else if (isLimit) {
    error = {
      code: "rate_limited",
      message: `The upstream rate limit was hit (HTTP ${status})${resets !== undefined ? `; retry in ${formatDuration(resets)}` : ""}.`,
    };
  } else {
    const detail = code ?? type;
    error = {
      code: `upstream_${status}`,
      message: `The upstream returned HTTP ${status}${detail ? ` (${detail})` : ""}.`,
    };
  }
  const limit: Limit | null = isLimit
    ? {
        resetsInSeconds: resets ?? null,
        code: usageLimit ? "usage_limit" : "rate_limit",
        headers: limitHeaders(headers),
      }
    : null;
  return { error, limit };
}

function formatDuration(seconds: number): string {
  if (seconds >= 3600) return `${Math.round(seconds / 360) / 10} h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds)} s`;
}
