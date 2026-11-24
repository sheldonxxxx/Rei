import type { Agent, Approval, Message, Session, Takeover } from "@rei/protocol";
import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { cn } from "@/lib/utils.ts";
import { describeError } from "../api/client.ts";
import { approvalGroups } from "../lib/approvals.ts";
import { assistantStatus, firstLine, latestAssistant, waitingFor } from "../lib/assistant.ts";
import { useStoredFlag } from "../lib/storage.ts";
import type { PendingMessage } from "../state/session.ts";
import type { DecideFn } from "./ApprovalCard.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { ApprovalGroupCard, type DecideGroupFn } from "./ApprovalGroupCard.tsx";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import type { EndTakeoverFn } from "./TakeoverCard.tsx";
import { TakeoverCard } from "./TakeoverCard.tsx";
import { Thinking } from "./Thinking.tsx";
import { Tip } from "./Tip.tsx";

const MINIMIZED_KEY = "rei:assistant-minimized";
const EXPANDED_KEY = "rei:assistant-expanded";
const PEEK_MS = 4000;
const STICK_SLACK = 40;

interface Props {
  agent: Agent | undefined;
  session: Session;
  messages: Message[];
  earlierCursor?: string | null | undefined;
  loadingEarlier?: boolean | undefined;
  onLoadEarlier?: (() => Promise<void>) | undefined;
  running: boolean;
  stopping: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onDecide: DecideFn;
  onDecideGroup?: DecideGroupFn | undefined;
  onEndTakeover: EndTakeoverFn;
  /** "Take over" on the agent's request: opens the takeover in the browser view that is already showing. */
  onTakeOver: () => void;
  onChangeLook: () => void;
  /** The newest send that failed, with a way to try it again. */
  failed?: PendingMessage | undefined;
  onRetry?: ((p: PendingMessage) => void) | undefined;
  /** Told whether the card is open (its latest reply on screen) or folded into the bot. */
  onOpenChange?: ((open: boolean) => void) | undefined;
}

/**
 * The assistant while the chat is hidden (the browser expanded, or a phone's browser sheet): a card in the corner with
 * what it is doing, its latest reply as it streams, whatever waits for you, and one line to talk to it. It folds into a
 * small bot that peeks when something new arrives. It never takes the keyboard on its own: only its own field does,
 * when you focus it, so a takeover's typing goes to the page.
 */
