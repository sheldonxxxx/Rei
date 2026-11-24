import type { EndTakeoverRequest, Takeover } from "@rei/protocol";
import { useId, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Card, CardContent } from "@/components/primitives/card.tsx";
import { cn } from "@/lib/utils.ts";
import { ApiError, describeError } from "../api/client.ts";
import { hostOf } from "../lib/browser.ts";
import { useArrival } from "../lib/motion.tsx";
import { formatWhen } from "../lib/time.ts";
import { ACTIONS, DONE, FACTS, HEAD, NEEDS_YOU, SUMMARY } from "./approvalStyles.ts";
import { Icon } from "./Icon.tsx";

const sessionHref = (id: string) => `/s/${encodeURIComponent(id)}`;

export type EndTakeoverFn = (takeoverId: string, req: EndTakeoverRequest) => Promise<Takeover>;

interface Props {
  takeover: Takeover;
  /** The chat this card is shown in; a card for a spawned session (the parent-chat mirror) links there instead of opening the panel. */
  chatSessionId: string;
  /** Open the browser panel and take over. Omit to show the card read-only. */
  onTakeOver?: (() => void) | undefined;
  /** Reopen the panel while you are already in control. */
  onOpen?: (() => void) | undefined;
  /** "Not now" on a pending request. */
  onEnd?: EndTakeoverFn | undefined;
}

/**
 * The agent asked you to take over the browser (a sign-in, a code, a CAPTCHA), or you did. Drawn from structured
 * fields only: the reason is the agent's text and is shown as plain text.
 */
export function TakeoverCard({ takeover, chatSessionId, onTakeOver, onOpen, onEnd }: Props) {
  const arrival = useArrival("card");
  // What this device did, so the card is right at once, before the stream catches up.
  const [local, setLocal] = useState<Takeover | null>(null);
  const shown = takeover.status === "pending" && local ? local : takeover;
  return (
    <li className="msg msg-approval msg-takeover" data-status={shown.status} data-enter={arrival}>
      {shown.status === "pending" ? (
        <Pending
          takeover={shown}
          chatSessionId={chatSessionId}
          onTakeOver={onTakeOver}
          onEnd={onEnd}
          onEnded={setLocal}
        />
      ) : shown.status === "active" ? (
        <Active takeover={shown} chatSessionId={chatSessionId} onOpen={onOpen} />
      ) : (
        <Finished takeover={shown} />
      )}
    </li>
  );
}

function Pending({
  takeover,
  chatSessionId,
  onTakeOver,
  onEnd,
  onEnded,
}: {
  takeover: Takeover;
  chatSessionId: string;
  onTakeOver: (() => void) | undefined;
  onEnd: EndTakeoverFn | undefined;
  onEnded: (t: Takeover) => void;
}) {
  const headId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = hostOf(takeover.url);
  const elsewhere = takeover.sessionId !== chatSessionId;

  async function notNow() {
    if (!onEnd) return;
    setBusy(true);
    setError(null);
    try {
      onEnded(await onEnd(takeover.id, { action: "cancel" }));
    } catch (e) {
      setError(e instanceof ApiError && e.code === "not_open" ? "This request is already over." : describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card size="sm" role="article" className={cn(NEEDS_YOU, "takeover")} aria-labelledby={headId}>
      <CardContent className="flex flex-col gap-2.5 max-md:px-3.5">
        <p className={HEAD}>
          <span className="approval-icon inline-grid shrink-0 text-attention-text" aria-hidden="true">
            <Icon name="pointer" size={18} />
          </span>
          <strong id={headId} className="font-semibold">
            The assistant needs you in the browser
          </strong>
        </p>
        {takeover.reason && <p className={SUMMARY}>{takeover.reason}</p>}
        {host && (
          <dl className={FACTS}>
            <div>
              <dt>Page</dt>
              <dd>{host}</dd>
            </div>
          </dl>
        )}
        {error && (
          <p role="alert" className="form-error m-0">
            {error}
          </p>
        )}
        <div className={ACTIONS}>
          {elsewhere ? (
            <Button asChild>
              <a href={sessionHref(takeover.sessionId)} className="no-underline">
                Open chat
              </a>
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                disabled={busy || !onEnd}
                aria-busy={busy}
                onClick={() => void notNow()}
              >
                Not now
              </Button>
              <Button type="button" disabled={busy || !onTakeOver} onClick={onTakeOver}>
                Take over
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Active({
  takeover,
  chatSessionId,
  onOpen,
}: {
  takeover: Takeover;
  chatSessionId: string;
  onOpen: (() => void) | undefined;
}) {
  const headId = useId();
  const host = hostOf(takeover.url);
  const elsewhere = takeover.sessionId !== chatSessionId;
  return (
    <Card size="sm" role="article" className={cn(NEEDS_YOU, "takeover takeover-active")} aria-labelledby={headId}>
      <CardContent className="flex flex-col gap-2.5 max-md:px-3.5">
        <p className={HEAD}>
          <span className="approval-icon inline-grid shrink-0 text-attention-text" aria-hidden="true">
            <Icon name="pointer" size={18} />
          </span>
          <strong id={headId} className="font-semibold">
            You're in control
          </strong>
          {host && <span className="approval-num text-xs tabular-nums text-muted-foreground">{host}</span>}
        </p>
        {elsewhere ? (
          <a className="inline-flex items-center gap-1 text-sm font-medium" href={sessionHref(takeover.sessionId)}>
            Open chat
            <Icon name="external" size={14} />
          </a>
        ) : (
          onOpen && (
            <div className={ACTIONS}>
              <Button type="button" onClick={onOpen}>
                Open browser
              </Button>
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}

function Finished({ takeover }: { takeover: Takeover }) {
  const done = takeover.status === "done";
  const note = takeover.note?.trim();
  const when = takeover.endedAt ?? takeover.createdAt;
  const label = done ? "You finished in the browser" : "Cancelled";
  return (
    <Card
      size="sm"
      role="article"
      className={cn(DONE, `approval-${done ? "approved" : "cancelled"}`)}
      aria-label={note ? `${label}: ${note}` : label}
    >
      <CardContent className="px-3">
        <div className="approval-done-line flex items-start gap-2 text-sm text-foreground/80">
          <span
            className={cn("approval-icon mt-0.5 inline-grid shrink-0 text-muted-foreground", done && "text-success")}
            aria-hidden="true"
          >
            <Icon name={done ? "check" : "square"} size={16} />
          </span>
          <span className="approval-done-text min-w-0 flex-1 pt-px [overflow-wrap:anywhere]">
            <strong className="font-semibold text-foreground">{label}</strong>
            {note && <span className="approval-done-summary text-muted-foreground"> — {note}</span>}
          </span>
          <time
            className="approval-time shrink-0 pt-0.5 text-xs whitespace-nowrap text-muted-foreground"
            dateTime={new Date(when).toISOString()}
          >
            {formatWhen(when)}
          </time>
        </div>
      </CardContent>
    </Card>
  );
}
