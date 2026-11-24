import type {
  CapabilityChange,
  CapabilitySearchDetails,
  LoadReason,
  Message,
  OfferedToolChanges,
  ScriptCall,
  StepDetailResponse,
  StepSummary,
  ToolOutputPart,
  WebDocumentResponse,
  WebFetchDetails,
} from "@rei/protocol";
import { useEffect, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { cn } from "@/lib/utils.ts";
import type { Api } from "../../api/client.ts";
import { ApiError, describeError } from "../../api/client.ts";
import type { ApprovalOutcomes } from "../../lib/activity.ts";
import { activityIcon, activityLabel, activityStatus, isScriptStep } from "../../lib/activity.ts";
import { sessionHref } from "../../lib/route.ts";
import { formatWhen } from "../../lib/time.ts";
import {
  actionClassLabel,
  DECISION_LABEL,
  describeRequest,
  describeResponse,
  duration,
  promptSectionLabel,
  sectionChanges,
  systemSections,
} from "../../lib/trace.ts";
import { Icon } from "../Icon.tsx";
import { CodeBlock } from "../Markdown.tsx";
import { Tip } from "../Tip.tsx";
import { FACTS, NOTE, NOTE_ERROR, QUIET, SECTION } from "./factStyles.ts";
import { Tabs } from "./Tabs.tsx";
import { JsonView, LongText, pretty } from "./Text.tsx";

interface Props {
  api: Api;
  sessionId: string;
  step: StepSummary;
  /** The chat's messages, to link a decision to its approval message. */
  messages: Message[];
  /** What became of each approval in the chat, so this step reads the same as its row in the chat. */
  outcomes: ApprovalOutcomes;
  /** Opens another step of the session, e.g. the search that loaded a tool. */
  onOpenStep?: ((stepId: string) => void) | undefined;
  /** The recorded step of a tool call, by the call's id (a script's call list opens its steps). */
  findStep?: ((toolCallId: string) => StepSummary | undefined) | undefined;
  /** Changes when the trace gains or changes steps under this one, so a running script's call list stays current. */
  revision?: number | undefined;
}

/** A collapsible block of recorded text: a summary row that opens to the text. */
const ITEM =
  "ctx-item mt-1.5 rounded-lg border bg-card text-sm [&>.long-text]:m-2.5 [&>p]:m-2.5 [&>summary]:flex [&>summary]:min-h-9 [&>summary]:cursor-pointer [&>summary]:items-baseline [&>summary]:gap-2 [&>summary]:px-2.5 [&>summary]:py-1.5 [&>summary]:font-medium [&[open]>summary]:border-b";
/** The small label at the start of a summary row ("user", "tools"). */
const ROLE = "ctx-role shrink-0 rounded-full bg-muted px-2 text-[0.6875rem] font-semibold tracking-wide uppercase";

type LlmTab = "context" | "response" | "raw" | "stats";

/** One step in full: for a model call, the exact request and response; for a tool call, the policy's decision, input and output. */
export function StepDetail({ api, sessionId, step, messages, outcomes, onOpenStep, findStep, revision = 0 }: Props) {
  const [detail, setDetail] = useState<StepDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<LlmTab>("context");

  // biome-ignore lint/correctness/useExhaustiveDependencies: a step's status and its script's calls change what the server returns, so they reload the detail.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.getStep(step.id).then(
      (d) => !cancelled && setDetail(d),
      (e) => !cancelled && setError(describeError(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [api, step.id, step.status, revision]);

  return (
    <div className="step-detail flex min-w-0 flex-col gap-2.5">
      <p className="step-detail-title m-0 flex min-w-0 items-center gap-2 text-sm font-semibold [overflow-wrap:anywhere]">
        <Icon name={activityIcon(step, outcomes)} size={16} />
        <span>{activityLabel(step)}</span>
      </p>
      {error && (
        <p className="form-error m-0" role="alert">
          {error}
        </p>
      )}
      {detail?.llm?.error && (
        <p className={NOTE_ERROR} role="note">
          <Icon name="alert" size={16} />
          <span>{detail.llm.error.message}</span>
        </p>
      )}
      {!detail && !error && (
        <p className={QUIET} role="status">
          Loading…
        </p>
      )}
      {step.type === "llm.call" ? (
        <Tabs<LlmTab>
          label="Model call"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "context", label: "Context" },
            { id: "response", label: "Response" },
            { id: "raw", label: "Raw" },
            { id: "stats", label: "Stats" },
          ]}
        >
          {tab === "stats" ? (
            <Stats step={step} detail={detail} />
          ) : !detail?.llm ? null : tab === "context" ? (
            <>
              {detail.llm.tools && <OfferedTools tools={detail.llm.tools} onOpenStep={onOpenStep} />}
              <Context request={detail.llm.request} truncated={detail.truncated} />
            </>
          ) : tab === "response" ? (
            <Response response={detail.llm.response} />
          ) : (
            <>
              {detail.truncated && <p className={NOTE}>Some long text was cut to 200,000 characters.</p>}
              <JsonView value={detail.llm} label="Raw" />
            </>
          )}
        </Tabs>
      ) : step.type === "capabilities.changed" ? (
        <ChangeDetail step={step} change={detail?.change} />
      ) : (
        <ToolDetail
          api={api}
          step={step}
          detail={detail}
          sessionId={sessionId}
          messages={messages}
          outcomes={outcomes}
          onOpenStep={onOpenStep}
          findStep={findStep}
        />
      )}
    </div>
  );
}

