import { useCallback, useEffect, useReducer, useRef } from "react";
import type { InspectFocus } from "../components/full/Inspector.tsx";
import { useMediaQuery } from "./route.ts";
import { useStoredFlag } from "./storage.ts";

/** The chat's side panels. Two at once would squeeze the chat to nothing, so exactly one (or none) is open. */
export type SidePanel =
  | { kind: "none" }
  | { kind: "sessions" }
  /** `autoStart` rises each time a takeover card asks to take over; 0 means just look. */
  | { kind: "browser"; autoStart: number }
  | { kind: "inspector"; focus: InspectFocus };

export type SidePanelAction =
  | { type: "toggle-sessions" }
  | { type: "toggle-browser" }
  | { type: "take-over" }
  | { type: "show-browser" }
  | { type: "inspect"; focus: InspectFocus }
  | { type: "close"; panel: Exclude<SidePanel["kind"], "none"> };

const NONE: SidePanel = { kind: "none" };

/** Every panel transition lives here, so opening one always closes the others. */
export function sidePanelReducer(state: SidePanel, action: SidePanelAction): SidePanel {
  switch (action.type) {
    case "toggle-sessions":
      return state.kind === "sessions" ? NONE : { kind: "sessions" };
    case "toggle-browser":
      return state.kind === "browser" ? NONE : { kind: "browser", autoStart: 0 };
    case "take-over":
      return { kind: "browser", autoStart: state.kind === "browser" ? state.autoStart + 1 : 1 };
    case "show-browser":
      return state.kind === "browser" ? state : { kind: "browser", autoStart: 0 };
    case "inspect":
      return { kind: "inspector", focus: action.focus };
    case "close":
      return state.kind === action.panel ? NONE : state;
  }
}

const EXPANDED_KEY = "rei:browser-expanded";

/**
 * Owns every chat side-panel transition: which panel is open (never two), the browser's wide/phone presentation, and
 * where focus returns when a panel closes. Callers say what they want; they never close peers or move focus themselves.
 */
export function useChatPanels({ hasSession, full }: { hasSession: boolean; full: boolean }) {
  const [side, dispatch] = useReducer(sidePanelReducer, NONE);
  // Expanded: the browser takes the whole main area and the chat column is hidden (remembered on this device). On a phone
  // the browser is already a full-screen sheet, which counts as expanded.
  const wide = useMediaQuery("(min-width: 768px)");
  const [expanded, setExpanded] = useStoredFlag(EXPANDED_KEY);
  const sessionsBtn = useRef<HTMLButtonElement>(null);
  const browserBtn = useRef<HTMLButtonElement>(null);
  const inspectOpener = useRef<HTMLElement | null>(null);
  const nextNonce = useRef(0);
  const restoreFocus = useRef<"browser" | "inspector" | null>(null);

  const browserOpen = side.kind === "browser" && hasSession;
  const focusView = browserOpen && (expanded || !wide);
  const browserLayout = !wide ? "sheet" : expanded ? "focus" : "side";

  const closeSessions = useCallback(() => {
    dispatch({ type: "close", panel: "sessions" });
    sessionsBtn.current?.focus();
  }, []);
  const closeBrowser = useCallback(() => {
    dispatch({ type: "close", panel: "browser" });
    restoreFocus.current = "browser";
  }, []);
  const openInspector = useCallback(
    (runId: string | null, stepId: string | null = null, surfaceId: string | null = null) => {
      inspectOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dispatch({ type: "inspect", focus: { nonce: ++nextNonce.current, runId, stepId, surfaceId } });
    },
    [],
  );
  const closeInspector = useCallback(() => {
    dispatch({ type: "close", panel: "inspector" });
    restoreFocus.current = "inspector";
  }, []);
  const toggleSessions = useCallback(() => dispatch({ type: "toggle-sessions" }), []);
  const toggleBrowser = useCallback(() => dispatch({ type: "toggle-browser" }), []);
  const takeOver = useCallback(() => dispatch({ type: "take-over" }), []);
  const showBrowser = useCallback(() => dispatch({ type: "show-browser" }), []);
  const toggleExpanded = useCallback(() => setExpanded((e) => !e), [setExpanded]);
  // "Back to chat" from the browser: collapse it where it sits beside the chat, close the sheet on a phone.
  const showChat = useCallback(() => {
    if (wide) setExpanded(false);
    else closeBrowser();
  }, [wide, setExpanded, closeBrowser]);

  useEffect(() => {
    if (!full) dispatch({ type: "close", panel: "inspector" });
  }, [full]);
  useEffect(() => {
    const closed = restoreFocus.current;
    if (!closed || side.kind === closed) return;
    restoreFocus.current = null;
    // The browser can hide the header, and the phone Inspector makes the chat inert until it closes.
    const opener = closed === "browser" ? browserBtn.current : inspectOpener.current;
    opener?.focus();
  }, [side.kind]);

  return {
    side,
    sessionsOpen: side.kind === "sessions",
    inspect: side.kind === "inspector" ? side.focus : null,
    browserOpen,
    browserAutoStart: side.kind === "browser" ? side.autoStart : 0,
    wide,
    focusView,
    browserLayout,
    sessionsBtn,
    browserBtn,
    toggleSessions,
    toggleBrowser,
    takeOver,
    showBrowser,
    openInspector,
    closeSessions,
    closeBrowser,
    closeInspector,
    toggleExpanded,
    showChat,
  } as const;
}
