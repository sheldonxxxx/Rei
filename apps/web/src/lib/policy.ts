import type {
  ActionClass,
  Approval,
  GrantLength,
  Message,
  ProfileName,
  Session,
  SessionStatus,
  TaintLabel,
} from "@rei/protocol";

/** Short label for what a blocked call does (the chip on an approval card). */
export const CLASS_LABEL: Record<ActionClass, string> = {
  read_internal: "Read",
  read_external: "Read outside content",
  write_internal: "Write",
  write_external: "Reversible write",
  send: "Send",
  irreversible: "Irreversible",
  credentials: "Login",
  memory_write: "Memory write",
  configure: "Set up",
};

export const PROFILE_LABEL: Record<ProfileName, string> = {
  strict: "Strict",
  standard: "Standard",
  yolo: "YOLO",
};

/** One line per permission profile (from the protocol's own descriptions). */
export const PROFILE_HELP: Record<ProfileName, string> = {
  strict: "Asks before web research and actions outside the sandbox.",
  standard: "Researches, makes reversible edits, and updates memory automatically.",
  yolo: "Runs built-in actions automatically, including sends, trigger changes and irreversible actions. Logins still need you.",
};
export const PROFILES: ProfileName[] = ["strict", "standard", "yolo"];

/** The sentence under an approval card's header when the chat is tainted. */
export function taintWarning(taint: TaintLabel[], actionClass?: ActionClass): string {
  if (actionClass === "memory_write")
    return "This chat read outside content, so this memory change needs approval. Check what would be saved.";
  const ext = taint.includes("external");
  const priv = taint.includes("private");
  if (priv)
    return ext
      ? "This chat has read outside content and may hold private data. Check the details before approving."
      : "This chat may hold private data. Check the details before approving.";
  return "This chat has read outside content. Check the details before approving.";
}

/** A session needing you shows as waiting even while a run is going on elsewhere in it. */
export function effectiveStatus(
  s: Pick<Session, "status" | "pendingApprovals"> & { browser?: Session["browser"] },
): SessionStatus {
  return (s.pendingApprovals ?? 0) > 0 || s.browser?.takeover?.status === "pending" ? "waiting_for_user" : s.status;
}

/** "Approved once", "Approved for 4 hours", "Denied", ... */
export function decisionLabel(a: Pick<Approval, "status" | "grantLength" | "grantExpiresAt" | "decidedAt">): string {
  switch (a.status) {
    case "approved":
      return grantLabel(a.grantLength, grantHours(a));
    case "denied":
      return "Denied";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
    default:
      return "Approval needed";
  }
}

/** Whole hours an "hours" grant was given for, from when it was decided to when it ends. */
function grantHours(a: Pick<Approval, "grantExpiresAt" | "decidedAt">): number | undefined {
  if (a.grantExpiresAt === undefined || a.decidedAt === null) return undefined;
  const hours = Math.round((a.grantExpiresAt - a.decidedAt) / 3_600_000);
  return hours >= 1 ? hours : undefined;
}

function grantLabel(length: GrantLength | undefined, hours?: number): string {
  switch (length) {
    case "once":
      return "Approved once";
    case "session":
      return "Approved for this chat";
    case "web_session":
      return "All web approved for this chat";
    case "agent":
      return "Approved for this agent";
    case "hours":
      return hours ? `Approved for ${hours} ${hours === 1 ? "hour" : "hours"}` : "Approved for a set time";
    case "always":
      return "Always allowed";
    case "trigger":
      return "Approved for this trigger";
    default:
      return "Approved";
  }
}

/** The note the server adds when you approve a call ("You approved #3: ..."). The approval card says the same, so the chat doesn't. */
export const isApprovalEcho = (m: Pick<Message, "role" | "text">): boolean =>
  m.role === "notice" && /^You approved #\d+: /.test(m.text);
