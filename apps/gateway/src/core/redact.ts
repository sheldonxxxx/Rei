// Redaction of secret values from anything that leaves the process as text (log lines, error messages, stored bodies).
// Besides the exact token values this process has seen (kept across rotation), it masks anything shaped like a bearer
// token or a JWT, as a second line of defence for values the process never held.

import type { LogFields, Logger } from "@rei/logging";

export interface Redactor {
  /** Remember secret values; short ones (under 8 characters) are ignored. */
  add(...secrets: (string | undefined | null)[]): void;
  redact(text: string): string;
}

const MASK = "[REDACTED]";
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g;

export function createRedactor(): Redactor {
  const secrets = new Set<string>();
  let ordered: string[] = [];
  return {
    add(...values) {
      let changed = false;
      for (const value of values) {
        if (value && value.length >= 8 && !secrets.has(value)) {
          secrets.add(value);
          changed = true;
        }
      }
      // Longest first, so a secret that contains another is masked whole.
      if (changed) ordered = [...secrets].sort((a, b) => b.length - a.length);
    },
    redact(text) {
      let out = text;
      for (const secret of ordered) if (out.includes(secret)) out = out.split(secret).join(MASK);
      return out.replace(BEARER, `Bearer ${MASK}`).replace(JWT, MASK);
    },
  };
}

/**
 * Passes every string field through the redactor before the logger sees it. The logger's own content rules drop free
 * text, but a stand-in token or an API key is token-shaped and would otherwise pass: only the redactor knows them.
 */
export function redactingLogger(log: Logger, redactor: Redactor): Logger {
  const scrub = (fields: LogFields | undefined): LogFields | undefined => {
    if (!fields) return fields;
    const out: Record<string, LogFields[string]> = {};
    for (const [key, value] of Object.entries(fields))
      out[key] = typeof value === "string" ? redactor.redact(value) : value;
    return out as LogFields;
  };
  return {
    debug: (event, fields) => log.debug(event, scrub(fields)),
    info: (event, fields) => log.info(event, scrub(fields)),
    warn: (event, fields) => log.warn(event, scrub(fields)),
    error: (event, fields) => log.error(event, scrub(fields)),
  };
}

/** Constant-time string comparison that works anywhere Web Crypto does (Node, Workers): compares SHA-256 digests. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
