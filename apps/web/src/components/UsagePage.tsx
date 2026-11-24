import {
  type ImageFailureReason,
  type ImageUsageResponse,
  type SearchAttemptOutcome,
  type SearchUsageDetail,
  type SearchUsageProvider,
  type SearchUsageResponse,
  USAGE_PERIODS,
  type UsageMetric,
  type UsagePeriod,
  type UsagePurpose,
  type UsageResponse,
  type UsageTotals,
} from "@rei/protocol";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Card } from "@/components/primitives/card.tsx";
import { Empty, EmptyDescription } from "@/components/primitives/empty.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { Label } from "@/components/primitives/label.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/primitives/toggle-group.tsx";
import type { Api } from "../api/client.ts";
import { Icon } from "./Icon.tsx";
import { InfoTip } from "./InfoTip.tsx";
import { PageShell } from "./PageShell.tsx";

const LABELS: Record<UsagePurpose, string> = {
  chat: "Chat",
  memory: "Memory maintenance",
  title: "Titles",
  agent_task: "Agent tasks",
  other: "Other",
};
const PERIODS: Record<UsagePeriod, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "This month",
  year: "This year",
  all: "All time",
  custom: "Custom range",
};
const CARDS: [UsageMetric, string][] = [
  ["inputTotal", "Total input"],
  ["inputCached", "Cached input"],
  ["inputUncached", "Uncached input"],
  ["outputTotal", "Output"],
  ["totalProcessed", "Total processed"],
];
const DEFINITIONS: Record<UsageMetric, string> = {
  reasoningOutput: "Reasoning tokens, already included in output.",
  inputTotal: "All input tokens, including cached input. Memory injected into chat is counted once as chat input.",
  inputCached: "Input tokens served from the provider's prompt cache.",
  inputUncached: "Input tokens that were not served from the provider's prompt cache.",
  outputTotal: "All output tokens, including reasoning tokens.",
  totalProcessed: "Total input and output tokens processed by the model.",
};
const USAGE_CARD_GRID =
  "usage-cards m-0 grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(140px,1fr))] [&>div]:rounded-2xl [&>div]:border [&>div]:p-4 [&_dt]:flex [&_dt]:items-center [&_dt]:gap-1 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:mt-2 [&_dd]:text-xl [&_dd]:font-semibold [&_dd]:tabular-nums [&_dd]:[overflow-wrap:anywhere]";
