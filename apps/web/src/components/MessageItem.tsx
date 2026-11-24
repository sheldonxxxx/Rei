import type { Attachment, Message, MessageContext, MessagePart, SessionReport } from "@rei/protocol";
import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Card, CardContent } from "@/components/primitives/card.tsx";
import { Textarea } from "@/components/primitives/textarea.tsx";
import { cn } from "@/lib/utils.ts";
import { describeError, describeErrorInfo } from "../api/client.ts";
import { attachmentUrl, changedDraft, isPreviewImage } from "../lib/composer.ts";
import { fileContentUrl, libraryHref, versionAttachment } from "../lib/library.ts";
import { linkify } from "../lib/linkify.ts";
import { imageEmbeds } from "../lib/markdown.ts";
import { useArrival } from "../lib/motion.tsx";
import { isApprovalEcho } from "../lib/policy.ts";
import { triggerHref } from "../lib/route.ts";
import type { PendingMessage } from "../state/session.ts";
import type { DecideFn } from "./ApprovalCard.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { FilePreview } from "./FilePreview.tsx";
import { Icon } from "./Icon.tsx";
import { useLibrary } from "./LibraryContext.tsx";
import { Markdown, type MarkdownRefs } from "./Markdown.tsx";
import type { UndoChangeFn } from "./MemoryCards.tsx";
import { MemoryChipRow, MemorySuggestions } from "./MemoryCards.tsx";
import { useSurfaceContext } from "./surface/context.tsx";
import type { EndTakeoverFn } from "./TakeoverCard.tsx";
import { TakeoverCard } from "./TakeoverCard.tsx";
import { Thinking } from "./Thinking.tsx";
import { Tip } from "./Tip.tsx";

/** A reply as plain text for copying: each surface's fallback, then the text. */
function partsText(parts: MessagePart[]): string {
  return parts
    .map((p) => (p.type === "text" ? p.text.trim() : p.surface.fallback.trim()))
    .filter(Boolean)
    .join("\n\n");
}

const REPLY_BUBBLE = "min-w-0 w-fit max-w-full rounded-2xl bg-muted px-4 py-3 sm:px-5";
const THINKING_BUBBLE = "min-w-0 w-fit max-w-full rounded-2xl bg-muted px-3 py-2";

/** A reply's parts in order: surfaces the run showed, then its text. */
function MessageParts({ parts, streaming, refs }: { parts: MessagePart[]; streaming: boolean; refs?: MarkdownRefs }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {parts.map((p, i) =>
        p.type === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a message's parts are fixed and positional once written.
          <div key={i} className={REPLY_BUBBLE}>
            <Markdown text={p.text} streaming={streaming && i === parts.length - 1} inlineCitations refs={refs} />
          </div>
        ) : (
          <SurfaceView key={p.surface.surfaceId} surface={p.surface} />
        ),
      )}
    </div>
  );
}

import { SurfaceView } from "./surface/SurfaceView.tsx";

