// The decision point: a pure function of (action class, session level, matching grant, session taint labels) that says
// allow, ask or deny. No I/O; everything it needs is passed in. Every kind of session (a chat, a worker, a trigger's run)
// gets the same table: the same level and the same inputs give the same decision (docs/chat-permissions.md).
import type { ActionClass, GrantLength, ProfileInput, ProfileName, TaintLabel } from "@rei/protocol";

export const ALL_LENGTHS: readonly GrantLength[] = ["once", "session", "agent", "hours", "always"];
export const ONCE_ONLY: readonly GrantLength[] = ["once"];
const SITE_LENGTHS: readonly GrantLength[] = ["once", "session"];
const WEB_LENGTHS: readonly GrantLength[] = ["once", "session", "web_session"];

/**
 * The level a stored or requested name stands for. "relaxed" is an older name for Standard, kept so stored chats,
 * triggers and older clients still work; anything else unknown reads as Strict, so a damaged value never opens more.
 */
export function canonicalProfile(value: ProfileInput | string | null | undefined): ProfileName {
  if (value === "relaxed") return "standard";
  return value === "standard" || value === "yolo" ? value : "strict";
}

export interface DecisionInput {
  actionClass: ActionClass;
  profile: ProfileName;
  /** web: a public web search or fetch (web grants cover it). browser_site: typing into a site after private reads. */
  scope?: "web" | "browser_site";
  /** A standing grant (session, agent, hours, always) matches connector + operation + destination for this session. */
  grantMatches: boolean;
  /** The session's taint labels. */
  taint: readonly TaintLabel[];
}

export type Decision =
  | { kind: "allow"; via: "profile" | "grant" }
  | { kind: "ask"; lengths: readonly GrantLength[]; reason: string }
  | { kind: "deny"; reason: string };

/** The session has read outside content and private data: anything it sends may carry the private data out. */
export const isTainted = (taint: readonly TaintLabel[]): boolean =>
  taint.includes("external") && taint.includes("private");

export const CREDENTIALS_DENIED =
  "This needs a sign-in, a code or a CAPTCHA, which only the user can do (a takeover). Tell the user in one short sentence that you cannot do it yourself, and end your turn. Do not try to work around it.";

export function decide(input: DecisionInput): Decision {
  const { actionClass, grantMatches, scope } = input;
  const profile = canonicalProfile(input.profile);
  const open = (via: "profile" | "grant"): Decision => ({ kind: "allow", via });
  // Public web research: Standard and YOLO search and fetch on their own, also after private reads.
  if (scope === "web" && (actionClass === "send" || actionClass === "read_external")) {
    if (profile !== "strict") return open("profile");
    if (grantMatches) return open("grant");
    return { kind: "ask", lengths: WEB_LENGTHS, reason: "this web request needs approval" };
  }
  if (scope === "browser_site" && actionClass === "send") {
    if (profile === "yolo") return open("profile");
    if (grantMatches) return open("grant");
    return { kind: "ask", lengths: SITE_LENGTHS, reason: "the page can read what is typed into it" };
  }
  switch (actionClass) {
    case "read_internal":
    case "write_internal":
      return open("profile");
    case "read_external":
      if (profile !== "strict") return open("profile");
      return grantMatches
        ? open("grant")
        : { kind: "ask", lengths: ALL_LENGTHS, reason: "strict profile asks before reading outside content" };
    case "write_external":
      if (profile !== "strict") return open("profile");
      return grantMatches ? open("grant") : { kind: "ask", lengths: ALL_LENGTHS, reason: "writing outside asks first" };
    case "send":
      if (profile === "yolo") return open("profile");
      if (isTainted(input.taint))
        // Strict and Standard: every time, grants ignored, only "once" offered.
        return {
          kind: "ask",
          lengths: ONCE_ONLY,
          reason: "this session read outside content and private data, so every send asks",
        };
      return grantMatches ? open("grant") : { kind: "ask", lengths: ALL_LENGTHS, reason: "sending asks first" };
    case "memory_write":
      if (profile !== "strict" || !input.taint.includes("external")) return open("profile");
      return grantMatches
        ? open("grant")
        : {
            kind: "ask",
            lengths: ALL_LENGTHS,
            reason: "this chat read outside content, so writing your profile asks first",
          };
    case "configure":
      if (profile === "yolo") return open("profile");
      return {
        kind: "ask",
        lengths: ONCE_ONLY,
        reason: "this sets up something that runs later without you",
      };
    case "irreversible":
      if (profile === "yolo") return open("profile");
      return { kind: "ask", lengths: ONCE_ONLY, reason: "this cannot be undone, so it always asks" };
    case "credentials":
      return { kind: "deny", reason: CREDENTIALS_DENIED };
  }
}

/** Canonical JSON (keys sorted) so the same arguments always give the same text. */
export function canonicalJson(value: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  return JSON.stringify(canon(value));
}

export const PROFILE_LABEL: Record<ProfileName, string> = {
  strict: "Strict",
  standard: "Standard",
  yolo: "YOLO",
};

/** The longest the arguments preview may be (the contract says 4,000 characters, cut with "…"). */
export const ARGS_PREVIEW_MAX = 4_000;
export function argsPreview(args: unknown): string {
  const text = JSON.stringify(args, null, 2) ?? "null";
  return text.length > ARGS_PREVIEW_MAX ? `${text.slice(0, ARGS_PREVIEW_MAX - 1)}…` : text;
}