/** An untagged section is named by its first words. */
const opening = (body: string): string => {
  const line = body.split("\n", 1)[0]!.trim();
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line || "Untitled";
};

function Context({ request, truncated }: { request: unknown; truncated: boolean }) {
  const view = describeRequest(request);
  if (!view.recognised)
    return (
      <p className={QUIET}>This request has a shape the inspector can't lay out. The Raw tab shows it as recorded.</p>
    );
  const sections = view.system ? systemSections(view.system) : [];
  const updates = view.messages.filter((m) => m.update).length;
  return (
    <div className="ctx flex min-w-0 flex-col gap-2.5">
      {truncated && <p className={NOTE}>Some long text was cut to 200,000 characters.</p>}
      {view.system !== null && (
        <section aria-label="System prompt">
          <h4 className={SECTION}>System prompt{sections.length > 1 ? ` · ${sections.length} sections` : ""}</h4>
          {sections.length > 1 ? (
            sections.map((s, i) => (
              <details key={i} className={ITEM}>
                <summary>{s.title ? promptSectionLabel(s.title) : opening(s.body)}</summary>
                <LongText text={s.body} />
              </details>
            ))
          ) : (
            <details className={ITEM} open>
              <summary>System prompt</summary>
              <LongText text={view.system} />
            </details>
          )}
        </section>
      )}
      <section aria-label="Messages">
        <h4 className={SECTION}>
          Messages · {view.messages.length}
          {updates > 0 ? ` (${updates} prompt update${updates === 1 ? "" : "s"}, in the order sent)` : ""}
        </h4>
        {view.messages.map((m, i) =>
          m.update ? (
            <PromptUpdate key={i} text={m.text} />
          ) : (
            <details key={i} className={ITEM}>
              <summary>
                <span className={ROLE}>{m.role}</span>
                <span className="ctx-peek min-w-0 truncate font-normal text-muted-foreground">
                  {(m.text || m.calls[0] || (m.other ? `${m.other} attachment${m.other === 1 ? "" : "s"}` : ""))
                    .replace(/\s+/g, " ")
                    .slice(0, 90)}
                </span>
              </summary>
              {m.reasoning && (
                <>
                  <p className={NOTE}>Reasoning</p>
                  <LongText text={m.reasoning} />
                </>
              )}
              {m.text && <LongText text={m.text} />}
              {m.calls.map((c, k) => (
                <LongText key={k} text={`→ ${c}`} className="font-mono" />
              ))}
              {m.other > 0 && (
                <p className={NOTE}>
                  {m.other} attachment{m.other === 1 ? "" : "s"} not shown here (see Raw).
                </p>
              )}
            </details>
          ),
        )}
      </section>
      {view.tools.length > 0 && (
        <section aria-label="Tools">
          <h4 className={SECTION}>Tools · {view.tools.length}</h4>
          {view.tools.map((t) => (
            <details key={t.name} className={ITEM}>
              <summary>
                <span className="min-w-0 truncate font-mono">{t.name}</span>
              </summary>
              {t.description && <LongText text={t.description} />}
              {t.schema !== null && <LongText text={pretty(t.schema)} className="font-mono" />}
            </details>
          ))}
        </section>
      )}
    </div>
  );
}

