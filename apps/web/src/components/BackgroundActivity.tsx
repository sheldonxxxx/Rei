import type { BackgroundDetail, BackgroundList } from "@rei/protocol";
import { useEffect, useState } from "react";
import { Badge } from "@/components/primitives/badge.tsx";
import { Button } from "@/components/primitives/button.tsx";
import { Empty, EmptyDescription } from "@/components/primitives/empty.tsx";
import { Field, FieldGroup, FieldLabel } from "@/components/primitives/field.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/primitives/native-select.tsx";
import type { Api } from "../api/client.ts";
import { describeError } from "../api/client.ts";
import { navigate, sessionHref } from "../lib/route.ts";
import { formatWhen } from "../lib/time.ts";
import { Icon } from "./Icon.tsx";
import { LineDiff } from "./MemoryCards.tsx";
import { PageShell } from "./PageShell.tsx";

function label(status: string) {
  if (status === "no_changes") return "No changes";
  return status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ");
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  "memory.review": "Memory Review",
  "session.title": "Chat title",
};
const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;

const DIAGNOSTIC: Readonly<Record<string, string>> = {
  MODEL_UNAVAILABLE: "The model is not available",
  MODEL_CALL_FAILED: "The model call failed",
  MODEL_TIMED_OUT: "The model took too long",
  EMPTY_TITLE: "The model gave no usable title",
  SOURCE_UNAVAILABLE: "The chat is no longer available",
  SOURCE_MODEL_UNAVAILABLE: "The chat's model is not available",
  ATTEMPT_FAILED: "The attempt failed with no further detail",
  CANCELLED: "Cancelled",
  DISABLED: "Turned off in Settings",
  SOURCE_DELETED: "The chat was deleted",
};
/** A diagnostic is a code, optionally followed by ": detail" (the provider's own words). */
function describeDiagnostic(diagnostic: string) {
  const [code = "", ...rest] = diagnostic.split(": ");
  const detail = rest.join(": ");
  const text = DIAGNOSTIC[code] ?? code;
  return detail ? `${text}: ${detail}` : text;
}

