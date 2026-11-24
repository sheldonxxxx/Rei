import {
  type CallerUsageResponse,
  type ImageFailureReason,
  type ImageUsageResponse,
  type SearchAttemptOutcome,
  type SearchUsageDetail,
  type SearchUsageProvider,
  type SearchUsageResponse,
  USAGE_PERIODS,
  type UsageCallerSummary,
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
import { NativeSelect, NativeSelectOption } from "@/components/primitives/native-select.tsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/primitives/tabs.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/primitives/toggle-group.tsx";
import type { Api } from "../api/client.ts";
import { navigate, settingsHref } from "../lib/route.ts";
import { CallerUsageSection } from "./CallerUsageSection.tsx";
import { Icon } from "./Icon.tsx";
import { InfoTip } from "./InfoTip.tsx";
import { PageShell } from "./PageShell.tsx";
import {
  cacheHitLabel,
  duration,
  EmbeddingsUsageSection,
  formatTokenCount,
  number,
  ReadsUsageSection,
  USAGE_CARD_GRID,
  UsageTable,
  type UsageTableRow,
} from "./usage-shared.tsx";

const MAX_INLINE_CALLER_TABS = 5;

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
const token = (u: UsageTotals, metric: UsageMetric): string => formatTokenCount(u.tokens[metric]);
const toTableRow = (label: string, usage: UsageTotals): UsageTableRow => ({
  label,
  inputTotal: usage.tokens.inputTotal,
  inputCached: usage.tokens.inputCached,
  outputTotal: usage.tokens.outputTotal,
  cacheHitPercent: usage.cacheHitPercent,
  calls: usage.modelCalls,
});
/** A UTC day, YYYY-MM-DD, `offset` days from today. Periods and date inputs use UTC, as the server does. */
const utcDay = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

export function UsagePage({ api, tab = null }: { api: Api; tab?: string | null }) {
  const [selectedTab, setSelectedTab] = useState<string>(() => tab || "rei");
  const [callers, setCallers] = useState<UsageCallerSummary[]>([]);
  const [period, setPeriod] = useState<UsagePeriod>("30d");
  const [range, setRange] = useState(() => ({ from: utcDay(-29), to: utcDay() }));
  const [retry, setRetry] = useState(0);
  const [reiData, setReiData] = useState<UsageResponse | null>(null);
  const [gatewayData, setGatewayData] = useState<CallerUsageResponse | null>(null);
  const [error, setError] = useState(false);
  const fromId = useId();
  const toId = useId();

  useEffect(() => {
    setSelectedTab(tab || "rei");
  }, [tab]);

  useEffect(() => {
    if (typeof api.getUsageCallers !== "function") return;
    let current = true;
    api.getUsageCallers().then(
      (res) => {
        if (current && Array.isArray(res?.callers)) setCallers(res.callers);
      },
      () => {
        if (current) setCallers([]);
      },
    );
    return () => {
      current = false;
    };
  }, [api]);

  const selectTab = (next: string) => {
    const normalized = next || "rei";
    setSelectedTab(normalized);
    navigate(settingsHref("usage", normalized === "rei" ? null : normalized));
  };

  const activeCallers = callers.filter((c) => c.revokedAt === null);
  const hasRevokedHistory = callers.some((c) => c.revokedAt !== null && c.lastUsedAt !== null);
  const selectedRevoked = callers.find((c) => c.revokedAt !== null && c.id === selectedTab);
  const visibleCallers = selectedRevoked ? [...activeCallers, selectedRevoked] : activeCallers;
  const showTabs = activeCallers.length > 0 || hasRevokedHistory || selectedTab !== "rei";
  const compactCallers = activeCallers.length > MAX_INLINE_CALLER_TABS;
  const isRei = selectedTab === "rei";
  const isAll = selectedTab === "all";
  const isOutsideCaller = !isRei && !isAll;

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
    setError(false);
    if (isRei) {
      setReiData(null);
      (period === "custom" ? api.getUsage(period, range) : api.getUsage(period)).then(
        (r) => {
          if (current) setReiData(r);
        },
        () => {
          if (current) setError(true);
        },
      );
    } else {
      setGatewayData(null);
      const callerParam = isAll ? null : selectedTab;
      (period === "custom"
        ? api.getGatewayUsage(callerParam, period, range)
        : api.getGatewayUsage(callerParam, period)
      ).then(
        (r) => {
          if (current) setGatewayData(r);
        },
        () => {
          if (current) setError(true);
        },
      );
    }
    return () => {
      current = false;
    };
  }, [api, isRei, isAll, selectedTab, period, range, rangeProblem, retry]);

  const loading = isRei ? !reiData : !gatewayData;

  return (
    <PageShell title="Usage" className="usage-page min-w-0">
      {showTabs && (
        <div className="usage-callers flex flex-wrap items-center gap-2">
          <Tabs
            value={compactCallers && isOutsideCaller ? "" : selectedTab}
            onValueChange={(value) => value && selectTab(value)}
            className="min-w-0"
          >
            <TabsList aria-label="Usage caller" className="h-auto max-w-full flex-wrap">
              <TabsTrigger value="rei">Rei</TabsTrigger>
              {!compactCallers &&
                visibleCallers.map((c) => (
                  <TabsTrigger key={c.id} value={c.id} title={c.note || undefined}>
                    {c.id}
                  </TabsTrigger>
                ))}
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>
          </Tabs>
          {compactCallers && (
            <NativeSelect
              size="sm"
              aria-label="Outside caller"
              value={isOutsideCaller ? selectedTab : ""}
              onChange={(e) => {
                if (e.target.value) selectTab(e.target.value);
              }}
            >
              <NativeSelectOption value="">Choose caller…</NativeSelectOption>
              {visibleCallers.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {c.revokedAt !== null ? `${c.id} (revoked)` : c.id}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </div>
      )}

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
      ) : loading ? (
        <span className="spinner" role="status" aria-label="Loading usage" />
      ) : isRei && reiData ? (
        <>
          <p className="m-0 text-sm text-muted-foreground">Since {reiData.trackingSince.slice(0, 10)} (UTC)</p>
          <p className="m-0 text-xs text-muted-foreground">
            {reiData.from} to {reiData.to} · UTC
          </p>
          {!reiData.summary.modelCalls && (
            <Empty className="usage-empty border py-8">
              <EmptyDescription>
                {reiData.period === "all" || reiData.from === reiData.trackingSince.slice(0, 10)
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
                <dd>{token(reiData.summary, m)}</dd>
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
              <dd>{cacheHitLabel(reiData.summary.cacheHitPercent)}</dd>
            </Card>
            <Card className="gap-0 py-0">
              <dt>Model calls</dt>
              <dd>{number(reiData.summary.modelCalls)}</dd>
            </Card>
          </dl>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{number(reiData.summary.callsUnreported)} calls with missing or unreliable reports</span>
            <InfoTip label="About unreliable reports">
              Unavailable means no reliable report. Totals count only calls with reliable reports. Cache hit leaves out
              calls that lack an input or cached count. Interrupted calls without a completion report are excluded.
              Aggregate counters persist regardless of detailed log expiration.
            </InfoTip>
          </div>
          <UsageTable title="By purpose" rows={reiData.byPurpose.map((r) => toTableRow(LABELS[r.purpose], r.usage))} />
          {!!reiData.byModel.length && (
            <UsageTable
              title="By model"
              cacheHit
              rows={reiData.byModel.map((r) => toTableRow(`${r.providerName} / ${r.model}`, r.usage))}
            />
          )}
          <SearchUsage search={reiData.search} />
          <ImageUsage images={reiData.images} />
          {reiData.embeddings && <EmbeddingsUsageSection embeddings={reiData.embeddings} />}
          {reiData.reads && <ReadsUsageSection reads={reiData.reads} />}
        </>
      ) : gatewayData ? (
        <CallerUsageSection data={gatewayData} onSelectCaller={selectTab} />
      ) : null}
    </PageShell>
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
