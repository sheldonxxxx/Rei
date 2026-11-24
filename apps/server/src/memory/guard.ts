// The secret guard for memory_add and memory_replace: memory never holds passwords, keys, one-time codes or card numbers.
// It is a net, not a proof: it catches what a model is likely to copy from a chat. The user's own edits in the Memory
// page are not guarded.
export const SECRET_REFUSAL = "Not saved: memory never holds passwords, keys or card numbers.";

/** Key and token shapes that name themselves. */
const KEY_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/,
];

/** "my password is hunter2", "pin: 4821", "api key = ...": a secret word, a verb or sign, then a value. */
const NAMED_SECRET =
  /\b(?:pass(?:word|code|phrase)|passwd|pwd|pin(?: code)?|api[ _-]?key|secret(?: key)?|access token|auth token|cvv|cvc|security code)\b[\s"'`]*(?:is|are|was|=|:)[\s"'`]*([^\s"'`,;]{4,})/i;
/** What follows the secret word is plain talk, not a value. */
const NOT_A_VALUE = new Set([
  "stored",
  "saved",
  "kept",
  "managed",
  "generated",
  "required",
  "needed",
  "reset",
  "changed",
  "weak",
  "strong",
  "long",
  "short",
  "hard",
  "easy",
  "too",
  "not",
  "the",
  "your",
  "with",
  "for",
  "from",
  "on",
  "in",
  "at",
  "my",
  "an",
  "set",
  "safe",
  "secure",
  "private",
  "unknown",
  "forgotten",
]);

/** One-time and verification codes. */
const ONE_TIME = [
  /\b(?:one[- ]time|verification|security|login|sign[- ]?in|auth(?:entication)?|confirmation|sms|2fa|mfa|otp)\s+(?:code|passcode|password|pin)\b[^\n]{0,24}?\b\d{4,8}\b/i,
  /\b(?:otp|2fa|mfa)\b[^\n]{0,16}\b\d{4,8}\b/i,
];

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** A run of 13 to 19 digits, with single spaces or dashes between groups, that passes the Luhn check. */
function hasCardNumber(text: string): boolean {
  for (const m of text.matchAll(/(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** A long token of key-ish characters with letters and digits and a spread of characters: a key, a hash or a token. */
function hasHighEntropyToken(text: string): boolean {
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9=]+$/g, "");
    if (token.length < 24 || /^https?:/i.test(raw)) continue;
    if (!/^[A-Za-z0-9+/_=-]+$/.test(token)) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) continue; // a UUID is an id, not a key
    if (/^[0-9a-f]{32,}$/i.test(token)) return true; // a hex digest or key
    if (/[A-Za-z]/.test(token) && /\d/.test(token) && entropy(token) >= 3.5) return true;
  }
  return false;
}

/** Whether the text looks like it holds a secret. */
export function looksSecret(text: string): boolean {
  if (KEY_SHAPES.some((re) => re.test(text))) return true;
  const named = NAMED_SECRET.exec(text);
  if (named && !NOT_A_VALUE.has(named[1]!.toLowerCase())) return true;
  if (ONE_TIME.some((re) => re.test(text))) return true;
  return hasCardNumber(text) || hasHighEntropyToken(text);
}