/** Plain text with line breaks preserved (CSS pre-wrap) and http(s) URLs as links. Never HTML. Used for what the user typed. */
export function RichText({ text }: { text: string }) {
  const parts = linkify(text);
  return (
    <>
      {parts.map((p, i) =>
        p.type === "link" ? (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow">
            {p.text}
          </a>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

export function ContextText({ text, mentions = [] }: { text: string; mentions?: MessageContext["mentions"] }) {
  let cursor = 0;
  const output = [];
  for (const m of mentions) {
    if (m.start < cursor || text.slice(m.start, m.end) !== `@${m.label}`) continue;
    output.push(<RichText key={`text-${m.start}`} text={text.slice(cursor, m.start)} />);
    output.push(
      <Tip
        key={`mention-${m.start}`}
        label={
          m.kind === "chat"
            ? "Open referenced chat"
            : m.kind === "page"
              ? "Open Knowledge page"
              : "Open connector settings"
        }
      >
        <a
          className="inline-mention"
          href={
            m.kind === "chat"
              ? sessionHref(m.id)
              : m.kind === "page"
                ? knowledgeHref(m.id)
                : `/settings/connectors/${encodeURIComponent(m.id)}`
          }
        >
          {text.slice(m.start, m.end)}
        </a>
      </Tip>,
    );
    cursor = m.end;
  }
  output.push(<RichText key="tail" text={text.slice(cursor)} />);
  return <>{output}</>;
}

function UserText({ text, mentions }: { text: string; mentions?: MessageContext["mentions"] }) {
  const bodyId = useId();
  const body = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el || expanded) return;
    const measure = () =>
      setOverflowing(
        el.clientHeight > 0 ? el.scrollHeight > el.clientHeight + 1 : text.length > 480 || text.split("\n").length > 6,
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <>
      <p
        id={bodyId}
        ref={body}
        className={cn(
          "text user-text m-0 text-base leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]",
          !expanded && "clamped max-h-[9.3em] overflow-hidden",
        )}
      >
        <ContextText text={text} mentions={mentions} />
      </p>
      {(overflowing || expanded) && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="more-btn -ml-2 text-muted-foreground"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </>
  );
}

/**
 * The attachments a reply already shows as inline images (`![alt](file:…)`), by attachment id: their cards would only
 * repeat them. A non-image file, or one the reply only links to, keeps its card.
 */
function embeddedFiles(text: string, attachments: Attachment[]): ReadonlySet<string> {
  if (!attachments.length || !text.includes("file:")) return EMPTY;
  const embeds = imageEmbeds(text);
  return new Set(
    attachments
      .filter(
        (a) =>
          !a.unavailable &&
          a.fileId &&
          a.versionId &&
          a.mediaType.startsWith("image/") &&
          embeds.some((e) => e.fileId === a.fileId && (!e.versionId || e.versionId === a.versionId)),
      )
      .map((a) => a.id),
  );
}
const EMPTY: ReadonlySet<string> = new Set();

export function MessageAttachments({
  sessionId,
  attachments = [],
  hidden = EMPTY,
}: {
  sessionId: string;
  attachments?: MessageContext["attachments"];
  /** Attachment ids not to list, because the message already shows them. */
  hidden?: ReadonlySet<string>;
}) {
  const [preview, setPreview] = useState<NonNullable<MessageContext["attachments"]>[number] | null>(null);
  const listed = attachments.filter((file) => !hidden.has(file.id));
  if (!listed.length) return null;
  return (
    <>
      <ul className="message-attachments" aria-label="Attachments">
        {listed.map((file) => (
          <li key={file.id}>
            {file.unavailable ? (
              // An imported message's file the import did not carry: its name and why, nothing to open.
              <div className="attachment-card attachment-unavailable">
                <span className="attachment-open">
                  <Icon name="upload" size={20} />
                  <span className="attachment-info">
                    <strong>{file.name}</strong>
                    <small>
                      {file.mediaType} · {file.unavailable}
                    </small>
                  </span>
                </span>
              </div>
            ) : (
              <div className="attachment-card">
                <button
                  type="button"
                  className="attachment-open"
                  aria-label={`Preview ${file.name}`}
                  onClick={() => setPreview(file)}
                >
                  {isPreviewImage(file.mediaType) ? (
                    <img
                      src={
                        file.fileId && file.versionId
                          ? `${fileContentUrl({ fileId: file.fileId, versionId: file.versionId })}?thumbnail=1`
                          : attachmentUrl(sessionId, file.id, true)
                      }
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <Icon name="upload" size={20} />
                  )}
                  <span className="attachment-info">
                    <strong>{file.name}</strong>
                    <small>{(file.size / 1024).toFixed(1)} KiB · Preview</small>
                  </span>
                </button>
                <a
                  className="attachment-download"
                  href={
                    file.fileId && file.versionId
                      ? fileContentUrl({ fileId: file.fileId, versionId: file.versionId })
                      : attachmentUrl(sessionId, file.id)
                  }
                  download={file.name}
                  aria-label={`Download ${file.name}`}
                  title="Download"
                >
                  <Icon name="download" size={16} />
                </a>
              </div>
            )}
          </li>
        ))}
      </ul>
      {preview && (
        <FilePreview
          key={`${sessionId}:${preview.id}`}
          sessionId={sessionId}
          file={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

const sessionHref = (id: string) => `/s/${encodeURIComponent(id)}`;
const knowledgeHref = (id: string) => `/knowledge/${encodeURIComponent(id)}`;

/** An inline error under a message, and a quiet note ("Stopped"). */
const NOTE_ERROR =
  "note note-error mt-2 flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [&>svg]:mt-0.5 [&>svg]:shrink-0";
const NOTE = "note mt-2.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground";
/** Edit, Copy, Fork, Inspect under a message: faint until you point at the message (touch keeps them visible). The hover rule is in styles/app.css. */
const ACTIONS = "msg-actions mt-1.5 -ml-1.5 flex gap-0.5 transition-opacity";

/** What memory messages need from the page: how to undo a change, and name the agent whose notes they are in. */
export interface MemoryHandlers {
  onUndo?: UndoChangeFn | undefined;
  agentName?: ((agentId: string | null) => string | undefined) | undefined;
}

/** What Full mode adds to a message: Inspect on every message, and "Fork from here" on replies. Omit in Simple mode. */
export interface FullHandlers {
  /** Open the inspector on the run that produced (or answered) this message. */
  onInspect: (runId: string | null) => void;
  /** Open the fork dialog for a reply. */
  onFork: (messageId: string) => void;
}

interface ItemProps {
  message: Message;
  /** Edit one of your own messages (`message.editable`) and rewind in place. The stream shows the rewound view after the server accepts it. */
  onEdit?:
    | ((
        messageId: string,
        text: string,
        mentions?: MessageContext["mentions"],
        selectedSkills?: MessageContext["selectedSkills"],
      ) => Promise<void>)
    | undefined;
  full?: FullHandlers | undefined;
  /** Branch in new chat: resolves once the new chat is open; rejects with the error to show. Omit to hide the button. */
  onBranch?: (messageId: string) => Promise<void>;
  onVersion?: (messageId: string, to: "prev" | "next") => Promise<void>;
  onUseAsDraft?: ((message: Message) => void) | undefined;
  waitingForApproval?: boolean | undefined;
  /** Approve or deny a blocked call (approval messages). Omit to show approval cards read-only. */
  onDecide?: DecideFn;
  /** Take over the browser from a takeover card (opens the panel and starts). Omit to show those cards read-only. */
  onTakeOver?: () => void;
  /** Reopen the browser panel from an active takeover card. */
  onOpenBrowser?: () => void;
  /** "Not now" on a takeover request. */
  onEndTakeover?: EndTakeoverFn;
  approvalAgentName?: string | undefined;
  /** Memory chips and the suggestions under a report. Omit to show the chips read-only. */
  memory?: MemoryHandlers;
  /** The newest reply in the chat: its actions stay visible where others show on hover. */
  latest?: boolean;
}

export function MessageItem({
  message,
  onEdit,
  full,
  onBranch,
  onVersion,
  onUseAsDraft,
  waitingForApproval,
  onDecide,
  approvalAgentName,
  onTakeOver,
  onOpenBrowser,
  onEndTakeover,
  memory,
  latest,
}: ItemProps) {
  // Both kinds this component can need, called before any branch: an arrival is decided once, at mount.
  const rise = useArrival("rise");
  const fade = useArrival("fade");
  if (message.internal) return null;
  if (message.role === "memory") {
    const change = message.memory?.change;
    if (change && change.op !== "confirm")
      return <MemoryChipRow messages={[message]} onUndo={memory?.onUndo} agentName={memory?.agentName} />;
    return null;
  }
  if (message.role === "takeover" && message.takeover) {
    return (
      <TakeoverCard
        takeover={message.takeover}
        chatSessionId={message.sessionId}
        onTakeOver={onTakeOver}
        onOpen={onOpenBrowser}
        onEnd={onEndTakeover}
      />
    );
  }
  // The card already says what you decided; the server's note of it only drives the agent's next turn.
  if (isApprovalEcho(message)) return null;
  if (message.role === "approval" && message.approval)
    return (
      <ApprovalCard
        approval={message.approval}
        agentName={approvalAgentName}
        chatSessionId={message.sessionId}
        onDecide={onDecide}
      />
    );
  if (message.role === "notice" || message.role === "approval" || message.role === "takeover") {
    return (
      <li data-msg-id={message.id} className="msg msg-notice text-center" data-enter={fade}>
        <p className="m-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">{message.text}</p>
      </li>
    );
  }
  if (message.role === "compaction" || message.role === "reset") {
    // Pi summarized earlier messages, or started a new context: a divider, since what comes before still shows.
    return (
      <li data-msg-id={message.id} className="msg msg-marker" data-marker={message.role} data-enter={fade}>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
          <span className="shrink-0">{message.text}</span>
          <span aria-hidden="true" className="h-px flex-1 bg-border" />
        </div>
      </li>
    );
  }
  if (message.role === "trigger" && message.trigger) {
    if (!message.runId) return <TriggerLine trigger={message.trigger} />;
    if (!full) return null;
    return (
      <li className="msg msg-trigger text-sm text-muted-foreground" data-msg-id={message.id} data-enter={fade}>
        <div className="flex items-center gap-3 rounded-xl bg-muted px-3 py-2">
          <span className="min-w-0 flex-1 truncate">Background result · {message.trigger.triggerName}</span>
          {message.trigger.sessionId && (
            <a className="shrink-0 underline" href={sessionHref(message.trigger.sessionId)}>
              Open session
            </a>
          )}
        </div>
      </li>
    );
  }
  // A slim line in both modes: the home agent's own reply carries the answer (or it stays quiet), and the result
  // expands from the line.
  if (message.role === "report" && message.report)
    return <ReportItem sessionId={message.sessionId} report={message.report} agentName={memory?.agentName} />;
  if (message.role === "user" && message.from) {
    // Written by another session's agent (a brief or a follow-up), so it isn't shown as your own bubble.
    return (
      <li data-msg-id={message.id} className="msg msg-brief" data-status={message.status} data-enter={rise}>
        <Card size="sm" role="article" className="brief gap-0 rounded-2xl bg-muted/50 shadow-none ring-border">
          <CardContent className="[&_.md]:text-[15px]">
            <p className="card-head m-0 mb-1.5 text-xs font-medium text-muted-foreground">
              From{" "}
              <a className="font-semibold text-foreground" href={sessionHref(message.from.sessionId)}>
                {message.from.title}
              </a>
            </p>
            <Markdown text={message.text} />
          </CardContent>
        </Card>
      </li>
    );
  }
  if (message.role === "user")
    return <UserItem message={message} onEdit={onEdit} onVersion={onVersion} onUseAsDraft={onUseAsDraft} />;

  return (
    <AssistantItem
      message={message}
      onBranch={onBranch}
      full={full}
      latest={latest}
      waitingForApproval={waitingForApproval}
    />
  );
}

/**
 * A trigger's line in the home chat: a notify message, a report, a failure or a self-pause. Plain text; it starts no run.
 * A notify is a small centred pill; the others are one left-aligned box, whatever the text length: the name and "Open run" on top, the text below.
 */
function TriggerLine({ trigger: t }: { trigger: NonNullable<Message["trigger"]> }) {
  const fade = useArrival("fade");
  const icon = (
    <span
      className="trigger-icon inline-grid self-center text-muted-foreground group-data-[kind=failed]/trig:text-destructive group-data-[kind=paused]/trig:text-attention-text"
      aria-hidden="true"
    >
      <Icon name={t.kind === "notify" ? "bell" : "clock"} size={14} />
    </span>
  );
  const name = (
    <a
      className="trigger-name font-semibold text-foreground no-underline hover:underline group-data-[kind=failed]/trig:text-destructive group-data-[kind=paused]/trig:text-attention-text"
      href={triggerHref(t.triggerId)}
    >
      {t.triggerName}
    </a>
  );
  if (t.kind === "notify") {
    return (
      <li className="msg msg-trigger group/trig text-center" data-kind={t.kind} data-enter={fade}>
        <p className="trigger-line m-0 inline-flex max-w-full flex-wrap items-baseline justify-center gap-x-2 gap-y-0.5 rounded-xl bg-muted px-3 py-1 text-sm text-foreground/80 [overflow-wrap:anywhere] group-data-[kind=failed]/trig:bg-destructive/10 group-data-[kind=failed]/trig:text-destructive group-data-[kind=paused]/trig:bg-attention-soft group-data-[kind=paused]/trig:text-attention-text">
          {icon}
          {name}
          <span className="trigger-text min-w-0">{t.text}</span>
        </p>
      </li>
    );
  }
  return (
    <li className="msg msg-trigger group/trig text-left" data-kind={t.kind} data-enter={fade}>
      <div className="trigger-box flex max-w-full flex-col gap-0.5 rounded-xl bg-muted px-3 py-2 text-sm text-foreground/80 [overflow-wrap:anywhere] group-data-[kind=failed]/trig:bg-destructive/10 group-data-[kind=failed]/trig:text-destructive group-data-[kind=paused]/trig:bg-attention-soft group-data-[kind=paused]/trig:text-attention-text">
        <p className="trigger-head m-0 flex min-w-0 items-center gap-2">
          {icon}
          {name}
          {t.sessionId && (
            <a className="trigger-open ml-auto shrink-0 text-xs font-medium" href={sessionHref(t.sessionId)}>
              Open run
            </a>
          )}
        </p>
        <div className="trigger-text m-0 min-w-0">
          {t.kind === "report" ? <Markdown text={t.text} /> : <p className="m-0 whitespace-pre-wrap">{t.text}</p>}
        </div>
      </div>
    </li>
  );
}

function InspectButton({ message, full }: { message: Message; full: FullHandlers }) {
  return (
    <Tip label="Inspect">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        aria-label="Inspect"
        onClick={() => full.onInspect(message.runId)}
      >
        <Icon name="eye" size={16} />
      </Button>
    </Tip>
  );
}

/** The skills a message was sent with, as small chips above its text; `onRemove` makes them removable (editing). */
export function MessageSkillChips({
  skills,
  onRemove,
}: {
  skills?: MessageContext["selectedSkills"];
  onRemove?: ((id: string) => void) | undefined;
}) {
  if (!skills?.length) return null;
  return (
    <ul className="message-skills m-0 mb-1.5 flex list-none flex-wrap gap-1 p-0" aria-label="Skills">
      {skills.map((s) => (
        <li
          key={s.id}
          className="inline-flex max-w-full items-center gap-1 rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-medium"
        >
          <Icon name="sparkle" size={12} />
          <span className="min-w-0 truncate" title={`${s.name} · version ${s.version}`}>
            {s.name}
          </span>
          {onRemove && (
            <button
              type="button"
              className="-me-1 inline-grid size-4 place-items-center rounded-full hover:bg-foreground/15"
              aria-label={`Remove skill ${s.name}`}
              onClick={() => onRemove(s.id)}
            >
              <Icon name="close" size={10} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Your own message, with Edit on the ones you typed. A message a button or form sent shows which component it came from. */
function UserItem({
  message,
  onEdit,
  onVersion,
  onUseAsDraft,
}: Pick<ItemProps, "message" | "onEdit" | "onVersion" | "onUseAsDraft">) {
  const surfaces = useSurfaceContext();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [draftMentions, setDraftMentions] = useState(message.mentions ?? []);
  const [draftSkills, setDraftSkills] = useState(message.selectedSkills ?? []);
  const [busy, setBusy] = useState<"edit" | "version" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);

  async function run(kind: NonNullable<typeof busy>, action: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await action();
      // The rewound view replaces this message; until it arrives the bubble shows as it was.
      setEditing(false);
    } catch (e) {
      setError(describeError(e));
    }
    setBusy(null);
  }

  function saveEdit() {
    if (!onEdit) return;
    const skills = message.selectedSkills?.length ? draftSkills : undefined;
    const mentions = message.mentions?.length ? draftMentions : undefined;
    void run("edit", () => {
      if (skills) return onEdit(message.id, draft, mentions, skills);
      if (mentions) return onEdit(message.id, draft, mentions);
      return onEdit(message.id, draft);
    });
  }

  const canEdit = !!message.editable && !!onEdit;
  const via = message.surfaceAction ? (surfaces.titleOf?.(message.surfaceAction.surfaceId) ?? "a surface") : null;
  const trimmed = draft.trim() || !!message.attachments?.length;
  if (editing) {
    return (
      <li data-msg-id={message.id} className="msg msg-user flex flex-col items-end" data-status={message.status}>
        <div className="edit-box flex w-[min(100%,36rem)] flex-col gap-2">
          <Textarea
            ref={area}
            className="min-h-20 resize-y bg-card text-base md:text-base"
            aria-label="Edit your message"
            value={draft}
            disabled={busy !== null}
            onChange={(e) => {
              const next = changedDraft(draft, draftMentions, e.target.value);
              setDraft(next.text);
              setDraftMentions(next.mentions);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(false);
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && trimmed && busy === null) saveEdit();
            }}
          />
          <MessageSkillChips
            skills={draftSkills}
            onRemove={(id) => setDraftSkills((items) => items.filter((s) => s.id !== id))}
          />
          <MessageAttachments sessionId={message.sessionId} attachments={message.attachments} />
          <div className="edit-actions flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={busy !== null || !trimmed} onClick={saveEdit}>
              {busy === "edit" ? "Sending…" : "Save & send"}
            </Button>
          </div>
        </div>
        {error && (
          <p className={NOTE_ERROR} role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
          </p>
        )}
      </li>
    );
  }
  const versions = onVersion ? message.versions : undefined;
  return (
    <li data-msg-id={message.id} className="msg msg-user flex flex-col items-end" data-status={message.status}>
      {via && <p className="msg-via m-0 mb-1 text-right text-xs text-muted-foreground">via {via}</p>}
      <div className="bubble max-w-[min(80%,36rem)] rounded-2xl bg-secondary px-4 py-2.5 text-secondary-foreground max-md:max-w-[88%]">
        <MessageSkillChips skills={message.selectedSkills} />
        <UserText text={message.text} mentions={message.mentions} />
        <MessageAttachments sessionId={message.sessionId} attachments={message.attachments} />
      </div>
      {message.status === "pending" && (
        <span className="mt-1 text-xs text-muted-foreground">{message.steer ? "Steering" : "Queued"}</span>
      )}
      {message.status === "aborted" && (
        <div className="mt-1 flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
          <span>Cancelled before running</span>
          {onUseAsDraft && (
            <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={() => onUseAsDraft(message)}>
              Use as draft
            </Button>
          )}
        </div>
      )}
      <div
        className={cn(ACTIONS, "mt-1 mr-0 ml-0 items-center justify-end")}
        data-versioned={versions ? "" : undefined}
      >
        {versions && onVersion && (
          <>
            <Tip label="Previous version">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label="Previous version"
                disabled={busy !== null || versions.index <= 1}
                onClick={() => void run("version", () => onVersion(message.id, "prev"))}
              >
                <Icon name="back" size={16} />
              </Button>
            </Tip>
            <span className="text-xs tabular-nums text-muted-foreground">
              <span className="sr-only">
                Version {versions.index} of {versions.count}
              </span>
              <span aria-hidden="true">
                {versions.index}/{versions.count}
              </span>
            </span>
            <Tip label="Next version">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label="Next version"
                disabled={busy !== null || versions.index >= versions.count}
                onClick={() => void run("version", () => onVersion(message.id, "next"))}
              >
                <Icon name="forward" size={16} />
              </Button>
            </Tip>
          </>
        )}
        {canEdit && (
          <Tip label="Edit">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label="Edit"
              disabled={busy !== null}
              onClick={() => {
                setDraft(message.text);
                setDraftMentions(message.mentions ?? []);
                setDraftSkills(message.selectedSkills ?? []);
                setEditing(true);
              }}
            >
              <Icon name="edit" size={16} />
            </Button>
          </Tip>
        )}
        <CopyButton text={message.text} label="Copy message" />
      </div>
      {error && (
        <p className={cn(NOTE_ERROR, "max-w-[min(80%,36rem)] self-end")} role="alert">
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </p>
      )}
    </li>
  );
}

function AssistantItem({ message, onBranch, full, latest, waitingForApproval }: ItemProps) {
  const [branching, setBranching] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [embeddedPreview, setEmbeddedPreview] = useState<Attachment | null>(null);
  const [embeddedPreviewError, setEmbeddedPreviewError] = useState<string | null>(null);
  const library = useLibrary();
  async function branch() {
    if (!onBranch) return;
    setBranching(true);
    setBranchError(null);
    try {
      await onBranch(message.id);
    } catch (e) {
      setBranchError(describeError(e));
    } finally {
      setBranching(false);
    }
  }

  const streaming = message.status === "streaming";
  const done = message.status === "complete" || message.status === "aborted";
  const arrival = useArrival("rise");
  const attachments = message.attachments ?? [];
  // A Library file the reply carries is known without a fetch: its embeds show as images and open straight away.
  const carried = (fileId: string, versionId: string | null) =>
    attachments.find((a) => a.fileId === fileId && (!versionId || a.versionId === versionId));
  const embedded = useMemo(
    () => embeddedFiles(message.parts ? partsText(message.parts) : message.text, message.attachments ?? []),
    [message.parts, message.text, message.attachments],
  );
  const refs: MarkdownRefs = {
    file: (fileId, versionId) => {
      const a = carried(fileId, versionId);
      if (!a) return undefined;
      return {
        name: a.name,
        available: !a.unavailable,
        contentVersionId: a.versionId ?? null,
        mediaType: a.mediaType,
      };
    },
    ...(library || attachments.length
      ? {
          openFile: async (fileId: string, versionId: string | null) => {
            setEmbeddedPreviewError(null);
            const known = carried(fileId, versionId);
            if (known && !known.unavailable) {
              setEmbeddedPreview(known);
              return;
            }
            if (!library) {
              window.location.assign(libraryHref(fileId));
              return;
            }
            try {
              const detail = await library.api.getFile(fileId);
              const version = versionId
                ? detail.versions.find((candidate) => candidate.versionId === versionId)
                : detail.file.current;
              if (!version) throw new Error("That file version is no longer available.");
              setEmbeddedPreview(versionAttachment(version));
            } catch (e) {
              setEmbeddedPreviewError(describeError(e));
            }
          },
        }
      : {}),
  };
  return (
    <li
      data-msg-id={message.id}
      className="msg msg-assistant min-w-0"
      data-status={message.status}
      data-latest={latest ? "true" : undefined}
      data-enter={arrival}
    >
      {full && message.thinking?.length ? (
        // An imported reply's reasoning: detail mode only, folded, and never part of what the model sees.
        <details className="imported-thinking mb-2 text-sm text-muted-foreground">
          <summary className="cursor-pointer select-none">Thinking</summary>
          <div className="mt-2 border-l-2 border-border pl-3">
            {message.thinking.map((block, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are fixed text in a fixed order
              <Markdown key={i} text={block} />
            ))}
          </div>
        </details>
      ) : null}
      {message.parts ? (
        <MessageParts parts={message.parts} streaming={streaming} refs={refs} />
      ) : message.text ? (
        <div className={REPLY_BUBBLE}>
          <Markdown text={message.text} streaming={streaming} inlineCitations refs={refs} />
        </div>
      ) : streaming && !waitingForApproval ? (
        <div className={THINKING_BUBBLE}>
          <Thinking />
        </div>
      ) : null}
      <MessageAttachments sessionId={message.sessionId} attachments={message.attachments} hidden={embedded} />
      {message.status === "aborted" && <p className={NOTE}>Stopped</p>}
      {message.status === "error" && (
        <p className={NOTE_ERROR} role="note">
          <Icon name="alert" size={16} />
          <span>{describeErrorInfo(message.error)}</span>
        </p>
      )}
      {embeddedPreviewError && (
        <p className={NOTE_ERROR} role="alert">
          <Icon name="alert" size={16} />
          <span>{embeddedPreviewError}</span>
        </p>
      )}
      {embeddedPreview && <FilePreview file={embeddedPreview} onClose={() => setEmbeddedPreview(null)} />}
      {done && message.text && (
        <div className={ACTIONS}>
          <CopyButton text={message.parts ? partsText(message.parts) : message.text} label="Copy reply" />
          {/* In Full mode "Fork from here" does the same and is a plain confirm. */}
          {message.forkable && onBranch && !full && (
            <Tip label="Branch in new chat">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label="Branch in new chat"
                disabled={branching}
                onClick={() => void branch()}
              >
                <Icon name="branch" size={16} />
              </Button>
            </Tip>
          )}
          {full && message.forkable && (
            <Tip label="Fork from here">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label="Fork from here"
                onClick={() => full.onFork(message.id)}
              >
                <Icon name="branch" size={16} />
              </Button>
            </Tip>
          )}
          {full && <InspectButton message={message} full={full} />}
        </div>
      )}
      {branchError && (
        <p className={NOTE_ERROR} role="alert">
          <Icon name="alert" size={16} />
          <span>{branchError}</span>
        </p>
      )}
    </li>
  );
}

const OUTCOME: Record<SessionReport["outcome"], { icon: "check" | "alert" | "square"; verb: string }> = {
  completed: { icon: "check", verb: "finished" },
  failed: { icon: "alert", verb: "failed" },
  cancelled: { icon: "square", verb: "was cancelled" },
};

const OUTCOME_TONE: Record<SessionReport["outcome"], string> = {
  completed: "text-success",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

/**
 * A finished session as one slim line. The home agent answers (or deliberately stays quiet) in its own reply, so the
 * result itself is only a click away: the toggle expands it here, the link opens the session.
 */
function ReportItem({
  report,
  agentName,
  sessionId,
}: {
  sessionId: string;
  report: SessionReport;
  agentName: MemoryHandlers["agentName"];
}) {
  const { icon, verb } = OUTCOME[report.outcome];
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  const summary = report.summary.trim();

  return (
    <li className="msg msg-report">
      <article
        className={cn(
          "report rounded-2xl bg-muted/50 px-3 py-2 text-sm ring-1 ring-border",
          `report-${report.outcome}`,
        )}
      >
        <div className="card-head report-head flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={cn("outcome-icon inline-grid shrink-0", OUTCOME_TONE[report.outcome])} aria-hidden="true">
            <Icon name={icon} size={16} />
          </span>
          <span className="report-line min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{`${report.title} ${verb}`}</span>
          {summary && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="more-btn text-muted-foreground"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => setExpanded((e) => !e)}
            >
              {expanded ? "Hide result" : "Show result"}
            </Button>
          )}
          <Button asChild variant="ghost" size="xs" className="card-link text-muted-foreground">
            <a href={sessionHref(report.sessionId)} className="no-underline">
              Open session
              <Icon name="external" size={14} />
            </a>
          </Button>
        </div>
        {summary && expanded && (
          <div id={bodyId} className="report-body mt-2 text-[15px] text-foreground/80 [&_.md]:text-inherit">
            <Markdown text={summary} />
            {report.resultChars !== undefined && report.resultChars > report.summary.length && (
              <p className="report-cut m-0 mt-1 text-xs text-muted-foreground">
                Showing the start of the result. Open the session for the rest.
              </p>
            )}
          </div>
        )}
        <MessageAttachments sessionId={sessionId} attachments={report.files} />
        {report.memorySuggestions && report.memorySuggestions.length > 0 && (
          <MemorySuggestions suggestions={report.memorySuggestions} agentName={agentName} />
        )}
      </article>
    </li>
  );
}

export function PendingItem({
  pending,
  onRetry,
  sessionId = "",
}: {
  pending: PendingMessage;
  sessionId?: string;
  onRetry: (p: PendingMessage) => void;
}) {
  const arrival = useArrival("fade");
  return (
    <li
      className="msg msg-user msg-pending flex flex-col items-end"
      data-status={pending.error ? "failed" : "sending"}
      data-enter={arrival}
    >
      <div className="bubble max-w-[min(80%,36rem)] rounded-2xl bg-secondary px-4 py-2.5 text-secondary-foreground opacity-60 max-md:max-w-[88%]">
        <MessageSkillChips skills={pending.selectedSkills} />
        <UserText text={pending.text} mentions={pending.mentions} />
        <MessageAttachments sessionId={sessionId} attachments={pending.attachments} />
      </div>
      {pending.error && (
        <p className={NOTE_ERROR}>
          <Icon name="alert" size={16} />
          <span>{pending.error}</span>
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto p-0 text-destructive underline"
            onClick={() => onRetry(pending)}
          >
            Retry
          </Button>
        </p>
      )}
    </li>
  );
}
