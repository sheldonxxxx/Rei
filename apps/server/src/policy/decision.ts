// The decision point: a pure function of (action class, session profile, matching grant, session
// taint labels, whether the destination is new) that says allow, ask or deny. No I/O; everything it needs is passed in.
import type { ActionClass, GrantLength, ProfileName, TaintLabel } from "@rei/protocol";

export const ALL_LENGTHS: readonly GrantLength[] = ["once", "session", "agent", "hours", "always"];
export const ONCE_ONLY: readonly GrantLength[] = ["once"];
const CHAT_DESTINATION: readonly GrantLength[] = ["once", "session"];
const CHAT_WEB: readonly GrantLength[] = ["once", "session", "web_session"];

export interface DecisionInput {
  actionClass: ActionClass;
  profile: ProfileName;
  unattended?: boolean;
  scope?: "web" | "browser_site";
  /** A standing grant (session, agent, hours, always) matches connector + operation + destination for this session. */
  grantMatches: boolean;
  /** The session's taint labels. */
  taint: readonly TaintLabel[];
  /** No approval or grant for this connector + operation + destination exists in this session yet. */
  newDestination: boolean;
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
  const profile = input.profile === "relaxed" && !input.unattended ? "standard" : input.profile;
  const standardChat = profile === "standard" && !input.unattended;
  const open = (via: "profile" | "grant"): Decision => ({ kind: "allow", via });
  if (!input.unattended && scope === "web" && (actionClass === "send" || actionClass === "read_external")) {
    if (profile === "yolo" || standardChat || (profile !== "strict" && actionClass === "read_external"))
      return open("profile");
    if (grantMatches) return open("grant");
    return { kind: "ask", lengths: CHAT_WEB, reason: "this web request needs approval" };
  }
  if (!input.unattended && scope === "browser_site" && actionClass === "send") {
    if (profile === "yolo") return open("profile");
    if (grantMatches) return open("grant");
    return { kind: "ask", lengths: CHAT_DESTINATION, reason: "the page can read what is typed into it" };
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
      if (standardChat || profile === "relaxed" || profile === "yolo") return open("profile");
      return grantMatches ? open("grant") : { kind: "ask", lengths: ALL_LENGTHS, reason: "writing outside asks first" };
    case "send":
      if (isTainted(input.taint)) {
        if (profile === "yolo") return open("profile");
        if (profile === "relaxed") {
          // Only a destination nobody approved or granted yet asks; grants are how a destination stops being new.
          return grantMatches || !input.newDestination
            ? open(grantMatches ? "grant" : "profile")
            : {
                kind: "ask",
                lengths: ONCE_ONLY,
                reason: "this session read outside content and private data, and this destination is new",
              };
        }
        // strict / standard: every time, grants ignored, only "once" offered
        return {
          kind: "ask",
          lengths: ONCE_ONLY,
          reason: "this session read outside content and private data, so every send asks",
        };
      }
      if (profile === "yolo") return open("profile");
      return grantMatches ? open("grant") : { kind: "ask", lengths: ALL_LENGTHS, reason: "sending asks first" };
    case "memory_write":
      if (standardChat || profile === "yolo" || !input.taint.includes("external")) return open("profile");
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
  relaxed: "Relaxed",
  yolo: "YOLO",
};

/** The longest the arguments preview may be (the contract says 4,000 characters, cut with "…"). */
export const ARGS_PREVIEW_MAX = 4_000;
export function argsPreview(args: unknown): string {
  const text = JSON.stringify(args, null, 2) ?? "null";
  return text.length > ARGS_PREVIEW_MAX ? `${text.slice(0, ARGS_PREVIEW_MAX - 1)}…` : text;
}