export function FloatingAssistant({
  agent,
  session,
  messages,
  earlierCursor,
  loadingEarlier,
  onLoadEarlier,
  running,
  stopping,
  onSend,
  onStop,
  onDecide,
  onDecideGroup,
  onEndTakeover,
  onTakeOver,
  onChangeLook,
  failed,
  onRetry,
  onOpenChange,
}: Props) {
  const [minimized, setMinimized] = useStoredFlag(MINIMIZED_KEY);
  // Expanded: a taller, wider card showing the loaded conversation.
  const [expanded, setExpanded] = useStoredFlag(EXPANDED_KEY);
  const name = agent?.name ?? "Assistant";
  const look = agent?.avatar ?? "bot:sprout";

  const latest = latestAssistant(messages);
  const { approvals, takeover } = useMemo(() => waitingFor(messages, session), [messages, session]);
  const waiting = approvals.length + (takeover ? 1 : 0);
  const status = assistantStatus({ waiting, running, session });

  // ---- what arrives while minimized ----
  // Unread is the server's count (the read marker every device shares); a new reply also peeks while minimized.
  const unread = minimized && session.unread > 0;
  const [peekId, setPeekId] = useState<string | null>(null);
  const lastReplyId = useRef(latest?.id);
  useEffect(() => {
    const id = latest?.id;
    if (id === lastReplyId.current) return;
    lastReplyId.current = id;
    if (id && minimized) setPeekId(id);
  }, [latest?.id, minimized]);

  const line = firstLine(latest?.text);
  const peeking = minimized && peekId !== null && peekId === latest?.id && line !== "";
  useEffect(() => {
    if (!peeking) return;
    const t = setTimeout(() => setPeekId(null), PEEK_MS);
    return () => clearTimeout(t);
  }, [peeking]);

  // A new approval or takeover request needs you, so it brings the card back; a plain message only peeks.
  const needKey = [...approvals.map((a) => a.id), ...(takeover ? [takeover.id] : [])].join("|");
  const seenNeeds = useRef(new Set(needKey ? needKey.split("|") : []));
  useEffect(() => {
    const ids = needKey ? needKey.split("|") : [];
    const fresh = ids.some((id) => !seenNeeds.current.has(id));
    seenNeeds.current = new Set(ids);
    if (fresh) setMinimized(false);
  }, [needKey, setMinimized]);
  useEffect(() => {
    if (!minimized) setPeekId(null);
    onOpenChange?.(!minimized);
  }, [minimized, onOpenChange]);

  // Focus follows a click on Minimize or on the bot, but not an automatic restore.
  const focusNext = useRef<"card" | "bot" | null>(null);
  const minBtn = useRef<HTMLButtonElement>(null);
  const botBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next === "card") minBtn.current?.focus();
    if (next === "bot") botBtn.current?.focus();
  }, [minimized]);
  const minimize = () => {
    focusNext.current = "bot";
    setMinimized(true);
  };
  const restore = () => {
    focusNext.current = "card";
    setMinimized(false);
  };

  if (minimized) {
    const label = `Open ${name}: ${status.label}${status.detail ? ` ${status.detail}` : ""}${unread ? ", new message" : ""}`;
    const working = status.kind === "working";
    return (
      <div
        className="float-mini pointer-events-none fixed right-4 bottom-[calc(16px+var(--safe-b))] z-30 flex flex-col items-end gap-2 max-md:right-2.5 max-md:bottom-[calc(72px+var(--safe-b))] [&>*]:pointer-events-auto"
        data-working={working ? "true" : undefined}
        data-attention={status.kind === "needs" ? "true" : undefined}
      >
        {peeking && (
          <div
            className="float-peek max-w-[min(17rem,calc(100vw-32px))] cursor-pointer animate-[float-in_0.18s_ease-out] rounded-2xl rounded-br-sm bg-popover px-3 py-2 text-sm leading-snug text-popover-foreground shadow-lg ring-1 ring-foreground/10"
            role="status"
            onClick={restore}
          >
            <span className="float-peek-name block text-xs font-semibold text-muted-foreground">{name}</span>
            <span className="float-peek-line line-clamp-2 [overflow-wrap:anywhere]">{line}</span>
          </div>
        )}
        <Tip label={`${name} · ${status.label}`} side="left">
          <button
            ref={botBtn}
            type="button"
            className={cn(
              "float-bot relative grid size-14 cursor-pointer place-items-center rounded-full border bg-card p-0 shadow-sm transition-transform outline-none hover:scale-105 focus-visible:ring-3 focus-visible:ring-ring/40",
              working &&
                "animate-[float-bob_2.4s_ease-in-out_infinite] after:absolute after:-inset-[3px] after:animate-[float-ring_1.8s_ease-out_infinite] after:rounded-full after:border-2 after:border-foreground after:opacity-0",
              status.kind === "needs" && "border-attention-border shadow-[0_0_0_4px_var(--attention-soft)]",
            )}
            aria-label={label}
            onClick={restore}
            onContextMenu={(e) => {
              e.preventDefault();
              onChangeLook();
            }}
          >
            <Avatar value={look} size={44} working={working} />
            {waiting > 0 && (
              <span
                className="float-badge absolute -top-1 -right-1 h-5 min-w-5 rounded-full bg-attention-text px-1.5 text-center text-xs leading-5 font-bold text-background ring-2 ring-card"
                aria-hidden="true"
              >
                {waiting}
              </span>
            )}
            {unread && waiting === 0 && (
              <span
                className="float-unread absolute top-px right-px size-3 rounded-full bg-primary ring-2 ring-card"
                aria-hidden="true"
              />
            )}
          </button>
        </Tip>
      </div>
    );
  }

  return (
    <aside
      className="float-assistant fixed right-4 bottom-[calc(16px+var(--safe-b))] z-30 flex w-[min(22rem,calc(100vw-32px))] animate-[float-in_0.18s_ease-out] flex-col data-[expanded=true]:w-[min(36rem,calc(100vw-32px))] rounded-3xl bg-popover text-popover-foreground shadow-xl ring-1 ring-foreground/10 max-md:right-2.5 max-md:bottom-[calc(72px+var(--safe-b))] max-md:w-[min(18.5rem,calc(100vw-20px))]"
      aria-label={`${name}, the assistant`}
      data-waiting={waiting > 0 ? "true" : undefined}
      data-expanded={expanded ? "true" : undefined}
    >
      <Header
        name={name}
        look={look}
        status={status}
        minBtn={minBtn}
        onMinimize={minimize}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((v) => !v)}
      />
      <Body
        agent={agent}
        latest={latest}
        history={expanded ? messages : null}
        earlierCursor={earlierCursor}
        loadingEarlier={loadingEarlier}
        onLoadEarlier={onLoadEarlier}
        approvals={approvals}
        takeover={takeover}
        sessionId={session.id}
        onDecide={onDecide}
        onDecideGroup={onDecideGroup}
        onEndTakeover={onEndTakeover}
        onTakeOver={onTakeOver}
        waitingKey={needKey}
      />
      {failed && (
        <p
          role="alert"
          className="float-note mx-3.5 mt-0 mb-1.5 flex flex-wrap gap-x-2.5 gap-y-1 text-sm text-destructive"
        >
          <span>{failed.error ?? "Not sent."}</span>
          {onRetry && (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto p-0 text-destructive underline"
              onClick={() => onRetry(failed)}
            >
              Retry
            </Button>
          )}
        </p>
      )}
      <MiniComposer name={name} running={running} stopping={stopping} onSend={onSend} onStop={onStop} />
    </aside>
  );
}

