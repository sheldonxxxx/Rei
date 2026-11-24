// The agent computer: one headed Chromium with your persistent profile; each session that uses the browser drives
// its own window (up to a cap). You watch a session's window live and take it over from the PWA. The picture is the
// window's own screencast and your input goes to that window only (Chrome DevTools Protocol), so other sessions' windows
// keep working and can't steal your keystrokes.
import type { SessionId } from "./entities.ts";

export type TakeoverId = string;

/**
 * You in control of a session's browser window.
 * - requestedBy "agent": the agent called browser_takeover (a sign-in, 2FA, a CAPTCHA) and ended its turn. It waits as
 *   "pending" until you start it. When you finish, the agent gets a run to carry on; if you cancel, it is told.
 * - requestedBy "user": you pressed Take over. It starts "active" at once. A browser call the agent makes meanwhile waits
 *   until you finish.
 */
export interface Takeover {
  id: TakeoverId;
  sessionId: SessionId;
  requestedBy: "agent" | "user";
  /** The agent's reason, one line; null for "user". */
  reason: string | null;
  /**
   * - pending: waiting for you to start it (agent requests only)
   * - active: you are in control
   * - done: you finished
   * - cancelled: you declined it, it expired (pending 24 h), it timed out (active 15 min without input), or the window closed
   */
  status: "pending" | "active" | "done" | "cancelled";
  /** The page when it was created. */
  url: string | null;
  title: string | null;
  /** Your note when you finished or cancelled ("Signed in"), at most 500 characters; passed to the agent. */
  note: string | null;
  createdAt: number;
  endedAt: number | null;
}

/** A session's window, when it has one. Shown on the session as `browser`. */
export interface SessionBrowser {
  url: string;
  title: string;
  /** The session's takeover that is pending or active, if any. */
  takeover: Takeover | null;
}

// ---- HTTP -----------------------------------------------------------------------------------------------------------

/** GET /api/sessions/:id/browser. `window` false: the session has no window (never used the browser, or it was closed). */
export interface BrowserStateResponse {
  window: boolean;
  url: string | null;
  title: string | null;
  /** CSS pixels of the window's page area; the live frames have this aspect ratio. */
  viewport: { width: number; height: number } | null;
  takeover: Takeover | null;
}

/**
 * POST /api/sessions/:id/browser/takeover: take over now. Accepts a pending agent request (it becomes active) or starts
 * a "user" one. Errors: "no_window", "already_active" (answers the active one in `takeover` too).
 */
export interface StartTakeoverResponse {
  takeover: Takeover;
}

/**
 * POST /api/takeovers/:id/end. "done": you finished (the agent carries on if it asked). "cancel": you decline a pending
 * request or give up an active one (the agent is told, no run starts). Errors: "not_found", "not_open".
 */
export interface EndTakeoverRequest {
  action: "done" | "cancel";
  /** At most 500 characters. */
  note?: string;
}
export interface EndTakeoverResponse {
  takeover: Takeover;
}

// ---- live view: WebSocket GET /api/sessions/:id/browser/live --------------------------------------------------------
//
// Auth: the session cookie and a same-host Origin for web clients, or a device bearer in the Authorization header for
// native clients. Binary messages from the server are JPEG frames of the window's page area, newest only (a slow client
// skips frames). Text messages are JSON, below. Anyone signed in may watch; input is honoured only while this session's
// takeover is active, and is otherwise dropped.

export type LiveServerMessage =
  /** First message. `control`: a takeover of this session is active (input is honoured). */
  | { type: "hello"; viewport: { width: number; height: number }; url: string; title: string; control: boolean }
  | { type: "page"; url: string; title: string }
  | { type: "viewport"; width: number; height: number }
  | { type: "control"; control: boolean }
  /** Takeover only: a <select> got focus; show a picker. Answer with a "select" message. */
  | { type: "select"; options: { label: string; value: string; selected: boolean }[]; multiple: boolean }
  /** Takeover only: the page opened a dialog. Answer with a "dialog" message. */
  | {
      type: "dialog";
      kind: "alert" | "confirm" | "prompt" | "beforeunload";
      message: string;
      defaultPrompt: string | null;
    }
  /** The window closed (or the browser restarted); the socket closes after this. */
  | { type: "closed"; reason: string };

export type MouseButton = "left" | "middle" | "right";

/** Coordinates are CSS pixels in the page area (the frame scaled back to `viewport`). */
export type LiveClientMessage =
  | { type: "mouse"; action: "down" | "up" | "move"; x: number; y: number; button: MouseButton; clickCount: number }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  /** A key with its DOM `key` and `code`; `text` for keys that type a character. Modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
  | { type: "key"; action: "down" | "up"; key: string; code: string; text?: string; modifiers: number }
  /** Text as one insert: IME results (Chinese, Japanese), a phone keyboard, a paste. */
  | { type: "text"; text: string }
  | { type: "select"; values: string[] }
  | { type: "dialog"; accept: boolean; text?: string }
  | { type: "nav"; action: "back" | "forward" | "reload" }
  | { type: "goto"; url: string };

/** The WebSocket close code for failed auth or Origin checks, device revocation or logout, or a missing session. */
export const LIVE_CLOSE_DENIED = 4401;