const SEARCH_OUTCOMES: Record<SearchAttemptOutcome, string> = {
  succeeded: "Succeeded",
  empty: "Empty result",
  failed: "Failed",
  skipped: "Skipped",
};
const SEARCH_REASONS: Record<string, string> = {
  not_configured: "not configured",
  rate_limited: "rate limited",
  search_rate_limited: "rate limited",
  timeout: "timed out",
  search_timeout: "timed out",
  search_failed: "search failed",
  fetch_failed: "could not be reached",
};
const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const number = (n: number) => compactNumber.format(n);
function duration(ms: number): string {
  return ms > 1000 ? `${Math.ceil(ms / 1000).toLocaleString("en-US")} s` : `${ms.toLocaleString("en-US")} ms`;
}
function token(u: UsageTotals, metric: UsageMetric): string {
  const n = u.tokens[metric];
  return n === null ? "Unavailable" : number(n);
}
/** A UTC day, YYYY-MM-DD, `offset` days from today. Periods and date inputs use UTC, as the server does. */
const utcDay = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export function UsagePage({ api }: { api: Api }) {
  const [period, setPeriod] = useState<UsagePeriod>("30d");
  const [range, setRange] = useState(() => ({ from: utcDay(-29), to: utcDay() }));
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState(false);
  const fromId = useId();
  const toId = useId();
  const rangeProblem =
    period !== "custom"
      ? ""
      : !range.from || !range.to
        ? "Choose both dates to see usage."
        : range.from > range.to
          ? "The To date must be on or after the From date."
          : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `retry` re-runs the request after "Try again"; the request does not read it.
  useEffect(() => {
    if (rangeProblem) return;
    let current = true;
    setData(null);
    setError(false);
    (period === "custom" ? api.getUsage(period, range) : api.getUsage(period)).then(
      (r) => {
        if (current) setData(r);
      },
      () => {
        if (current) setError(true);
      },
    );
    return () => {
      current = false;
    };
  }, [api, period, range, rangeProblem, retry]);
  return (
    <PageShell title="Usage" className="usage-page min-w-0">
      <div className="usage-period flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          spacing={1}
          className="max-w-full flex-wrap"
          aria-label="Usage period"
          value={period}
          onValueChange={(value) => value && setPeriod(value as UsagePeriod)}
        >
          {USAGE_PERIODS.map((p) => (
            <ToggleGroupItem key={p} value={p}>
              {PERIODS[p]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {period === "custom" && (
          <div className="usage-range flex flex-wrap gap-x-3.5 gap-y-2 max-md:[&>div]:flex-[1_1_10rem]">
            <div className="field-inline flex items-center gap-2 text-sm text-muted-foreground">
              <Label htmlFor={fromId} className="text-muted-foreground">
                From
              </Label>
              <Input
                id={fromId}
                type="date"
                className="w-auto flex-1"
                value={range.from}
                max={range.to || utcDay()}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              />
            </div>
            <div className="field-inline flex items-center gap-2 text-sm text-muted-foreground">
              <Label htmlFor={toId} className="text-muted-foreground">
                To
              </Label>
              <Input
                id={toId}
                type="date"
                className="w-auto flex-1"
                value={range.to}
                min={range.from || undefined}
                max={utcDay()}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              />
            </div>
          </div>
        )}
      </div>
      {rangeProblem ? (
        <p role="alert" className="form-error m-0 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          {rangeProblem}
        </p>
      ) : error ? (
        <div
          role="alert"
          className="form-error m-0 flex items-center justify-between gap-2 rounded-2xl bg-destructive/10 px-3 py-2.5 text-sm text-destructive [overflow-wrap:anywhere]"
        >
          Could not load usage.{" "}
          <Button variant="ghost" size="sm" type="button" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : !data ? (
        <span className="spinner" role="status" aria-label="Loading usage" />
      ) : (
        <>
          <p className="m-0 text-sm text-muted-foreground">Since {data.trackingSince.slice(0, 10)} (UTC)</p>
          <p className="m-0 text-xs text-muted-foreground">
            {data.from} to {data.to} · UTC
          </p>
          {!data.summary.modelCalls && (
            <Empty className="usage-empty border py-8">
              <EmptyDescription>
                {data.period === "all" || data.from === data.trackingSince.slice(0, 10)
                  ? "No usage recorded since tracking began"
                  : "No usage recorded in this period"}
              </EmptyDescription>
            </Empty>
          )}
          <dl className={USAGE_CARD_GRID}>
            {CARDS.map(([m, label]) => (
              <Card key={m} className="gap-0 py-0">
                <dt>
                  {label}
                  <InfoTip label={`About ${label.toLowerCase()}`}>{DEFINITIONS[m]}</InfoTip>
                </dt>
                <dd>{token(data.summary, m)}</dd>
              </Card>
            ))}
            <Card className="gap-0 py-0">
              <dt>
                Cache hit
                <InfoTip label="About cache hit">
                  The share of input tokens served from the provider's prompt cache, counted over calls that reported
                  both input and cached tokens. Other calls are left out.
                </InfoTip>
              </dt>
              <dd>{cacheHitLabel(data.summary.cacheHitPercent)}</dd>
            </Card>
            <Card className="gap-0 py-0">
              <dt>Model calls</dt>
              <dd>{number(data.summary.modelCalls)}</dd>
            </Card>
          </dl>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{number(data.summary.callsUnreported)} calls with missing or unreliable reports</span>
            <InfoTip label="About unreliable reports">
              Unavailable means no reliable report. Totals count only calls with reliable reports. Cache hit leaves out
              calls that lack an input or cached count. Interrupted calls without a completion report are excluded.
              Aggregate counters persist regardless of detailed log expiration.
            </InfoTip>
          </div>
          <UsageTable
            title="By purpose"
            rows={data.byPurpose.map((r) => ({ label: LABELS[r.purpose], usage: r.usage }))}
          />
          {!!data.byModel.length && (
            <UsageTable
              title="By model"
              cacheHit
              rows={data.byModel.map((r) => ({ label: `${r.providerName} / ${r.model}`, usage: r.usage }))}
            />
          )}
          <SearchUsage search={data.search} />
          <ImageUsage images={data.images} />
        </>
      )}
    </PageShell>
  );
}
function cacheHitLabel(percent: number | null): string {
  return percent === null ? "Unavailable" : `${percent.toFixed(1)}%`;
}
function UsageTable({
  title,
  rows,
  cacheHit = false,
}: {
  title: string;
  rows: { label: string; usage: UsageTotals }[];
  cacheHit?: boolean;
}) {
  return (
    <section className="usage-breakdown min-w-0 [&>h4]:mb-3 [&>h4]:text-sm [&>h4]:font-medium">
      <h4>{title}</h4>
      <div
        className="usage-table-wrap max-w-full overflow-x-auto rounded-2xl border outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        tabIndex={0}
        role="region"
        aria-label={`${title} usage table`}
      >
        <table className="usage-table min-w-[28rem] [&_th:first-child]:min-w-40 w-full border-collapse text-xs [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:px-3 [&_th]:py-3 [&_th]:text-right [&_th]:font-medium [&_td]:whitespace-nowrap [&_td]:border-b [&_td]:px-3 [&_td]:py-3 [&_td]:text-right [&_td]:tabular-nums [&_th:first-child]:max-w-55 [&_th:first-child]:whitespace-normal [&_th:first-child]:text-left [&_th:first-child]:[overflow-wrap:anywhere] [&_thead]:bg-muted/40 [&_tr:last-child_td]:border-b-0">
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Input</th>
              <th scope="col">Cached</th>
              {cacheHit && <th scope="col">Cache hit</th>}
              <th scope="col">Output</th>
              <th scope="col">Calls</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, usage }, i) => (
              <tr key={i}>
                <th scope="row">{label}</th>
                <td>{token(usage, "inputTotal")}</td>
                <td>{token(usage, "inputCached")}</td>
                {cacheHit && <td>{cacheHitLabel(usage.cacheHitPercent)}</td>}
                <td>{token(usage, "outputTotal")}</td>
                <td>{number(usage.modelCalls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function searchReason(reason: string): string {
  return SEARCH_REASONS[reason] ?? reason.replace(/_/g, " ");
}
function searchDetailLabel(detail: SearchUsageDetail): string {
  const reason = detail.reason ? ` · ${searchReason(detail.reason)}` : "";
  return `${SEARCH_OUTCOMES[detail.outcome]}${reason}${detail.fallback ? " (as fallback)" : ""}`;
}
const IMAGE_FAILURES: Record<ImageFailureReason, string> = {
  rate_limited: "Rate limited by Codex",
  busy: "Another image was already being made",
  sign_in_required: "Codex Images needs sign-in",
  error: "Other error",
};
function ImageUsage({ images }: { images: ImageUsageResponse }) {
  return (
    <section
      className="image-usage min-w-0 [&>h4]:mb-3 [&>h4]:text-sm [&>h4]:font-medium"
      aria-label="Image generation usage"
    >
      <h4>Images</h4>
      {!images.requests ? (
        <p className="m-0 text-sm text-muted-foreground">No image requests in this period.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <dl className={USAGE_CARD_GRID}>
            <Card className="gap-0 py-0">
              <dt>Requests</dt>
              <dd>{number(images.requests)}</dd>
            </Card>
            <Card className="gap-0 py-0">
              <dt>Succeeded</dt>
              <dd>{number(images.succeeded)}</dd>
            </Card>
            <Card className="gap-0 py-0">
              <dt>Failed</dt>
              <dd>{number(images.failed)}</dd>
            </Card>
            <Card className="gap-0 py-0">
              <dt>Generated</dt>
              <dd>{number(images.generated)}</dd>
            </Card>
            <Card className="gap-0 py-0">
              <dt>
                Edited
                <InfoTip label="About edited images">Requests that sent reference images to edit.</InfoTip>
              </dt>
              <dd>{number(images.edited)}</dd>
            </Card>
            <Card className="gap-0 py-0">
              <dt>
                Average time
                <InfoTip label="About average image time">Mean time of successful requests.</InfoTip>
              </dt>
              <dd>{images.averageMs === null ? "—" : duration(images.averageMs)}</dd>
            </Card>
          </dl>
          {!!images.failures.length && (
            <ul aria-label="Image failures" className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
              {images.failures.map((failure) => (
                <li key={failure.reason} className="flex justify-between gap-3">
                  <span className="min-w-0 break-words text-muted-foreground">{IMAGE_FAILURES[failure.reason]}</span>
                  <span className="shrink-0 tabular-nums">{number(failure.calls)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 text-xs text-muted-foreground">
            Image requests count toward your Codex usage. Rei records counts only, not tokens.
          </p>
        </div>
      )}
    </section>
  );
}
function SearchUsage({ search }: { search: SearchUsageResponse }) {
  return (
    <section
      className="search-usage min-w-0 [&>h4]:mb-3 [&>h4]:text-sm [&>h4]:font-medium"
      aria-label="Web search usage"
    >
      <h4>Web search</h4>
      {!search.searches ? (
        <p className="m-0 text-sm text-muted-foreground">No web searches in this period.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <dl className={USAGE_CARD_GRID}>
            <Card className="gap-0 py-0">
              <dt>Searches</dt>
              <dd>{number(search.searches)}</dd>
            </Card>
            <Card className="gap-0 py-0">
              <dt>
                Answered
                <InfoTip label="About answered searches">A provider returned results or a cited answer.</InfoTip>
              </dt>
              <dd>{number(search.answered)}</dd>
            </Card>
            <Card className="gap-0 py-0">
              <dt>
                No results
                <InfoTip label="About searches with no results">
                  Providers answered but found nothing for the query.
                </InfoTip>
              </dt>
              <dd>{number(search.empty)}</dd>
            </Card>
            <Card className="gap-0 py-0">
              <dt>
                Failed
                <InfoTip label="About failed searches">
                  No provider answered: every provider failed, was rate limited or was not configured.
                </InfoTip>
              </dt>
              <dd>{number(search.failed)}</dd>
            </Card>
            <Card className="gap-0 py-0">
              <dt>
                Used fallback
                <InfoTip label="About fallback">
                  Searches where a provider failed or came back empty, so a later provider was asked.
                </InfoTip>
              </dt>
              <dd>{number(search.searchesWithFallback)}</dd>
            </Card>
          </dl>
          <div className="flex flex-col gap-2">
            {search.byProvider.map((provider) => (
              <SearchProviderRow key={provider.provider} provider={provider} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
function SearchProviderRow({ provider }: { provider: SearchUsageProvider }) {
  const searched = provider.succeeded + provider.empty + provider.failed;
  const details = provider.details.filter((detail) => detail.outcome !== "succeeded");
  const stats: [string, number][] = [
    ["Succeeded", provider.succeeded],
    ["Empty result", provider.empty],
    ["Failed", provider.failed],
    ["Skipped", provider.skipped],
    ["Asked as fallback", provider.fallback],
    ["Answered as fallback", provider.answeredAfterFallback],
  ];
  return (
    <details className="search-provider group min-w-0 rounded-2xl border open:bg-muted/30">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-2xl px-4 py-3 text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1 truncate font-medium">{provider.providerName}</span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {number(searched)} searched · {number(provider.succeeded)} succeeded · {number(provider.failed)} failed
        </span>
        <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {provider.averageMs === null ? "—" : duration(provider.averageMs)}
        </span>
        <span
          aria-hidden="true"
          className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-background/50 text-muted-foreground group-open:bg-accent group-open:text-foreground"
        >
          <Icon name="plus" size={12} className="group-open:hidden" />
          <Icon name="minus" size={12} className="hidden group-open:block" />
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t px-4 py-3 text-xs">
        <dl className="m-0 grid grid-cols-2 gap-3 sm:grid-cols-3 [&_dd]:m-0 [&_dd]:mt-1 [&_dd]:font-medium [&_dd]:tabular-nums [&_dt]:text-muted-foreground">
          {stats.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{number(value)}</dd>
            </div>
          ))}
        </dl>
        {!!details.length && (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {details.map((detail) => (
              <li
                key={`${detail.outcome}-${detail.reason ?? ""}-${detail.fallback}`}
                className="flex justify-between gap-3"
              >
                <span className="min-w-0 break-words text-muted-foreground">{searchDetailLabel(detail)}</span>
                <span className="shrink-0 tabular-nums">{number(detail.calls)}</span>
              </li>
            ))}
          </ul>
        )}
        {provider.averageMs !== null && (
          <p className="m-0 text-muted-foreground">Average time covers searches that reached this provider.</p>
        )}
      </div>
    </details>
  );
}
