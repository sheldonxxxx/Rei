import type {
  Agent,
  DecideApprovalRequest,
  EndTakeoverRequest,
  Message,
  MessageContext,
  ProfileName,
  RunTrace,
  SendWhenBusy,
  Session,
} from "@rei/protocol";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/primitives/dropdown-menu.tsx";
import type { Api } from "../api/client.ts";
import { describeError, describeErrorInfo } from "../api/client.ts";
import { isScriptStep, parkedCalls } from "../lib/activity.ts";
import { approvalGroups, liftApprovalCards } from "../lib/approvals.ts";
import { branchesOf, childrenOf, isUnfinished } from "../lib/family.ts";
import { useFullMode } from "../lib/fullMode.tsx";
import { newId } from "../lib/id.ts";
import { groupMessages } from "../lib/memory.ts";
import { MotionRegion, prefersReducedMotion, useRegionLive } from "../lib/motion.tsx";
import { approvalOutcomes, isSimpleNoise, quietRunIds } from "../lib/quiet.ts";
import { useReadMarker } from "../lib/readMarker.ts";
import { sessionHref, triggerHref, useLocation } from "../lib/route.ts";
import { nestedLiveCalls, scriptCards } from "../lib/script.ts";
import { useChatPanels } from "../lib/sidePanels.ts";
import { useTrace } from "../lib/useTrace.ts";
import type { PendingMessage } from "../state/session.ts";
import { continuable, isRunning } from "../state/session.ts";
import { useSessionStream } from "../stream/hooks.ts";
import { ApprovalGroupCard, type DecideGroupFn } from "./ApprovalGroupCard.tsx";
import { Avatar } from "./Avatar.tsx";
import { AvatarPicker } from "./AvatarPicker.tsx";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { Composer, type ComposerHandle } from "./Composer.tsx";
import { ComposerSettings } from "./ComposerSettings.tsx";
import { ConnectionBadge } from "./ConnectionBadge.tsx";
import { DeleteDialog } from "./DeleteDialog.tsx";
import { ConfirmDialog } from "./dialogParts.tsx";
import { FloatingAssistant } from "./FloatingAssistant.tsx";
import { AgentSettingsDialog } from "./full/AgentSettingsDialog.tsx";
import type { ForkAt } from "./full/ForkDialog.tsx";
import { ForkDialog } from "./full/ForkDialog.tsx";
import { Inspector } from "./full/Inspector.tsx";
import { Icon } from "./Icon.tsx";
import type { UndoChangeFn } from "./MemoryCards.tsx";
import { MemoryChipRow } from "./MemoryCards.tsx";
import type { FullHandlers, MemoryHandlers } from "./MessageItem.tsx";
import { MessageItem, PendingItem } from "./MessageItem.tsx";
import { PermissionsDialog } from "./PermissionsDialog.tsx";
import { SessionsPanel } from "./SessionsPanel.tsx";
import type { SurfaceContextValue } from "./surface/context.tsx";
import { SurfaceContext } from "./surface/context.tsx";
import { Tip } from "./Tip.tsx";
import { ToolActivity } from "./ToolActivity.tsx";

interface Props {
  api: Api;
  sessionId: string;
  agents: Agent[];
  /** The default agent can't be deleted, so its home chat doesn't offer to delete it. */
  defaultAgentId?: string | undefined;
  /** The global stream is ready and does not list this session. */
  missing: boolean;
  onBack: () => void;
  /** Every session the global stream knows, or undefined until it has loaded. Used for links to related chats and the sessions panel. */
  sessions?: Session[] | undefined;
  /** Open another chat (null: the list). */
  onNavigate?: (sessionId: string | null) => void;
  /** The server removed this chat (its stream said so). */
  onRemoved?: (sessionId: string) => void;
  /** This client is about to delete (`true`) or failed to delete (`false`) the chat, so its removal isn't announced as news. */
  onLocalDelete?: (sessionId: string, deleting: boolean) => void;
  /** Shown in the header on small screens, where the sidebar is hidden. */
  onNewChat?: () => void;
  /** The agent just opened this chat's browser window; the chat has already opened the panel. */
  onBrowserStarted?: (() => void) | undefined;
  onUnauthorized: () => void;
  /** Open the chat at this message: scroll to it and highlight it briefly (a link from the Memory page). */
  focusMessageId?: string | null | undefined;
}

const BOTTOM_SLACK = 80;
/** How long a smooth scroll to a new row is left alone (the browser's own glide is about this long). */
const EASE_MS = 400;
/** The longest a chat that is still loading stays hidden before it shows whatever it has. */
const OPEN_HOLD_MS = 1200;
const FLASH_MS = 2400;

function liveStatus(messages: Message[]): string {
  const last = messages[messages.length - 1];
  if (last?.internal) return "";
  if (last?.role === "report") return "Assistant is reviewing a background result";
  if (last?.role === "approval" && last.approval?.status === "pending")
    return `Approval needed: ${last.approval.summary}`;
  if (last?.role === "takeover" && last.takeover?.status === "pending")
    return `The assistant needs you in the browser${last.takeover.reason ? `: ${last.takeover.reason}` : ""}`;
  if (last?.role === "notice") return last.text;
  if (last?.role === "trigger" && last.trigger)
    return last.runId
      ? "Assistant is reviewing a background result"
      : `${last.trigger.triggerName}: ${last.trigger.text}`;
  if (last?.role === "memory" && last.memory?.change)
    return `Memory updated: ${last.memory.change.after ?? last.memory.change.before ?? ""}`;
  if (!last || last.role !== "assistant") return "";
  switch (last.status) {
    case "streaming":
      return "Assistant is replying";
    case "complete":
      return "Reply complete";
    case "aborted":
      return "Reply stopped";
    case "error":
      return `Reply failed. ${last.error ? describeErrorInfo(last.error, "") : ""}`;
    default:
      return "";
  }
}

