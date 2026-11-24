// Service-log content rules shared by every Rei service (ADR 0003): fields carry ids, counts and codes, never free text.
// A string value must look like a token; anything else is replaced, so a careless call site cannot leak a sentence,
// an error message or a URL. Credential-shaped tokens that do pass the shape check are still redacted.

export type LogValue = string | number | boolean | null | undefined;

/** The keys the logger itself writes. A caller cannot set them. */
export const PROTECTED_KEYS = ["timestamp", "t", "level", "service", "event"] as const;
type ProtectedKey = (typeof PROTECTED_KEYS)[number];

/** Fields a caller may attach to an event. Protected keys are rejected by the type and dropped at runtime. */
export type LogFields = { readonly [key: string]: LogValue } & { readonly [K in ProtectedKey]?: never };

/** What replaces a string value that is not token-shaped. */
export const DROPPED = "[dropped]";

// Word characters plus . : / + - (route patterns, model ids, hosts, codes). No whitespace, no ?, =, &, @, quotes.
const TOKEN_SHAPE = /^[\w.:/+-]{0,128}$/;
// Field names that never belong in a service log whatever their value looks like.
const FORBIDDEN_KEYS = /^(text|token|password|secret|authorization|cookie|body|content|message|prompt|url|query)$/i;
const PROTECTED = new Set<string>(PROTECTED_KEYS);

/** True when a string may appear in a service log as is (before credential redaction). */
export function isTokenShaped(value: string): boolean {
  return TOKEN_SHAPE.test(value) && !value.includes("://");
}

/** Removes anything that looks like a credential from a string headed for a log or an error message. */
export function redactCredentials(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]*)?/g, "[redacted-jwt]")
    .replace(/\b(sk|rt|pk)[-_][A-Za-z0-9_-]{16,}/g, "[redacted-key]");
}

export interface SanitizeOptions {
  /** A service-specific last pass over surviving strings (the gateway's redactor, which learns secrets at runtime). */
  readonly redact?: (text: string) => string;
}

/** Applies the content rules to caller fields: protected and forbidden keys dropped, free text replaced, keys redacted. */
export function sanitizeFields(fields: LogFields | undefined, options: SanitizeOptions = {}): Record<string, LogValue> {
  const safe: Record<string, LogValue> = {};
  if (!fields) return safe;
  for (const [key, value] of Object.entries(fields)) {
    if (PROTECTED.has(key) || FORBIDDEN_KEYS.test(key)) continue;
    if (typeof value === "string") {
      const kept = isTokenShaped(value) ? redactCredentials(value) : DROPPED;
      safe[key] = options.redact ? options.redact(kept) : kept;
    } else if (typeof value === "number" && !Number.isFinite(value)) {
      safe[key] = null;
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

// A type alias (not an interface) so it fits LogFields' index signature and can be passed or spread directly.
export type ErrorFields = {
  /** A stable code: from the error's own `code`, its `kind`/`status`, a known class, or `unknown`. */
  readonly errorCode: string;
  /** The error's class name (`TypeError`, `EmbedderError`), or the value's type when it is not an Error. */
  readonly errorClass: string;
};

const CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;
const CLASS_SHAPE = /^\w{1,64}$/;
// SQLite primary result codes worth naming (node:sqlite puts them on `errcode`).
const SQLITE_CODES: Readonly<Record<number, string>> = { 5: "sqlite_busy", 6: "sqlite_locked", 13: "sqlite_full" };

/**
 * Turns a thrown value into log-safe fields. The message is never read: where the user needs the detail it belongs in
 * the Trace or the job's status record. `codeOf` lets a service name its own failures first.
 */
export function classifyError(error: unknown, codeOf?: (error: unknown) => string | undefined): ErrorFields {
  return { errorCode: codeFor(error, codeOf) ?? "unknown", errorClass: classOf(error) };
}

function codeFor(error: unknown, codeOf: ((error: unknown) => string | undefined) | undefined): string | undefined {
  const own = codeOf?.(error);
  if (own !== undefined && CODE_SHAPE.test(own)) return own;
  const direct = intrinsicCode(error);
  if (direct) return direct;
  // fetch() wraps the useful part: TypeError("fetch failed") with cause.code = ECONNREFUSED.
  if (error instanceof Error && error.cause !== undefined) return intrinsicCode(error.cause);
  return undefined;
}

function intrinsicCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as { code?: unknown; errcode?: unknown; kind?: unknown; status?: unknown; name?: unknown };
  if (typeof e.errcode === "number") {
    const sqlite = SQLITE_CODES[e.errcode & 0xff];
    if (sqlite) return sqlite;
  }
  if (typeof e.code === "string" && CODE_SHAPE.test(e.code)) return e.code.toLowerCase();
  if (typeof e.kind === "string" && CODE_SHAPE.test(e.kind)) {
    return typeof e.status === "number" ? `${e.kind}_${e.status}`.toLowerCase() : e.kind.toLowerCase();
  }
  if (e.name === "AbortError") return "aborted";
  if (e.name === "TimeoutError") return "timeout";
  return undefined;
}

function classOf(error: unknown): string {
  if (error instanceof Error) return CLASS_SHAPE.test(error.name) ? error.name : "Error";
  if (error === null) return "null";
  return typeof error;
}

// ---- levels and the logger ---------------------------------------------------------------------------------------

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Reads a level setting (REI_LOG_LEVEL). Unset or empty means `fallback`; anything else that is not a level throws,
 * so a typo stops the service at startup instead of silently logging at the wrong level.
 */
export function parseLogLevel(raw: string | undefined, fallback: LogLevel = "info"): LogLevel {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel;
  throw new Error(`REI_LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")} (got "${raw}")`);
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LoggerOptions extends SanitizeOptions {
  /** The service name on every line: control, gateway or egress. */
  readonly service: string;
  /** The lowest level written (default info). */
  readonly level?: LogLevel;
  /** Where a finished JSON line goes (default: stdout). */
  readonly write?: (line: string) => void;
  readonly now?: () => number;
}

/** A JSON-lines logger: `{ timestamp, level, service, event, ...fields }`, fields under the content rules above. */
export function createLogger(options: LoggerOptions): Logger {
  const min = RANK[options.level ?? "info"];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? Date.now;
  const event = (raw: string) => (isTokenShaped(raw) && raw !== "" ? raw : DROPPED);
  const emit = (level: LogLevel) =>
    RANK[level] < min
      ? () => {}
      : (name: string, fields?: LogFields) => {
          const line = {
            timestamp: new Date(now()).toISOString(),
            level,
            service: options.service,
            event: event(name),
            // sanitizeFields drops protected keys, so caller fields cannot overwrite the four above.
            ...sanitizeFields(fields, options),
          };
          write(JSON.stringify(line));
        };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