/** A system message sent mid-conversation: Pi resending a prompt section whose text changed, or dropping one. */
function PromptUpdate({ text }: { text: string }) {
  const changes = sectionChanges(text);
  const peek = changes.map((c) => (c.name ? `${c.change} ${c.name}` : "system message")).join(" · ");
  return (
    <details className={cn(ITEM, "ctx-update border-dashed")}>
      <summary>
        <span className={ROLE}>prompt update</span>
        <span className="ctx-peek min-w-0 truncate font-normal text-muted-foreground">{peek}</span>
      </summary>
      {changes.map((c, i) => (
        <div
          key={i}
          className="ctx-change [&:not(:first-child)]:border-t [&>.long-text]:m-2.5 [&>p]:mx-2.5 [&>p]:mt-2.5"
        >
          {c.name && (
            <p className={NOTE}>
              {c.change === "removed"
                ? `Section "${c.name}" was taken out of the prompt.`
                : `Section "${c.name}" replaced by:`}
            </p>
          )}
          {c.body && <LongText text={c.body} />}
        </div>
      ))}
    </details>
  );
}

function Response({ response }: { response: unknown }) {
  const view = describeResponse(response);
  if (!view.recognised) return <p className={QUIET}>No readable answer was recorded. The Raw tab shows what was.</p>;
  return (
    <div className="ctx flex min-w-0 flex-col gap-2.5">
      {view.reasoning && (
        <section aria-label="Reasoning">
          <h4 className={SECTION}>Reasoning</h4>
          <LongText text={view.reasoning} />
        </section>
      )}
      {view.text && <LongText text={view.text} />}
      {view.calls.length > 0 && (
        <section aria-label="Tool calls" className="flex flex-col gap-2">
          <h4 className={cn(SECTION, "mb-0")}>Tool calls</h4>
          {view.calls.map((c, i) => (
            <LongText key={i} text={c} className="font-mono" />
          ))}
        </section>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

function Stats({ step, detail }: { step: StepSummary; detail: StepDetailResponse | null }) {
  const t = step.tokens;
  const num = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toLocaleString());
  return (
    <dl className={FACTS}>
      <Row k="Model" v={step.model ?? "–"} />
      <Row k="Provider" v={step.providerName ?? "–"} />
      <Row k="Status" v={activityStatus(step) + (step.errorCode ? ` (${step.errorCode})` : "")} />
      <Row k="Started" v={formatWhen(step.startedAt)} />
      <Row k="Input tokens" v={num(t?.input)} />
      <Row k="Output tokens" v={num(t?.output)} />
      <Row k="Cached tokens" v={num(t?.cached)} />
      {step.prefix && (
        <Row
          k="Same start as last call"
          v={step.prefix.matched === null ? "First call" : `${step.prefix.matched} of ${step.prefix.items} items`}
        />
      )}
      <Row k="Reasoning tokens" v={num(t?.reasoning)} />
      <Row k="Total tokens" v={num(t?.total)} />
      <Row
        k="First byte"
        v={step.firstByteMs === null || step.firstByteMs === undefined ? "–" : duration(step.firstByteMs)}
      />
      <Row k="Latency" v={duration(step.latencyMs)} />
      {detail && (
        <Row k="Recorded size" v={`${detail.payloadBytes.toLocaleString()} bytes${detail.truncated ? " (cut)" : ""}`} />
      )}
    </dl>
  );
}

function ToolDetail({
  api,
  step,
  detail,
  sessionId,
  messages,
  outcomes,
  onOpenStep,
  findStep,
}: {
  api: Api;
  step: StepSummary;
  detail: StepDetailResponse | null;
  sessionId: string;
  messages: Message[];
  outcomes: ApprovalOutcomes;
  onOpenStep: ((stepId: string) => void) | undefined;
  findStep: ((toolCallId: string) => StepSummary | undefined) | undefined;
}) {
  const code = isScriptStep(step) ? scriptCode(detail?.tool?.input) : null;
  const approvalMsg = step.approvalId
    ? messages.find((m) => m.role === "approval" && m.approval?.id === step.approvalId)
    : undefined;
  const decision = step.decision ? DECISION_LABEL[step.decision] : "–";
  return (
    <>
      <dl className={FACTS}>
        <Row k="Tool" v={step.toolName ?? "–"} />
        <Row k="Class" v={actionClassLabel(step.actionClass) || "–"} />
        <Row
          k="Decision"
          v={
            <>
              {decision}
              {step.approvalId && (
                <>
                  {" · "}
                  {approvalMsg ? <a href={sessionHref(sessionId, approvalMsg.id)}>See the approval</a> : "approval"}
                </>
              )}
            </>
          }
        />
        <Row k="Status" v={activityStatus(step, outcomes)} />
        {step.summary && <Row k="Summary" v={step.summary} />}
        <Row k="Started" v={formatWhen(step.startedAt)} />
        <Row k="Time" v={duration(step.latencyMs)} />
        {step.sideEffect && <Row k="Effect" v="Acted outside the box" />}
      </dl>
      {detail?.tool && (
        <div className="ctx flex min-w-0 flex-col gap-2.5">
          {detail.truncated && <p className={NOTE}>Some long text was cut to 200,000 characters.</p>}
          {detail.tool.isError && (
            <p className={NOTE_ERROR} role="note">
              <Icon name="alert" size={16} />
              <span>The tool reported an error.</span>
            </p>
          )}
          {detail.tool.discovery && <Discovery details={detail.tool.discovery} />}
          {detail.tool.fetch && <WebFetch api={api} stepId={step.id} details={detail.tool.fetch} />}
          {code !== null ? (
            <section aria-label="Code">
              <h4 className={SECTION}>Code</h4>
              <CodeBlock lang="javascript" text={code} lineNumbers />
            </section>
          ) : (
            <JsonView value={detail.tool.input} label="Input" />
          )}
          <section aria-label="Output">
            <h4 className={SECTION}>Output</h4>
            {isScriptStep(step) && <ScriptOutputNote output={detail.tool.output} />}
            {detail.tool.output.length === 0 && <p className={QUIET}>No output.</p>}
            {detail.tool.output.map((o, i) =>
              o.type === "text" ? (
                <LongText key={i} text={o.text} />
              ) : (
                <a
                  key={i}
                  className="step-image"
                  href={`/api/steps/${encodeURIComponent(step.id)}/images/${o.index}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img
                    className="block max-w-full rounded-lg border"
                    src={`/api/steps/${encodeURIComponent(step.id)}/images/${o.index}`}
                    alt={`Image ${o.index + 1} from ${step.toolName ?? "the tool"}`}
                    loading="lazy"
                  />
                </a>
              ),
            )}
          </section>
          {detail.tool.script && (
            <ScriptCalls script={step} calls={detail.tool.script.calls} onOpenStep={onOpenStep} findStep={findStep} />
          )}
        </div>
      )}
    </>
  );
}

/** The script's source, when the recorded input is the `{ code }` the tool takes. */
function scriptCode(input: unknown): string | null {
  const code = (input as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

/** What Pi writes into a script's output when it had to cut it: the warning line and, if it could save it, the file's path. */
function cutOutput(output: ToolOutputPart[]) {
  const text = output.map((o) => (o.type === "text" ? o.text : "")).join("\n");
  if (!/^Warning: truncated output/m.test(text)) return null;
  return { path: /\[Full output: (.+?) \(read with offset\/limit\)\]/.exec(text)?.[1] ?? null };
}

/** Said above a script's output when the model saw a shortened copy of it. */
function ScriptOutputNote({ output }: { output: ToolOutputPart[] }) {
  const cut = cutOutput(output);
  if (!cut) return null;
  return (
    <p className={cn(NOTE, "mb-1.5")} role="note">
      The script printed more than fits, so the model saw a shortened copy.
      {cut.path ? (
        <>
          {" "}
          The full output is saved at <code className="font-mono [overflow-wrap:anywhere]">{cut.path}</code>.
        </>
      ) : (
        " The full output could not be saved."
      )}
    </p>
  );
}

const CALL_STATUS: Record<ScriptCall["status"], string> = {
  running: "Running",
  ok: "Completed",
  error: "Failed",
  cancelled: "Stopped",
};

/** The calls a script made, in order. Each opens its own step when the trace has it. */
function ScriptCalls({
  script,
  calls,
  onOpenStep,
  findStep,
}: {
  script: StepSummary;
  calls: ScriptCall[];
  onOpenStep: ((stepId: string) => void) | undefined;
  findStep: ((toolCallId: string) => StepSummary | undefined) | undefined;
}) {
  return (
    <section aria-label="Calls">
      <h4 className={SECTION}>Calls · {calls.length}</h4>
      {calls.length === 0 ? (
        <p className={QUIET}>The script made no calls.</p>
      ) : (
        <ol className="script-calls m-0 flex list-none flex-col gap-1 p-0">
          {calls.map((c) => {
            const nested = script.toolCallId ? findStep?.(`${script.toolCallId}/c${c.id}`) : undefined;
            const body = (
              <>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="font-mono text-sm text-foreground">{c.name}</span>
                    <span
                      className={cn(
                        "ml-auto shrink-0 text-xs tabular-nums text-muted-foreground",
                        c.status === "error" && "text-destructive",
                      )}
                    >
                      {CALL_STATUS[c.status]}
                      {c.durationMs !== undefined ? ` · ${duration(c.durationMs)}` : ""}
                    </span>
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{c.args}</span>
                  {c.error && <span className="text-xs text-destructive [overflow-wrap:anywhere]">{c.error}</span>}
                </span>
                {nested && onOpenStep && <Icon name="forward" size={14} className="shrink-0 text-muted-foreground" />}
              </>
            );
            const row = "flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-sm";
            return (
              <li key={c.id}>
                {nested && onOpenStep ? (
                  <button
                    type="button"
                    className={cn(
                      row,
                      "w-full outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30",
                    )}
                    aria-label={`Inspect call: ${c.name} — ${CALL_STATUS[c.status]}`}
                    onClick={() => onOpenStep(nested.id)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className={row}>{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

const CACHE_LABEL: Record<WebFetchDetails["cache"], string> = {
  hit: "Stored copy (no network)",
  miss: "Fetched (nothing stored)",
  refresh: "Fetched again (refresh)",
};
const MODE_LABEL: Record<NonNullable<WebFetchDetails["mode"]>, string> = {
  overview: "Outline and opening",
  whole: "Whole page",
  query: "Passages matching the query",
  section: "One section",
  offset: "Text from an offset",
};

/** How a web_fetch got its page and what it showed the model; the stored copy opens here, never in the model's context. */
const METHOD_LABEL: Record<WebFetchDetails["method"], string> = {
  http: "HTTP",
  render: "Rendered in the browser",
};
const RENDER_SKIPPED: Record<NonNullable<NonNullable<WebFetchDetails["render"]>["skipped"]>, string> = {
  off: "Not rendered: disabled by the reader request",
  unavailable: "Not rendered: the page reader has no browser",
};

/** How the call rendered its page, or why it did not (ADR 0017). */
function renderSummary(r: NonNullable<WebFetchDetails["render"]>): string {
  if (r.skipped) return RENDER_SKIPPED[r.skipped];
  if (r.failed) return "The render failed; the page as fetched was used";
  const parts = [
    r.reason === "forced"
      ? "Forced (dev diagnostic)"
      : r.reason === "low_quality"
        ? "Only the page's summary could be read without JavaScript"
        : "Page needs JavaScript",
  ];
  if (r.ended) parts.push(r.ended === "stable" ? "read once the text settled" : "read at the deadline");
  if (r.truncated) parts.push("HTML cut at 5 MiB");
  return parts.join(", ");
}

function WebFetch({ api, stepId, details: d }: { api: Api; stepId: string; details: WebFetchDetails }) {
  const [copy, setCopy] = useState<WebDocumentResponse | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const num = (v: number | undefined) => (v === undefined ? "–" : v.toLocaleString());
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !copy) {
      setCopyError(null);
      api
        .getStepWebDocument(stepId)
        .then(setCopy, (e) =>
          setCopyError(
            e instanceof ApiError && e.status === 404
              ? "This page is no longer stored. Stored copies are kept for a day."
              : describeError(e),
          ),
        );
    }
  };
  const showCopy = !d.error;
  return (
    <section aria-label="Fetch">
      <div className="flex items-center justify-between gap-2">
        <h4 className={SECTION}>Fetch</h4>
        {showCopy && (
          <Tip label={open ? "Hide the stored copy" : "Open the stored copy"}>
            <Button
              type="button"
              variant={open ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label="Stored copy"
              aria-expanded={open}
              onClick={toggle}
            >
              <Icon name="page" size={16} />
            </Button>
          </Tip>
        )}
      </div>
      <dl className={FACTS}>
        <Row k="Host" v={d.host} />
        {d.title && <Row k="Title" v={d.title} />}
        <Row k="Source" v={CACHE_LABEL[d.cache]} />
        <Row k="Method" v={METHOD_LABEL[d.method]} />
        {d.render && <Row k="Rendering" v={renderSummary(d.render)} />}
        {d.render?.queueMs !== undefined && d.render.queueMs > 0 && (
          <Row k="Waited for the browser" v={duration(d.render.queueMs)} />
        )}
        {d.render?.engine && (
          <Row
            k="Render engine"
            v={`${d.render.engine}${d.render.engineVersion ? ` ${d.render.engineVersion}` : ""}${d.render.fallback ? ` (fallback after ${d.render.fallback.from}: ${d.render.fallback.reason})` : ""}`}
          />
        )}
        {d.render?.renderMs !== undefined && <Row k="Render time" v={duration(d.render.renderMs)} />}
        {d.render?.connections !== undefined && (
          <Row
            k="Render connections"
            v={`${num(d.render.connections)}${d.render.refused ? `, ${num(d.render.refused)} refused` : ""}`}
          />
        )}
        {d.render?.blockedMedia !== undefined && d.render.blockedMedia > 0 && (
          <Row k="Media not loaded" v={num(d.render.blockedMedia)} />
        )}
        {d.mode && <Row k="Shown" v={MODE_LABEL[d.mode]} />}
        {d.sections && d.sections.length > 0 && (
          <Row k="Sections" v={<span className="font-mono text-xs">{d.sections.join(", ")}</span>} />
        )}
        {d.status !== undefined && <Row k="HTTP status" v={String(d.status)} />}
        {d.redirects !== undefined && <Row k="Redirects" v={String(d.redirects)} />}
        {d.mediaType && <Row k="Media type" v={d.mediaType} />}
        {d.bytes !== undefined && <Row k="Downloaded" v={`${num(d.bytes)} bytes`} />}
        {d.extractor && <Row k="Extractor" v={d.extractor} />}
        {d.quality && <Row k="Quality" v={d.quality} />}
        {d.tokensReturned !== undefined && <Row k="Tokens returned" v={num(d.tokensReturned)} />}
        {d.pageTokens !== undefined && <Row k="Tokens on the page" v={num(d.pageTokens)} />}
        <Row k="Duration" v={duration(d.durationMs)} />
      </dl>
      {open && (
        <div className="web-copy mt-1.5 flex min-w-0 flex-col gap-1.5">
          {copyError && <p className={QUIET}>{copyError}</p>}
          {!copy && !copyError && <p className={QUIET}>Loading the stored copy…</p>}
          {copy && (
            <>
              <p className={QUIET}>
                Stored {formatWhen(copy.fetchedAt)}, kept until {formatWhen(copy.expiresAt)}. This copy is for you; the
                model only sees what the output below shows.
              </p>
              <LongText text={copy.text} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

const LOAD_REASON: Record<LoadReason, string> = {
  group: "its group matched",
  ranked: "ranked for the query",
  load: "named in load",
};

/** A short list of names under a label; nothing when empty. */
function Names({ label, names, empty }: { label: string; names: string[]; empty?: string }) {
  if (names.length === 0 && !empty) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd className="font-mono text-xs">
        {names.length ? names.join(", ") : <span className="font-sans">{empty}</span>}
      </dd>
    </div>
  );
}

/** What a search_capabilities call searched, ranked, loaded and suggested. */
function Discovery({ details }: { details: CapabilitySearchDetails }) {
  return (
    <section aria-label="Discovery">
      <h4 className={SECTION}>Discovery</h4>
      <dl className={FACTS}>
        {details.query && <Row k="Query" v={`“${details.query}”`} />}
        {details.directory && (
          <Row
            k="Directory"
            v={`${details.directory.connectorName}: ${details.directory.tools} tool${details.directory.tools === 1 ? "" : "s"} listed, none loaded`}
          />
        )}
        <div>
          <dt>Loaded</dt>
          <dd>
            {details.loaded.length === 0 ? (
              "Nothing"
            ) : (
              <ul className="m-0 list-none p-0">
                {details.loaded.map((l) => (
                  <li key={l.name}>
                    <span className="font-mono text-xs">{l.name}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {LOAD_REASON[l.reason]}
                      {l.group ? ` (${l.group})` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <Names label="Already loaded" names={details.alreadyLoaded} />
        <Names label="Also relevant" names={details.alsoRelevant} />
        <Names label="Skills" names={details.skills} />
        <Names label="Not found" names={details.notFound} />
      </dl>
      {details.candidates.length > 0 && (
        <details className={ITEM}>
          <summary>Ranked candidates · {details.candidates.length}</summary>
          <table className="m-2.5 w-[calc(100%-1.25rem)] text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-start font-medium">Name</th>
                <th className="text-start font-medium">Kind</th>
                <th className="text-end font-medium">Terms matched</th>
                <th className="text-end font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {details.candidates.map((c) => (
                <tr key={`${c.kind}:${c.name}`}>
                  <td className="font-mono [overflow-wrap:anywhere]">{c.name}</td>
                  <td>{c.kind}</td>
                  <td className="text-end">{Math.round(c.coverage * 100)}%</td>
                  <td className="text-end">{c.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}

/** The tools a model call was offered and what changed since the previous call, each load linked to its search. */
function OfferedTools({
  tools,
  onOpenStep,
}: {
  tools: OfferedToolChanges;
  onOpenStep?: ((stepId: string) => void) | undefined;
}) {
  const changed = tools.added.length + tools.removed.length > 0;
  return (
    <section aria-label="Offered tools" className="flex min-w-0 flex-col">
      <h4 className={SECTION}>Offered tools · {tools.offered.length}</h4>
      {!tools.previousStepId ? (
        <p className={NOTE}>The first model call of this chat: its core tools.</p>
      ) : !changed ? (
        <p className={NOTE}>The same tools as the previous model call.</p>
      ) : (
        <ul
          className="m-0 flex list-none flex-col gap-1 p-0 text-sm"
          aria-label="Changes since the previous model call"
        >
          {tools.added.map((a) => (
            <li key={`+${a.name}`} className="flex flex-wrap items-baseline gap-x-1.5">
              <span aria-hidden="true">+</span>
              <span className="font-mono text-xs">{a.name}</span>
              <span className="text-muted-foreground">
                {a.loadedBy ? (
                  <>
                    loaded by{" "}
                    {onOpenStep ? (
                      <button
                        type="button"
                        className="cursor-pointer underline underline-offset-2"
                        onClick={() => onOpenStep(a.loadedBy!)}
                      >
                        a search
                      </button>
                    ) : (
                      "a search"
                    )}
                    {a.reason ? ` (${LOAD_REASON[a.reason]}${a.group ? `: ${a.group}` : ""})` : ""}
                  </>
                ) : (
                  "offered again or added by a capability change"
                )}
              </span>
            </li>
          ))}
          {tools.removed.map((name) => (
            <li key={`-${name}`} className="flex flex-wrap items-baseline gap-x-1.5">
              <span aria-hidden="true">−</span>
              <span className="font-mono text-xs">{name}</span>
              <span className="text-muted-foreground">no longer offered</span>
            </li>
          ))}
        </ul>
      )}
      <details className={ITEM}>
        <summary>All offered tools</summary>
        <p className="font-mono text-xs [overflow-wrap:anywhere]">{tools.offered.join(", ")}</p>
      </details>
    </section>
  );
}

/** Connector tools that came, went or changed in the open conversation while the run went on. */
function ChangeDetail({ step, change }: { step: StepSummary; change: CapabilityChange | undefined }) {
  return (
    <>
      <dl className={FACTS}>
        {change && <Row k="Connectors" v={change.connectors.join(", ")} />}
        <Row k="Seen" v={formatWhen(step.startedAt)} />
      </dl>
      {change && (
        <dl className={FACTS}>
          <Names label="Added" names={change.added} />
          <Names label="Removed" names={change.removed} />
          <Names label="Changed" names={change.changed} />
        </dl>
      )}
      <p className={NOTE}>
        Added tools wait to be loaded with search_capabilities. A removed tool stops being offered from the next model
        call; a changed one stays loaded under its new definition.
      </p>
    </>
  );
}