const STATUS_TONE: Readonly<Record<string, string>> = {
  running: "bg-accent text-accent-foreground",
  succeeded: "bg-success/10 text-success",
  failed: "bg-destructive/10 text-destructive",
};
export function BackgroundActivity({
  api,
  route,
  rev,
  onBack,
}: {
  api: Pick<Api, "getBackground" | "getBackgroundDetail" | "retryBackground" | "undoMemoryChange">;
  route: string;
  rev: number;
  onBack: () => void;
}) {
  const url = new URL(route, "http://rei.local");
  const id = url.pathname.split("/")[2];
  const kind = url.searchParams.get("kind") ?? "";
  const status = url.searchParams.get("status") ?? "";
  const session = url.searchParams.get("sessionId") ?? "";
  const [list, setList] = useState<BackgroundList | null>(null);
  const [detail, setDetail] = useState<BackgroundDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const isReview = detail?.job.kind === "memory.review";
  // biome-ignore lint/correctness/useExhaustiveDependencies: Global activity revisions and Refresh intentionally invalidate durable data.
  useEffect(() => {
    let live = true;
    setError(null);
    const pending = id ? api.getBackgroundDetail(id) : api.getBackground(Object.fromEntries(url.searchParams));
    void pending.then(
      (result) => {
        if (!live) return;
        if ("job" in result) setDetail(result);
        else setList(result);
      },
      (e) => {
        if (live) setError(describeError(e));
      },
    );
    return () => {
      live = false;
    };
  }, [api, route, rev, refresh]);
  const filter = (name: string, value: string) => {
    const params = new URLSearchParams(url.searchParams);
    params.delete("before");
    if (value) params.set(name, value);
    else params.delete(name);
    navigate(`/background?${params}`);
  };
  const action = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      setRefresh((r) => r + 1);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex-1 overflow-y-auto p-5 md:p-8">
      <div className="mx-auto max-w-4xl">
        <PageShell
          className="[&>.page-head>h3]:text-3xl max-md:[&>.page-head>h3]:text-2xl"
          title={id ? "Background task" : "Background Activity"}
          onBack={id ? () => navigate("/background") : onBack}
          backLabel={id ? "Back to Background Activity" : "Back to chats"}
          actions={
            <Button variant="ghost" size="sm" onClick={() => setRefresh((r) => r + 1)}>
              Refresh
            </Button>
          }
        >
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {id ? (
            detail && detail.job.id === id ? (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <Badge variant="secondary" className={STATUS_TONE[detail.job.status]}>
                    {detail.job.status === "succeeded" && <Icon name="check" />}
                    {label(detail.job.status)}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    {kindLabel(detail.job.kind)} · {formatWhen(detail.job.created_at)}
                  </span>
                </div>
                {detail.job.session_id ? (
                  <a className="text-sm underline" href={sessionHref(detail.job.session_id)}>
                    Open source chat
                  </a>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Source chat deleted. Source details have been removed.
                  </p>
                )}
                {detail.job.diagnostic && (
                  <p
                    role={detail.job.status === "failed" ? "alert" : undefined}
                    className={`text-sm ${detail.job.status === "failed" ? "text-destructive" : ""}`}
                  >
                    {describeDiagnostic(detail.job.diagnostic)}
                  </p>
                )}
                {isReview ? (
                  <p className="text-sm text-muted-foreground">{detail.sources.length} eligible user messages</p>
                ) : (
                  <GeneratedTitle result={detail.job.result} />
                )}
                {isReview && detail.job.session_id && (
                  <ReviewBoundary
                    sessionId={detail.job.session_id}
                    payload={detail.job.payload}
                    result={detail.job.result}
                  />
                )}
                {detail.job.status === "failed" && (
                  <Button className="w-fit" disabled={busy} onClick={() => void action(() => api.retryBackground(id))}>
                    {isReview ? "Retry review" : "Retry"}
                  </Button>
                )}
                {isReview && (
                  <>
                    <section className="flex flex-col gap-3" aria-label="Memory changes">
                      <h4 className="font-medium">Memory changes</h4>
                      {detail.changes.length ? (
                        detail.changes.map((change) => (
                          <div
                            key={change.id}
                            className="flex flex-wrap items-center justify-between gap-3 border-b py-3 text-sm"
                          >
                            <LineDiff before={change.before} after={change.after} />
                            {change.undoneAt !== null ? (
                              <Badge variant="secondary">Undone</Badge>
                            ) : (
                              change.undoable && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => void action(() => api.undoMemoryChange(change.id))}
                                >
                                  Undo
                                </Button>
                              )
                            )}
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-muted-foreground">No memory changes.</p>
                      )}
                    </section>
                    <section className="flex flex-col gap-2" aria-label="Source evidence">
                      <h4 className="font-medium">Reviewed messages</h4>
                      {detail.sources.map((source, index) => (
                        <a
                          key={source.messageId}
                          className="text-sm underline"
                          href={sessionHref(detail.job.session_id!, source.messageId)}
                        >
                          Source message {index + 1}
                        </a>
                      ))}
                    </section>
                  </>
                )}
                <section className="flex flex-col gap-3" aria-label="Attempts">
                  <h4 className="font-medium">Attempts</h4>
                  {detail.attempts.map((attempt) => (
                    <div key={attempt.attempt} className="flex flex-col gap-1 border-b py-3 text-sm">
                      <span>
                        Attempt {attempt.attempt} · {label(attempt.outcome ?? "running")}
                      </span>
                      <span className="text-muted-foreground">
                        {attempt.provider ?? "Model pending"}
                        {attempt.model ? ` / ${attempt.model}` : ""} ·{" "}
                        {attempt.finished_at
                          ? `${Math.max(0, attempt.finished_at - attempt.started_at) / 1000}s`
                          : "In progress"}
                      </span>
                      {attempt.usage && <Usage value={attempt.usage} />}
                    </div>
                  ))}
                </section>
              </>
            ) : (
              <p role="status">Loading task…</p>
            )
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Private work, outcomes and model usage across Rei, such as memory reviews and chat titles. Reviews that
                find nothing to save finish with no changes. A failed task shows why, and can be retried.
              </p>
              <FieldGroup className="flex-row flex-wrap gap-3">
                <Field className="w-auto">
                  <FieldLabel htmlFor="activity-kind">Type</FieldLabel>
                  <NativeSelect id="activity-kind" value={kind} onChange={(e) => filter("kind", e.target.value)}>
                    <NativeSelectOption value="">All types</NativeSelectOption>
                    <NativeSelectOption value="memory.review">Memory Review</NativeSelectOption>
                    <NativeSelectOption value="session.title">Chat title</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field className="w-auto">
                  <FieldLabel htmlFor="activity-status">Status</FieldLabel>
                  <NativeSelect id="activity-status" value={status} onChange={(e) => filter("status", e.target.value)}>
                    {["", "queued", "running", "succeeded", "no_changes", "skipped", "failed", "cancelled"].map(
                      (value) => (
                        <NativeSelectOption key={value} value={value}>
                          {value ? label(value) : "All statuses"}
                        </NativeSelectOption>
                      ),
                    )}
                  </NativeSelect>
                </Field>
                <Field className="w-auto">
                  <FieldLabel htmlFor="activity-session">Source session</FieldLabel>
                  <Input
                    id="activity-session"
                    defaultValue={session}
                    placeholder="Session ID"
                    onBlur={(e) => {
                      if (e.target.value !== session) filter("sessionId", e.target.value);
                    }}
                  />
                </Field>
              </FieldGroup>
              {!list ? (
                <p role="status">Loading activity…</p>
              ) : list.jobs.length ? (
                <ul className="m-0 flex list-none flex-col p-0">
                  {list.jobs.map((job) => (
                    <li key={job.id} className="flex items-center gap-2 border-b">
                      <a
                        className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3 rounded-xl px-3 py-4 no-underline hover:bg-muted"
                        href={`/background/${encodeURIComponent(job.id)}`}
                      >
                        <span className="flex min-w-0 flex-col gap-1">
                          <span className="text-sm font-medium">{kindLabel(job.kind)}</span>
                          <span className="text-xs text-muted-foreground">
                            {formatWhen(job.created_at)} ·{" "}
                            {job.summary?.sessionTitle ?? job.session_id ?? "Source deleted"}
                          </span>
                          {job.summary && (
                            <span className="text-xs text-muted-foreground">
                              {job.summary.agentName ?? "Agent removed"}
                              {job.kind === "memory.review" ? ` · ${job.summary.eligibleTurns} user messages` : ""}
                              {job.summary.model ? ` · ${job.summary.model}` : ""}
                              {job.summary.durationMs !== null ? ` · ${job.summary.durationMs / 1000}s` : ""}
                            </span>
                          )}
                          {job.diagnostic && (
                            <span
                              className={`text-xs ${job.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
                            >
                              {describeDiagnostic(job.diagnostic)}
                            </span>
                          )}
                          {job.summary?.usage && <Usage value={job.summary.usage} />}
                        </span>
                        <Badge variant="secondary" className={STATUS_TONE[job.status]}>
                          {job.status === "succeeded" && <Icon name="check" />}
                          {label(job.status)}
                        </Badge>
                      </a>
                      {job.status === "failed" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          aria-label={`Retry ${kindLabel(job.kind)}`}
                          onClick={() => void action(() => api.retryBackground(job.id))}
                        >
                          Retry
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>
                  <EmptyDescription>No background activity matches these filters.</EmptyDescription>
                </Empty>
              )}
              {list?.next && (
                <Button variant="outline" className="w-fit" onClick={() => filter("before", list.next!)}>
                  Older activity
                </Button>
              )}
            </>
          )}
        </PageShell>
      </div>
    </div>
  );
}
function Usage({ value }: { value: string }) {
  try {
    const rows = JSON.parse(value) as { input_tokens?: number; output_tokens?: number; cached_tokens?: number }[];
    if (!Array.isArray(rows) || !rows.length || rows.every((r) => r.input_tokens == null && r.output_tokens == null))
      return <span className="text-xs text-muted-foreground">Usage unavailable</span>;
    return (
      <span className="text-xs text-muted-foreground">
        {rows.reduce((n, r) => n + (r.input_tokens ?? 0), 0)} input ·{" "}
        {rows.reduce((n, r) => n + (r.output_tokens ?? 0), 0)} output ·{" "}
        {rows.reduce((n, r) => n + (r.cached_tokens ?? 0), 0)} cached tokens
      </span>
    );
  } catch {
    return null;
  }
}

function GeneratedTitle({ result }: { result: string | null }) {
  try {
    const title = result ? (JSON.parse(result) as { title?: string }).title : undefined;
    return title ? <p className="text-sm">Title: {title}</p> : null;
  } catch {
    return null;
  }
}

function ReviewBoundary({ sessionId, payload, result }: { sessionId: string; payload: string; result: string | null }) {
  try {
    const boundary = JSON.parse(payload) as { sourceRunId?: string; cut?: string; through?: number };
    const finished = result ? (JSON.parse(result) as { through?: number }) : null;
    return (
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer">Review boundary</summary>
        <div className="flex flex-col gap-2 py-2">
          {boundary.sourceRunId && (
            <a className="underline" href={sessionHref(sessionId, `a:${boundary.sourceRunId}`)}>
              Open reply at review cut
            </a>
          )}
          <span>Cut entry: {boundary.cut ?? "Unavailable"}</span>
          <span>Reviewed cursor: {finished?.through ?? "Pending"}</span>
        </div>
      </details>
    );
  } catch {
    return null;
  }
}