export function ChatView({
  api,
  sessionId,
  agents,
  defaultAgentId,
  missing,
  onBack,
  sessions,
  onNavigate,
  onRemoved,
  onLocalDelete,
  onNewChat,
  onBrowserStarted,
  onUnauthorized,
  focusMessageId,
}: Props) {
  const { state, dispatch, status, loadEarlier, loadingEarlier } = useSessionStream(api, sessionId, onUnauthorized);
  const [continuing, setContinuing] = useState(false);
  // Keeps the reader's place when older messages are put above what they are reading.
  const keepFromBottom = useRef<number | null>(null);
  const [stopping, setStopping] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const forceScroll = useRef(false);
  // How many rows the transcript had at the last follow, to tell a new row from a change inside one.
  const rowCount = useRef(0);
  // While a new row glides into view, content growth must not cut the glide short with a snap.
  const easingUntil = useRef(0);
  // Set while the chat is opening (and the first page of its history is still landing): follow instantly, no glide.
  const opening = useRef(true);
  const [lookOpen, setLookOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmAgentDelete, setConfirmAgentDelete] = useState(false);
  const [agentDeleting, setAgentDeleting] = useState(false);
  const [agentDeleteError, setAgentDeleteError] = useState<string | null>(null);
  const { full } = useFullMode();
  const [forkAt, setForkAt] = useState<ForkAt | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const inspectId = useId();
  const [permsOpen, setPermsOpen] = useState(false);
  const [savingPerms, setSavingPerms] = useState(false);
  const [permsError, setPermsError] = useState<string | null>(null);
  const profileBtn = useRef<HTMLButtonElement>(null);
  const optionsBtn = useRef<HTMLButtonElement>(null);
  // What the "Chat options" menu chose: run once the menu has closed and handed focus back to its button, so a dialog that
  // opens then remembers that button and gives focus back to it.
  const menuPick = useRef<(() => void) | null>(null);
  const browserId = useId();
  const panelId = useId();
  const unfinishedId = useId();

  const removedCb = useRef(onRemoved);
  removedCb.current = onRemoved;
  useEffect(() => {
    if (state.removed) removedCb.current?.(sessionId);
  }, [state.removed, sessionId]);

  const session = state.session;
  // One owner for the side panels: exclusivity, takeover intent, wide/phone layout and focus return (lib/sidePanels.ts).
  const panels = useChatPanels({ hasSession: !!session, full });
  const {
    browserOpen,
    browserAutoStart,
    browserLayout,
    focusView,
    inspect,
    openInspector,
    closeInspector,
    closeBrowser,
    toggleExpanded,
    wide,
  } = panels;
  // When the agent starts the browser while you watch this chat, show it and give it the room. A window that already
  // existed when the chat loaded is left as you had it.
  const hasBrowser = !!session?.browser;
  const sawBrowser = useRef<boolean | null>(null);
  const showBrowser = panels.showBrowser;
  const browserStartedCb = useRef(onBrowserStarted);
  browserStartedCb.current = onBrowserStarted;
  useEffect(() => {
    if (!session) return;
    const before = sawBrowser.current;
    sawBrowser.current = hasBrowser;
    if (before === false && hasBrowser) {
      showBrowser();
      browserStartedCb.current?.();
    }
  }, [session, hasBrowser, showBrowser]);
  const agent = agents.find((a) => a.id === session?.agentId);
  const running = isRunning(state);

  // What a message sent while a reply runs does by default (Settings > Behavior); read again after any route change, so
  // coming back from Settings applies a change.
  const route = useLocation();
  const [whenBusy, setWhenBusy] = useState<SendWhenBusy>("steer");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `route` is the trigger: any route change rereads the setting.
  useEffect(() => {
    let live = true;
    api.getBehaviorSettings?.().then(
      (r) => {
        if (live && r.settings.chat) setWhenBusy(r.settings.chat.whenBusy);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, route]);

  const sendOnce = useCallback(
    (requestId: string, text: string, context?: MessageContext, options?: { whenBusy?: SendWhenBusy }) => {
      api.sendMessage(sessionId, requestId, text, context, options).then(
        (r) => dispatch({ type: "local.sent", requestId, messageId: r.messageId }),
        (e) => dispatch({ type: "local.failed", requestId, error: `Not sent. ${describeError(e)}` }),
      );
    },
    [api, sessionId, dispatch],
  );

  const send = (
    text: string,
    context?: MessageContext,
    draftRequestId?: string,
    options?: { whenBusy?: SendWhenBusy },
  ): void | Promise<void> => {
    const requestId = draftRequestId ?? newId();
    forceScroll.current = true;
    if (context?.selectedSkills?.length) {
      // The server can refuse a chosen skill; wait for its answer so the composer keeps the draft and says why.
      return api.sendMessage(sessionId, requestId, text, context, options).then((r) => {
        dispatch({ type: "local.add", requestId, text, now: Date.now(), ...context });
        dispatch({ type: "local.sent", requestId, messageId: r.messageId });
      });
    }
    dispatch({ type: "local.add", requestId, text, now: Date.now(), ...context });
    sendOnce(requestId, text, context, options);
  };
  const compact = useCallback(
    async (instructions: string | undefined, requestId: string) => {
      await api.compact(sessionId, { requestId, ...(instructions ? { instructions } : {}) });
    },
    [api, sessionId],
  );
  const retry = (p: PendingMessage) => {
    dispatch({ type: "local.retry", requestId: p.requestId });
    sendOnce(p.requestId, p.text, p); // same requestId: the server de-duplicates
  };

  async function continueRun() {
    setContinuing(true);
    setActionError(null);
    forceScroll.current = true;
    try {
      await api.continueRun(sessionId);
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setContinuing(false);
    }
  }

  async function earlier() {
    const el = scroller.current;
    keepFromBottom.current = el ? el.scrollHeight - el.scrollTop : null;
    try {
      await loadEarlier();
    } catch (e) {
      keepFromBottom.current = null;
      setActionError(describeError(e));
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after the list changed (older items put above), to restore the place.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (keepFromBottom.current === null || !el) return;
    el.scrollTop = el.scrollHeight - keepFromBottom.current;
    keepFromBottom.current = null;
  }, [state.messages]);

  async function stop() {
    setStopping(true);
    setActionError(null);
    try {
      await api.cancel(sessionId);
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setStopping(false);
    }
  }

  const branch = useCallback(
    async (messageId: string) => {
      const r = await api.forkSession(sessionId, messageId);
      onNavigate?.(r.session.id);
    },
    [api, sessionId, onNavigate],
  );

  // Edit rewinds this chat to just before the message and sends the text there. The stream brings the replacement view.
  const edit = useCallback(
    async (
      messageId: string,
      text: string,
      mentions?: MessageContext["mentions"],
      selectedSkills?: MessageContext["selectedSkills"],
    ) => {
      forceScroll.current = true;
      try {
        await api.editMessage(sessionId, {
          messageId,
          text,
          ...(mentions ? { mentions } : {}),
          ...(selectedSkills ? { selectedSkills: selectedSkills.map(({ id, version }) => ({ id, version })) } : {}),
        });
      } catch (error) {
        forceScroll.current = false;
        throw error;
      }
    },
    [api, sessionId],
  );
  const switchVersion = useCallback(
    async (messageId: string, to: "prev" | "next") => {
      await api.switchVersion(sessionId, { messageId, to });
    },
    [api, sessionId],
  );

  const sendAction = useCallback<NonNullable<SurfaceContextValue["sendAction"]>>(
    async (surface, req) => {
      await api.surfaceAction(sessionId, surface.surfaceId, req);
      forceScroll.current = true;
    },
    [api, sessionId],
  );
  const surfaces = useMemo<SurfaceContextValue>(() => {
    const submits = new Set<string>();
    const titles = new Map<string, string>();
    for (const m of state.messages) {
      if (m.role === "user" && m.surfaceAction)
        submits.add(`${m.surfaceAction.surfaceId}\n${m.surfaceAction.componentId}`);
      for (const p of m.parts ?? []) if (p.type === "surface") titles.set(p.surface.surfaceId, p.surface.title);
    }
    return {
      sendAction,
      submitted: (surfaceId, componentId) => submits.has(`${surfaceId}\n${componentId}`),
      titleOf: (surfaceId) => titles.get(surfaceId),
      ...(full ? { inspect: (surfaceId: string) => openInspector(null, null, surfaceId) } : {}),
    };
  }, [state.messages, sendAction, full, openInspector]);
  // Surfaces a worker is still updating; the header shows them so a reader scrolled away knows something is moving.
  const liveSurfaces = useMemo(() => {
    const live = new Map<string, string>();
    for (const m of state.messages)
      for (const p of m.parts ?? [])
        if (p.type === "surface" && p.surface.state === "live")
          live.set(p.surface.surfaceId, p.surface.feed?.title ?? p.surface.title);
    return [...live.values()];
  }, [state.messages]);

  // Both modes use step summaries; only Full mode opens execution details in the inspector.
  const traceRev = useMemo(
    () =>
      `${state.messages.map((m) => `${m.id}:${m.status}`).join("|")}#${state.runs.map((r) => `${r.id}:${r.status}`).join("|")}`,
    [state.messages, state.runs],
  );
  const trace = useTrace(api, sessionId, state.ready, traceRev);
  // The transcript and its run traces are one region, held shut until both have landed: what arrives with them was already
  // there, while anything a run produces afterwards arrives.
  const regionLive = useRegionLive(sessionId, !state.ready || !trace.loaded);
  // Opening a chat: the transcript, then its step rows, then late sizing (colour, diagrams, images) each move the text.
  // Show it once, settled and pinned to the bottom, fading in; never hold it for more than a moment if a load stalls.
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setGaveUp(true), OPEN_HOLD_MS);
    return () => window.clearTimeout(t);
  }, []);
  const settling = !regionLive && !gaveUp && !trace.error;
  const stepRuns = useMemo(() => {
    const byAnchor = new Map<string, RunTrace[]>();
    for (const t of [...trace.runs].reverse()) {
      const anchor =
        (t.triggerMessageId && state.messages.some((m) => m.id === t.triggerMessageId)
          ? t.triggerMessageId
          : state.messages.find((m) => m.runId === t.run.id)?.id) ?? null;
      if (anchor) byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), t]);
    }
    return byAnchor;
  }, [trace.runs, state.messages]);

  const children = useMemo(
    () => (sessions ? childrenOf(sessions, sessionId).sort(byUnfinishedThenNewest) : []),
    [sessions, sessionId],
  );
  const unfinished = children.filter(isUnfinished).length;
  const hasBranches = sessions ? branchesOf(sessions, sessionId).length > 0 : false;
  const canDelete = !!session && session.origin !== "home";
  // A home chat deletes its whole agent instead; the server refuses the default agent.
  const canDeleteAgent = !!session && session.origin === "home" && !!agent && agent.id !== defaultAgentId;

  async function confirmDeletion(withForks: boolean) {
    setDeleting(true);
    setDeleteError(null);
    onLocalDelete?.(sessionId, true);
    try {
      await api.deleteSession(sessionId, { withForks });
      onNavigate?.(null);
    } catch (e) {
      onLocalDelete?.(sessionId, false);
      setDeleteError(describeError(e));
      setDeleting(false);
    }
  }

  async function confirmAgentDeletion() {
    if (!agent) return;
    setAgentDeleting(true);
    setAgentDeleteError(null);
    onLocalDelete?.(sessionId, true);
    try {
      await api.deleteAgent(agent.id);
      onNavigate?.(null);
    } catch (e) {
      onLocalDelete?.(sessionId, false);
      setAgentDeleteError(describeError(e));
      setAgentDeleting(false);
    }
  }
  const cancelAgentDeletion = () => {
    setConfirmAgentDelete(false);
    setAgentDeleteError(null);
  };
  const openPermissions = () => {
    setPermsError(null);
    setPermsOpen(true);
  };
  const closePermissions = () => {
    setPermsOpen(false);
    setPermsError(null);
  };
  async function savePermissions(profile: ProfileName) {
    setSavingPerms(true);
    setPermsError(null);
    try {
      await api.updateSession(sessionId, { profile });
      setPermsOpen(false);
    } catch (e) {
      setPermsError(describeError(e));
    } finally {
      setSavingPerms(false);
    }
  }
  const decide = useCallback(
    (approvalId: string, req: DecideApprovalRequest) => api.decideApproval(approvalId, req).then((r) => r.approval),
    [api],
  );
  const decideGroup = useCallback<DecideGroupFn>(
    (id, req) => api.decideApprovalGroup(id, req).then((result) => result.approvals),
    [api],
  );
  const undoMemory = useCallback<UndoChangeFn>(
    (changeId) => api.undoMemoryChange(changeId).then((r) => r.change),
    [api],
  );
  const memory = useMemo<MemoryHandlers>(
    () => ({
      onUndo: undoMemory,
      agentName: (id) => agents.find((a) => a.id === id)?.name,
    }),
    [undoMemory, agents],
  );
  const cancelDeletion = () => {
    setConfirmDelete(false);
    setDeleteError(null);
  };
  const endTakeover = useCallback(
    (takeoverId: string, req: EndTakeoverRequest) => api.endTakeover(takeoverId, req).then((r) => r.takeover),
    [api],
  );
  // Newest first, in a ref so a trace reload doesn't redraw every message.
  const traceRuns = useRef(trace.runs);
  traceRuns.current = trace.runs;
  const fullHandlers = useMemo<FullHandlers | undefined>(
    () =>
      full
        ? {
            // A reply that was continued opens at the latest run that wrote it, not at the one that failed.
            onInspect: (runId) =>
              openInspector(
                traceRuns.current.find((t) => t.run.id === runId || t.triggerMessageId === `u:${runId}`)?.run.id ??
                  runId,
              ),
            onFork: (messageId) => setForkAt({ messageId }),
          }
        : undefined,
    [full, openInspector],
  );
  const takeoverPending = session?.browser?.takeover?.status === "pending";
  const openLook = () => setLookOpen(true);
  const closeLook = () => setLookOpen(false);
  const failedSend = state.pending.find((p) => p.error);

  // The read marker every device shares moves once the end of the chat is on screen: at the bottom of the chat, or the
  // floating card open while the browser covers the chat.
  const [floatOpen, setFloatOpen] = useState(false);
  useReadMarker(api, session, state.messages, focusView ? floatOpen : !showJump);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    atBottom.current = near;
    setShowJump(!near);
  };
  const scrollToBottom = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Follow new content only if the user was already at the bottom (or just sent something). Settled content eases into
  // place; text still streaming snaps, because a smooth scroll fighting a stream reads as lag. Opening a chat never
  // eases: a transcript that is still arriving page by page must be at its newest message, not gliding down to it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after the list changed, which is what it follows.
  useLayoutEffect(() => {
    const rows = state.messages.length + state.pending.length;
    const arrived = rows > rowCount.current;
    rowCount.current = rows;
    if (!(atBottom.current || forceScroll.current)) return;
    const el = scroller.current;
    if (el) {
      // Only a new row eases in. A reply that merely finished (caret gone, last tweaks) is already in place: gliding then
      // reads as the text drifting after it settled.
      const ease =
        arrived && !opening.current && !running && !prefersReducedMotion() && typeof el.scrollTo === "function";
      if (ease) {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        easingUntil.current = performance.now() + EASE_MS;
      } else el.scrollTop = el.scrollHeight;
    }
    // Opening lasts until the chat actually has a transcript to follow: an empty first pass must not use it up.
    if (state.ready) opening.current = false;
    forceScroll.current = false;
    atBottom.current = true;
  }, [state.messages, state.pending, trace.runs, running]);

  useEffect(() => {
    atBottom.current = true;
    opening.current = true;
  }, [sessionId]);

  // Content that grows between renders (a code block coloured on load, a diagram drawn, an image arriving) must not leave
  // the reader's view stranded above the end. The observer fires in the frame the layout changed, before it paints, so
  // the tail is pinned without a visible step. Only while the reader is at the bottom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list element appears once the chat has loaded.
  useEffect(() => {
    const el = scroller.current;
    const list = el?.querySelector(".msg-list");
    if (!el || !list || typeof ResizeObserver === "undefined") return;
    let settle = 0;
    const pin = () => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    };
    const observer = new ResizeObserver(() => {
      const left = easingUntil.current - performance.now();
      if (left <= 0) return pin();
      // Re-check once the glide is over, so growth that landed during it is still followed.
      window.clearTimeout(settle);
      settle = window.setTimeout(pin, left + 20);
    });
    observer.observe(list);
    return () => {
      window.clearTimeout(settle);
      observer.disconnect();
    };
  }, [sessionId, state.ready, missing]);

  // Opened at a message (a link from the Memory page): scroll to it once the chat has loaded, and mark it for a moment. This
  // runs after the follow-the-bottom effect above, so it wins; staying off the bottom keeps the new messages from pulling away.
  const rows = useMemo(() => groupMessages(liftApprovalCards(state.messages)), [state.messages]);
  // Simple mode leaves out the bookkeeping: approvals you gave, memory chips, and the assistant's follow-ups about saving memory.
  const outcomes = useMemo(() => approvalOutcomes(state.messages), [state.messages]);
  const parked = useMemo(() => parkedCalls(state.live), [state.live]);
  const waitingRuns = useMemo(() => {
    const ids = new Set<string>();
    for (const { approval, runId } of state.messages) {
      if (runId && approval?.status === "pending" && (approval.resumesTool || approval.groupId)) ids.add(runId);
    }
    return ids;
  }, [state.messages]);
  const quietRuns = useMemo(
    () => (full ? new Set<string>() : quietRunIds(trace.runs, outcomes, state.messages)),
    [full, trace.runs, outcomes, state.messages],
  );
  const liveCalls = useMemo(() => nestedLiveCalls(state.live), [state.live]);
  // A card a script's call asked for goes under that script's row, in the activity of the run that drew the row.
  const scriptAsks = useMemo(() => {
    const scripts = new Set<string>();
    for (const runs of stepRuns.values())
      for (const t of runs)
        if (!quietRuns.has(t.run.id))
          for (const s of t.steps) if (isScriptStep(s) && s.toolCallId) scripts.add(s.toolCallId);
    return scriptCards(state.messages, scripts);
  }, [stepRuns, quietRuns, state.messages]);
  const underScripts = useMemo(
    () => new Set([...scriptAsks.values()].flatMap((cards) => cards.map((m) => m.id))),
    [scriptAsks],
  );
  const scriptCardList = useMemo(
    () => ({
      byScript: scriptAsks,
      render: (m: Message) => (
        <MessageItem
          message={m}
          onDecide={decide}
          approvalAgentName={m.approval && agents.find((a) => a.id === m.approval?.agentId)?.name}
        />
      ),
    }),
    [scriptAsks, decide, agents],
  );
  const shownRows = useMemo(
    () =>
      (full ? rows : rows.filter((g) => g.kind === "message" && !isSimpleNoise(g.message, quietRuns))).filter(
        (g) => g.kind !== "message" || !underScripts.has(g.message.id),
      ),
    [full, rows, quietRuns, underScripts],
  );
  const floatingMessages = useMemo(
    () => shownRows.flatMap((row) => (row.kind === "message" ? [row.message] : [])),
    [shownRows],
  );
  const groups = useMemo(
    () =>
      approvalGroups(
        rows.flatMap((row) => (row.kind === "message" && row.message.approval ? [row.message.approval] : [])),
      ),
    [rows],
  );
  const failure = continuable(state);
  const failureInTranscript =
    failure?.runId &&
    shownRows.some(
      (row) =>
        row.kind === "message" &&
        row.message.runId === failure.runId &&
        row.message.status === "error" &&
        row.message.error?.message === failure.error.message,
    );
  // What the run is doing that its reply doesn't show yet: a retry after a failed model call, or a summary being made.
  const liveNote =
    state.live?.compaction?.status === "running"
      ? "Summarizing earlier messages…"
      : state.live?.generation?.retry
        ? `Retrying (attempt ${state.live.generation.retry.attempt})…`
        : state.live?.compaction?.status === "failed"
          ? "Couldn't summarize earlier messages."
          : null;
  const focusHandled = useRef<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useLayoutEffect(() => {
    if (!focusMessageId || !state.ready || focusHandled.current === focusMessageId) return;
    // A run of memory chips is one row, marked with its first message's id.
    const row = rows.find((g) =>
      g.kind === "chips" ? g.messages.some((m) => m.id === focusMessageId) : g.message.id === focusMessageId,
    );
    const id = row && (row.kind === "chips" ? row.messages[0]!.id : row.message.id);
    const el = id
      ? [...(scroller.current?.querySelectorAll<HTMLElement>(".msg-list > li[data-msg-id]") ?? [])].find(
          (li) => li.dataset.msgId === id,
        )
      : null;
    if (!el) return;
    focusHandled.current = focusMessageId;
    atBottom.current = false;
    el.scrollIntoView?.({ block: "center" });
    el.setAttribute("data-flash", "true");
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => el.removeAttribute("data-flash"), FLASH_MS);
  }, [focusMessageId, state.ready, rows]);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const live = useMemo(() => liveStatus(state.messages), [state.messages]);
  const latestReplyId = useMemo(
    () => state.messages.findLast((m) => m.role === "assistant" && !isSimpleNoise(m, quietRuns))?.id,
    [state.messages, quietRuns],
  );

  return (
    <section className="chat relative flex min-h-0 flex-1 flex-col" aria-label="Chat">
      <header
        className="chat-header flex min-h-16 items-center gap-3 border-b bg-background px-6 pb-2 pt-[calc(0.5rem+var(--safe-t))] max-md:gap-1 max-md:px-3"
        hidden={focusView}
        inert={!wide && !!inspect}
      >
        <Tip label="Back to chats">
          <Button
            variant="ghost"
            size="icon-sm"
            className="back -ml-2 text-muted-foreground max-md:size-11 md:hidden"
            onClick={onBack}
            aria-label="Back to chats"
          >
            <Icon name="back" />
          </Button>
        </Tip>
        {agent && session && (
          <Tip label="Change look">
            <button
              type="button"
              className="avatar-btn inline-grid size-9 shrink-0 place-items-center rounded-full max-md:size-11 outline-none focus-visible:ring-3 focus-visible:ring-ring/40 hover:[&_.avatar]:shadow-[0_0_0_3px_var(--accent)]"
              aria-label={`Change ${agent.name}'s look`}
              onClick={openLook}
            >
              <Avatar value={agent.avatar} size={30} working={running} />
            </button>
          </Tip>
        )}
        <div className="chat-title flex min-w-0 flex-1 flex-col justify-center gap-px">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-base font-semibold tracking-tight">
              {session?.title ?? (missing ? "Chat not found" : "")}
            </h2>
            {liveSurfaces.length > 0 && (
              <Tip label={`Updating from ${liveSurfaces.join(", ")}`}>
                <span className="srf-state shrink-0" data-state="live" role="status">
                  <span className="srf-live-dot" aria-hidden="true" />
                  {liveSurfaces.length > 1 ? `${liveSurfaces.length} live` : "Live"}
                </span>
              </Tip>
            )}
          </div>
          {session?.origin === "trigger" ? (
            <span className="chat-sub chat-origin block min-w-0 truncate text-xs text-muted-foreground">
              {session.triggerId ? (
                <TriggerRunOf api={api} triggerId={session.triggerId} />
              ) : (
                "Run of a deleted trigger"
              )}
            </span>
          ) : (
            agent &&
            session &&
            session.origin !== "home" && (
              <Tip label={`${agent.name} settings`}>
                <button
                  type="button"
                  className="chat-sub chat-sub-btn self-start truncate rounded-sm text-start text-xs text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 max-md:hidden"
                  aria-label={`${agent.name} settings`}
                  onClick={() => setSettingsOpen(true)}
                >
                  {agent.name}
                </button>
              </Tip>
            )
          )}
        </div>
        <ConnectionBadge status={status} name="Chat" />
        {session?.browser && (
          <Tip label={takeoverPending ? "Browser, needs you" : "Browser"}>
            <Button
              ref={panels.browserBtn}
              variant="ghost"
              size="icon-sm"
              className="browser-btn relative text-muted-foreground max-md:size-11"
              aria-label={takeoverPending ? "Browser, needs you" : "Browser"}
              aria-expanded={panels.side.kind === "browser"}
              aria-controls={panels.side.kind === "browser" ? browserId : undefined}
              onClick={panels.toggleBrowser}
            >
              <Icon name="globe" />
              {takeoverPending && (
                <span
                  className="attention-dot absolute right-1.5 top-1.5 size-2 rounded-full bg-attention ring-2 ring-background"
                  aria-hidden="true"
                />
              )}
            </Button>
          </Tip>
        )}
        {children.length > 0 && (
          <Tip label="Sessions">
            <Button
              ref={panels.sessionsBtn}
              variant="ghost"
              size="icon-sm"
              className="sessions-btn relative text-muted-foreground max-md:size-11"
              aria-label="Sessions"
              aria-expanded={panels.sessionsOpen}
              aria-controls={panels.sessionsOpen ? panelId : undefined}
              aria-describedby={unfinished > 0 ? unfinishedId : undefined}
              onClick={panels.toggleSessions}
            >
              <Icon name="sessions" />
              {unfinished > 0 && (
                <>
                  <span
                    className="count-badge absolute right-0 top-0 h-4 min-w-4 rounded-full bg-primary px-1 text-center text-[0.6875rem] font-semibold leading-4 text-primary-foreground"
                    aria-hidden="true"
                  >
                    {unfinished}
                  </span>
                  <span id={unfinishedId} className="sr-only">
                    {unfinished} unfinished
                  </span>
                </>
              )}
            </Button>
          </Tip>
        )}
        {session && (
          <DropdownMenu>
            <Tip label="Chat options">
              <DropdownMenuTrigger asChild>
                <Button
                  ref={optionsBtn}
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground max-md:size-11"
                  aria-label="Chat options"
                >
                  <Icon name="more" />
                </Button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent
              align="end"
              className="w-56"
              aria-label="Chat options"
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                optionsBtn.current?.focus();
                // The chosen dialog remembers the menu button, so it can return focus there.
                const pick = menuPick.current;
                menuPick.current = null;
                if (pick) setTimeout(pick, 0);
              }}
            >
              {agent && (
                <DropdownMenuItem
                  onSelect={() => {
                    menuPick.current = () => setSettingsOpen(true);
                  }}
                >
                  <Icon name="sliders" size={16} /> Agent settings
                </DropdownMenuItem>
              )}
              {full && (
                <DropdownMenuItem
                  onSelect={() => {
                    menuPick.current = () => openInspector(null);
                  }}
                >
                  <Icon name="search" size={16} /> Inspect chat
                </DropdownMenuItem>
              )}
              {canDeleteAgent && (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    menuPick.current = () => setConfirmAgentDelete(true);
                  }}
                >
                  <Icon name="trash" size={16} /> Delete agent
                </DropdownMenuItem>
              )}
              {canDelete && (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    menuPick.current = () => setConfirmDelete(true);
                  }}
                >
                  <Icon name="trash" size={16} /> Delete chat
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {onNewChat && (
          <Tip label="New chat">
            <Button
              variant="ghost"
              size="icon-sm"
              className="mobile-only -mr-2 text-muted-foreground max-md:size-11 md:hidden"
              onClick={onNewChat}
              aria-label="New chat"
            >
              <Icon name="compose" />
            </Button>
          </Tip>
        )}
      </header>
      {session && !focusView && <ContextLine session={session} sessions={sessions} />}

      <div className="chat-body flex min-h-0 min-w-0 flex-1">
        <div
          className="chat-main relative flex min-h-0 min-w-0 flex-1 flex-col"
          data-enter="fade"
          hidden={focusView}
          inert={!wide && !!inspect}
        >
          {missing && !state.ready ? (
            <div className="empty grid flex-1 place-content-center justify-items-center gap-3.5 p-6 text-center text-muted-foreground [&_p]:m-0">
              <p>This chat doesn't exist or was removed.</p>
              <Button type="button" variant="secondary" size="sm" onClick={onBack}>
                Back to chats
              </Button>
            </div>
          ) : (
            <>
              <div
                className="messages flex-1 overflow-y-auto overscroll-contain px-6 py-9 md:[scrollbar-gutter:stable_both-edges] focus-visible:outline-none max-md:px-3.5 max-md:py-5"
                ref={scroller}
                onScroll={onScroll}
                tabIndex={0}
                role="log"
                aria-label="Messages"
                aria-live="off"
              >
                {state.ready && state.messages.length === 0 && state.pending.length === 0 && (
                  <div className="hero mx-auto flex max-w-lg flex-col items-center gap-3 px-4 pt-[14vh] text-center max-md:pt-[10vh]">
                    {agent && <Avatar value={agent.avatar} size={48} />}
                    <h3 className="text-[clamp(1.625rem,4vw,2rem)] font-semibold leading-tight tracking-tight">
                      {agent && session?.origin === "home" ? `Hi, I'm ${agent.name}.` : "What's on your mind?"}
                    </h3>
                  </div>
                )}
                {!state.ready && !missing && (
                  <p className="mx-auto max-w-(--col) py-8 text-center text-sm text-muted-foreground" role="status">
                    Loading chat…
                  </p>
                )}
                <SurfaceContext.Provider value={surfaces}>
                  <MotionRegion live={regionLive}>
                    <ol
                      data-opening={settling ? "true" : undefined}
                      className="msg-list mx-auto flex max-w-(--col) list-none flex-col gap-6 p-0 max-md:gap-[22px] [&>.msg-user:not(:first-child)]:mt-3"
                    >
                      {state.before && (
                        <li className="msg messages-earlier text-center">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground"
                            disabled={loadingEarlier}
                            onClick={earlier}
                          >
                            {loadingEarlier ? "Loading…" : "Load earlier messages"}
                          </Button>
                        </li>
                      )}
                      {trace.hasOlder && trace.loaded && (
                        <li className="msg activity-older text-center">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground"
                            disabled={trace.loadingOlder}
                            onClick={trace.loadOlder}
                          >
                            {trace.loadingOlder ? "Loading activity…" : "Load earlier activity"}
                          </Button>
                        </li>
                      )}
                      {shownRows.map((g) => {
                        const request = g.kind === "message" ? g.message.approval : undefined;
                        const group = request?.groupId ? groups.get(request.groupId) : undefined;
                        if (g.kind === "message" && request?.groupId && group) {
                          if (group[0]?.id !== request.id) return null;
                          return (
                            <ApprovalGroupCard
                              key={request.groupId}
                              id={request.groupId}
                              approvals={group}
                              chatSessionId={sessionId}
                              messageId={g.message.id}
                              agentName={agents.find((a) => a.id === request.agentId)?.name}
                              onDecide={decideGroup}
                            />
                          );
                        }
                        return g.kind === "chips" ? (
                          <MemoryChipRow
                            key={g.messages[0]!.id}
                            messages={g.messages}
                            onUndo={undoMemory}
                            agentName={memory.agentName}
                          />
                        ) : (
                          <Fragment key={g.message.id}>
                            <MessageItem
                              message={g.message}
                              onBranch={branch}
                              onEdit={edit}
                              onVersion={switchVersion}
                              full={fullHandlers}
                              onDecide={decide}
                              onUseAsDraft={(message) => composer.current?.restoreDraft(message)}
                              waitingForApproval={g.message.runId !== null && waitingRuns.has(g.message.runId)}
                              approvalAgentName={
                                g.message.approval && agents.find((a) => a.id === g.message.approval?.agentId)?.name
                              }
                              onTakeOver={panels.takeOver}
                              onOpenBrowser={panels.showBrowser}
                              onEndTakeover={endTakeover}
                              memory={memory}
                              latest={g.message.id === latestReplyId}
                            />
                            {stepRuns
                              .get(g.message.id)
                              ?.filter((t) => !quietRuns.has(t.run.id))
                              .map((t) => (
                                <ToolActivity
                                  key={t.run.id}
                                  trace={t}
                                  outcomes={outcomes}
                                  waitingForApproval={waitingRuns.has(t.run.id)}
                                  parked={parked}
                                  liveCalls={liveCalls}
                                  cards={scriptCardList}
                                  onOpen={full ? (runId, stepId) => openInspector(runId, stepId) : undefined}
                                />
                              ))}
                          </Fragment>
                        );
                      })}
                      {state.pending.map((p) => (
                        <PendingItem sessionId={sessionId} key={p.requestId} pending={p} onRetry={retry} />
                      ))}
                      {liveNote && (
                        <li className="msg msg-live text-center" role="status">
                          <p className="m-0 text-sm text-muted-foreground">{liveNote}</p>
                        </li>
                      )}
                      {failure && (
                        <li className="msg msg-continue flex flex-col items-center gap-2 text-center">
                          {!failureInTranscript && (
                            <p
                              className="m-0 flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2.5 text-left text-sm text-destructive"
                              role="alert"
                            >
                              <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
                              <span>{describeErrorInfo(failure.error)}</span>
                            </p>
                          )}
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={continuing}
                            onClick={continueRun}
                          >
                            {continuing ? "Continuing…" : "Continue"}
                          </Button>
                        </li>
                      )}
                    </ol>
                  </MotionRegion>
                </SurfaceContext.Provider>
              </div>
              {actionError && (
                <p role="alert" className="form-error banner">
                  {actionError}
                </p>
              )}
              {/* Anchored to the composer's top edge, so it clears the composer whatever height the composer is. */}
              <div className="relative">
                {showJump && (
                  <Tip label="Jump to latest">
                    <Button
                      variant="outline"
                      size="icon"
                      className="jump absolute bottom-full left-1/2 z-10 mb-3 -translate-x-1/2 bg-popover shadow-md hover:bg-muted"
                      aria-label="Jump to latest"
                      onClick={() => {
                        scrollToBottom();
                        atBottom.current = true;
                        setShowJump(false);
                      }}
                    >
                      <Icon name="down" />
                    </Button>
                  </Tip>
                )}
                <Composer
                  settings={
                    session && (
                      <ComposerSettings
                        api={api}
                        agent={agent}
                        session={session}
                        permissionRef={profileBtn}
                        onPermissions={openPermissions}
                      />
                    )
                  }
                  contextRevision={traceRev}
                  api={api}
                  sessionId={sessionId}
                  sessions={sessions}
                  agents={agents}
                  allowedConnectorIds={agent?.allowedConnectorIds}
                  onSend={send}
                  whenBusy={whenBusy}
                  onCompact={compact}
                  compaction={state.live?.manualCompaction}
                  onStop={stop}
                  hasQueuedMessages={state.runs.some((run) => run.status === "queued")}
                  draftRef={composer}
                  running={running}
                  stopping={stopping}
                  placeholder={agent ? `Message ${agent.name}` : "Message"}
                />
              </div>
            </>
          )}
        </div>
        {/* Outside the chat column so approvals are still announced while it is hidden. */}
        <div role="status" aria-live="polite" className="sr-only">
          {live}
        </div>
        {panels.sessionsOpen && children.length > 0 && (
          <SessionsPanel id={panelId} sessions={children} onClose={panels.closeSessions} />
        )}
        {inspect && full && session && (
          <Inspector
            key={inspect.nonce}
            id={inspectId}
            api={api}
            session={session}
            agent={agent}
            sessions={sessions}
            trace={trace}
            messages={state.messages}
            focus={inspect}
            onClose={closeInspector}
          />
        )}
        {browserOpen && session && (
          <BrowserPanel
            id={browserId}
            api={api}
            session={session}
            startSignal={browserAutoStart}
            onClose={closeBrowser}
            layout={browserLayout}
            onToggleExpand={wide ? toggleExpanded : undefined}
          />
        )}
      </div>
      {focusView && session && (
        <FloatingAssistant
          onOpenChange={setFloatOpen}
          agent={agent}
          session={session}
          messages={floatingMessages}
          earlierCursor={state.before}
          loadingEarlier={loadingEarlier}
          onLoadEarlier={loadEarlier}
          running={running}
          stopping={stopping}
          onSend={send}
          onStop={() => void stop()}
          onDecide={decide}
          onDecideGroup={decideGroup}
          onEndTakeover={endTakeover}
          onTakeOver={panels.takeOver}
          onChangeLook={() => openLook()}
          failed={failedSend}
          onRetry={retry}
        />
      )}
      {lookOpen && agent && <AvatarPicker agent={agent} api={api} onClose={closeLook} />}
      {settingsOpen && agent && (
        <AgentSettingsDialog
          agent={agent}
          api={api}
          onClose={() => setSettingsOpen(false)}
          onChangeLook={() => {
            setSettingsOpen(false);
            openLook();
          }}
        />
      )}
      {forkAt && session && (
        <ForkDialog
          api={api}
          sessionId={sessionId}
          at={forkAt}
          onCancel={() => setForkAt(null)}
          onForked={(id) => {
            setForkAt(null);
            onNavigate?.(id);
          }}
        />
      )}

      {permsOpen && session && (
        <PermissionsDialog
          fallbackFocus={profileBtn}
          current={session.profile ?? "standard"}
          origin={session.origin}
          busy={savingPerms}
          error={permsError}
          onCancel={closePermissions}
          onSave={(p) => void savePermissions(p)}
        />
      )}
      {confirmDelete && session && (
        <DeleteDialog
          title={session.title}
          hasBranches={hasBranches}
          hasSpawned={children.length > 0}
          busy={deleting}
          error={deleteError}
          onCancel={cancelDeletion}
          onConfirm={(withForks) => void confirmDeletion(withForks)}
        />
      )}
      {confirmAgentDelete && agent && (
        <ConfirmDialog
          title={`Delete ${agent.name}?`}
          description={
            <p>
              {agent.name} and all of its chats, triggers, permissions and memory will be removed. This can't be undone.
            </p>
          }
          error={agentDeleteError}
          busy={agentDeleting}
          confirmLabel="Delete"
          busyLabel="Deleting…"
          onCancel={cancelAgentDeletion}
          onConfirm={() => void confirmAgentDeletion()}
        />
      )}
    </section>
  );
}