function Header({
  name,
  look,
  status,
  minBtn,
  onMinimize,
  expanded,
  onToggleExpanded,
}: {
  name: string;
  look: string;
  status: ReturnType<typeof assistantStatus>;
  minBtn: React.RefObject<HTMLButtonElement | null>;
  onMinimize: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const tool = "text-muted-foreground";
  return (
    <header className="float-head flex items-center gap-0.5 pt-2.5 pr-1.5 pb-1.5 pl-3 [&>.avatar]:mr-2">
      <Avatar value={look} size={36} working={status.kind === "working"} />
      <div className="float-who flex min-w-0 flex-1 flex-col leading-snug">
        <strong className="float-name truncate text-sm font-semibold">{name}</strong>
        <span
          className="float-status truncate text-xs text-muted-foreground data-[kind=needs]:font-semibold data-[kind=needs]:text-attention-text"
          data-kind={status.kind}
          role="status"
        >
          <span className={cn("float-status-label", status.kind === "working" && "font-medium text-foreground")}>
            {status.label}
          </span>
          {status.detail && <span className="float-status-detail"> {status.detail}</span>}
        </span>
      </div>
      <Tip label={expanded ? "Collapse conversation" : "Expand conversation"}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={tool}
          aria-label={expanded ? "Collapse conversation" : "Expand conversation"}
          aria-pressed={expanded}
          onClick={onToggleExpanded}
        >
          <Icon name={expanded ? "collapse" : "expand"} size={18} />
        </Button>
      </Tip>
      <Tip label="Minimize">
        <Button
          ref={minBtn}
          type="button"
          variant="ghost"
          size="icon-sm"
          className={tool}
          aria-label="Minimize assistant"
          onClick={onMinimize}
        >
          <Icon name="minus" size={18} />
        </Button>
      </Tip>
    </header>
  );
}

function Body({
  agent,
  latest,
  history,
  earlierCursor,
  loadingEarlier,
  onLoadEarlier,
  approvals,
  takeover,
  sessionId,
  onDecide,
  onDecideGroup,
  onEndTakeover,
  onTakeOver,
  waitingKey,
}: {
  agent: Agent | undefined;
  latest: Message | undefined;
  /** The main chat's visible messages in display order. Null shows only the latest reply and pending cards. */
  history: Message[] | null;
  earlierCursor: string | null | undefined;
  loadingEarlier: boolean | undefined;
  onLoadEarlier: (() => Promise<void>) | undefined;
  approvals: ReturnType<typeof waitingFor>["approvals"];
  takeover: ReturnType<typeof waitingFor>["takeover"];
  sessionId: string;
  onDecide: DecideFn;
  onDecideGroup?: DecideGroupFn | undefined;
  onEndTakeover: EndTakeoverFn;
  onTakeOver: () => void;
  waitingKey: string;
}) {
  const groups = useMemo(
    () => approvalGroups(history ? history.flatMap((m) => (m.approval ? [m.approval] : [])) : approvals),
    [history, approvals],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const earlierAnchor = useRef<{ cursor: string; offset: number } | null>(null);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  const bodyId = useId();
  const streaming = latest?.status === "streaming";

  const rows = useMemo(() => (history ?? []).filter((m) => m.approval || m.takeover || isTurn(m)), [history]);
  // The pending takeover can reach the browser stream before its transcript entry.
  const extraTakeover = takeover && !rows.some((m) => m.takeover?.id === takeover.id) ? takeover : null;
  const compactWaiting = history === null && Boolean(waitingKey);
  const loadEarlier = async () => {
    const el = scroller.current;
    if (!el || !earlierCursor || !onLoadEarlier || loadingEarlier) return;
    earlierAnchor.current = { cursor: earlierCursor, offset: el.scrollHeight - el.scrollTop };
    setEarlierError(null);
    try {
      await onLoadEarlier();
    } catch (error) {
      earlierAnchor.current = null;
      setEarlierError(describeError(error));
    }
  };

  // Follow the newest exchange while at the bottom, and preserve the reader's position when prepending older messages.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const anchor = earlierAnchor.current;
    if (anchor && earlierCursor !== anchor.cursor) {
      earlierAnchor.current = null;
      if (history) {
        el.scrollTop = el.scrollHeight - anchor.offset;
        return;
      }
    }
    if (!compactWaiting && stick.current) el.scrollTop = el.scrollHeight;
  });
  // Only a new request or a return to compact mode should reveal the cards at the top.
  useLayoutEffect(() => {
    if (compactWaiting && waitingKey && scroller.current) scroller.current.scrollTop = 0;
  }, [compactWaiting, waitingKey]);

  const renderApproval = (approval: Approval) => {
    const group = approval.groupId ? groups.get(approval.groupId) : undefined;
    const agentName = agent?.id === approval.agentId ? agent?.name : undefined;
    if (approval.groupId && group && onDecideGroup) {
      if (approval.id !== group[0]?.id) return null;
      return (
        <ApprovalGroupCard
          key={approval.groupId}
          id={approval.groupId}
          approvals={group}
          agentName={agentName}
          chatSessionId={sessionId}
          onDecide={onDecideGroup}
        />
      );
    }
    return (
      <ApprovalCard
        key={approval.id}
        approval={approval}
        agentName={agentName}
        chatSessionId={sessionId}
        onDecide={onDecide}
      />
    );
  };
  const renderTakeover = (request: Takeover) => (
    <TakeoverCard
      key={request.id}
      takeover={request}
      chatSessionId={sessionId}
      onTakeOver={onTakeOver}
      onEnd={onEndTakeover}
    />
  );

  return (
    <div
      ref={scroller}
      id={bodyId}
      className={cn(
        "float-body max-h-[40dvh] overflow-y-auto data-[history=true]:h-[60dvh] data-[history=true]:max-h-[60dvh] overscroll-contain py-1 pr-2.5 pb-2.5 pl-3.5 text-[15px] [scrollbar-width:thin] focus-visible:outline-offset-[-2px] max-md:max-h-[34dvh] [&_.approval-facts]:[--dt:4.5rem] [&_.approval]:shadow-none",
        (approvals.length > 0 || takeover) && "max-h-[56dvh] max-md:max-h-[46dvh]",
      )}
      data-history={history ? "true" : undefined}
      tabIndex={0}
      role="region"
      aria-label={history ? "Conversation" : "Latest reply"}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLACK;
      }}
    >
      {compactWaiting && (
        <ul className="float-cards m-0 mb-2.5 flex list-none flex-col gap-2.5 p-0">
          {approvals.map(renderApproval)}
          {takeover && renderTakeover(takeover)}
        </ul>
      )}
      {history ? (
        rows.length > 0 || extraTakeover || earlierCursor || streaming ? (
          <ol className="float-history m-0 flex list-none flex-col gap-3 p-0">
            {earlierCursor && onLoadEarlier && (
              <li className="text-center">
                <Button type="button" variant="ghost" size="sm" disabled={loadingEarlier} onClick={loadEarlier}>
                  {loadingEarlier ? "Loading…" : "Load earlier messages"}
                </Button>
                {earlierError && (
                  <p role="alert" className="m-0 text-sm text-destructive">
                    {earlierError}
                  </p>
                )}
              </li>
            )}
            {rows.map((m) => {
              if (m.approval) return renderApproval(m.approval);
              if (m.takeover) return renderTakeover(m.takeover);
              return (
                <li
                  key={m.id}
                  data-role={m.role}
                  className={cn(
                    "float-turn [overflow-wrap:anywhere] [&_.md]:text-[15px] [&_.md_p]:mb-[0.7em]",
                    m.role === "user" &&
                      "max-w-[80%] self-end rounded-2xl bg-secondary px-4 py-2.5 text-[15px] text-secondary-foreground",
                    m.role !== "user" &&
                      "max-w-[95%] self-start rounded-2xl rounded-bl-sm bg-muted px-3 py-2 [&_.md>:last-child]:mb-0 [&_.md_p:last-child]:mb-0",
                  )}
                >
                  {m.role === "user" ? (
                    <span className="whitespace-pre-wrap">{m.text}</span>
                  ) : (
                    <Markdown text={m.text} streaming={m.status === "streaming"} inlineCitations />
                  )}
                </li>
              );
            })}
            {extraTakeover && renderTakeover(extraTakeover)}
            {streaming && !latest?.text && (
              <li>
                <Thinking />
              </li>
            )}
          </ol>
        ) : (
          <p className="float-empty m-0 text-sm text-muted-foreground">Nothing here yet.</p>
        )
      ) : latest?.text ? (
        <div
          className="float-reply [&_.md]:text-[15px] [&_.md]:leading-relaxed [&_.md_p]:mb-[0.7em]"
          data-status={latest.status}
        >
          <Markdown text={latest.text} streaming={streaming} inlineCitations />
        </div>
      ) : streaming ? (
        <Thinking />
      ) : !approvals.length && !takeover ? (
        <p className="float-empty m-0 text-sm text-muted-foreground">Nothing from the assistant yet.</p>
      ) : null}
    </div>
  );
}

function MiniComposer({
  name,
  running,
  stopping,
  onSend,
  onStop,
}: {
  name: string;
  running: boolean;
  stopping: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const empty = text.trim() === "";
  const inputId = useId();
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (empty) return;
    onSend(text.trim());
    setText("");
  };
  // Enter sends, but not the Enter that confirms an IME composition (Chinese, Japanese, Korean).
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    send();
  };
  return (
    <form className="float-composer m-0 flex items-center gap-1.5 border-t px-2.5 pt-2 pb-2.5" onSubmit={send}>
      <label htmlFor={inputId} className="sr-only">
        Message {name}
      </label>
      <Input
        id={inputId}
        type="text"
        className="h-9 flex-1 px-3.5"
        value={text}
        placeholder={`Message ${name}`}
        autoComplete="off"
        enterKeyHint="send"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {running && (
        <Tip label="Stop">
          <Button
            type="button"
            variant="secondary"
            size="icon-sm"
            onClick={onStop}
            disabled={stopping}
            aria-label="Stop"
          >
            <Icon name="stop" size={16} />
          </Button>
        </Tip>
      )}
      <Tip label="Send">
        <Button type="submit" size="icon-sm" disabled={empty} aria-label="Send message">
          <Icon name="send" size={16} />
        </Button>
      </Tip>
    </form>
  );
}

/** A message that belongs in the conversation view: what you and the assistant said. */
function isTurn(m: Message): boolean {
  return (m.role === "user" || m.role === "assistant") && !m.internal && m.text.trim() !== "";
}