const unfinishedFirst = (s: Session) => (isUnfinished(s) ? 0 : 1);
const byUnfinishedThenNewest = (a: Session, b: Session) =>
  unfinishedFirst(a) - unfinishedFirst(b) || b.updatedAt - a.updatedAt;

/** "Run of <trigger name>", linking to the trigger; the name is fetched, since a session only carries the trigger's id. */
function TriggerRunOf({ api, triggerId }: { api: Api; triggerId: string }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getTrigger(triggerId).then(
      (r) => !cancelled && setName(r.trigger.name),
      () => {}, // the line just says "a trigger"
    );
    return () => {
      cancelled = true;
    };
  }, [api, triggerId]);
  return (
    <>
      Run of <a href={triggerHref(triggerId)}>{name ?? "a trigger"}</a>
    </>
  );
}

/** Where this chat came from, when it isn't a plain chat: a session an agent started, or a branch. (A trigger's run says so in the header.) */
function ContextLine({ session, sessions }: { session: Session; sessions: Session[] | undefined }) {
  const link = (id: string, title: string) => <a href={`/s/${encodeURIComponent(id)}`}>{title}</a>;
  let content: React.ReactNode = null;
  if (session.origin === "spawned") {
    const parent = session.parentSessionId ? sessions?.find((s) => s.id === session.parentSessionId) : undefined;
    if (session.parentSessionId === null) content = "Started by a deleted chat";
    else if (parent) content = <>Started by {link(parent.id, parent.title)}</>;
    else if (sessions) content = <>Started by {link(session.parentSessionId, "another chat")}</>;
  } else if (session.origin === "fork" && session.forkedFrom) {
    const from = session.forkedFrom;
    const source = sessions?.find((s) => s.id === from.sessionId);
    // Chats from the earlier Edit and Retry (which opened a new chat) say so; a fork taken at a step (Full mode) too.
    const verb = from.edited
      ? from.retried
        ? "Retried from"
        : "Edited from"
      : from.stepId
        ? "Forked from"
        : "Branched from";
    if (source)
      content = (
        <>
          {verb} <a href={sessionHref(source.id, from.onAnotherVersion ? undefined : from.messageId)}>{source.title}</a>
          {from.onAnotherVersion && " (on another version of this chat)"}
        </>
      );
    else if (sessions) content = `${verb} a deleted chat`;
  }
  // The taint labels are policy bookkeeping, not something to read in Simple mode; an approval card says what matters.
  if (!content) return null;
  return (
    <div className="chat-context flex flex-wrap items-center gap-x-3.5 gap-y-1 border-b border-sidebar-border bg-sidebar px-4 py-1.5 text-xs text-muted-foreground max-md:px-3.5">
      <p className="context-origin m-0 flex min-w-0 items-center gap-1.5">
        <Icon name={session.origin === "fork" ? "branch" : "spawned"} size={14} />
        <span className="min-w-0 truncate [&_a]:text-foreground">{content}</span>
      </p>
    </div>
  );
}
