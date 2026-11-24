import type { CallerUsageResponse, GatewayCallerScope, GatewayUsageCallerRow } from "@rei/protocol";
import { Badge } from "@/components/primitives/badge.tsx";
import { Card } from "@/components/primitives/card.tsx";
import { Empty, EmptyDescription } from "@/components/primitives/empty.tsx";
import { InfoTip } from "./InfoTip.tsx";
import {
  cacheHitLabel,
  duration,
  EmbeddingsUsageSection,
  formatTokenCount,
  number,
  ReadsUsageSection,
  USAGE_CARD_GRID,
  UsageTable,
} from "./usage-shared.tsx";

const SCOPE_LABELS: Record<GatewayCallerScope, string> = {
  models: "Models",
  search: "Web search",
  embeddings: "Embeddings",
  read: "Page reads",
  "read-local": "Local reads",
  admin: "Admin",
};

const REFUSAL_LABELS: Record<string, string> = {
  caller_concurrency: "Concurrency cap reached",
  provider_not_allowed: "Provider disabled by budget",
  route_not_allowed: "Route disabled by budget",
};

const ERROR_LABELS: Record<string, string> = {
  rate_limited: "Upstream rate limit",
  usage_limit_reached: "Usage limit reached",
  upstream_timeout: "Upstream timed out",
  upstream_idle_timeout: "Upstream stream went silent",
  upstream_unreachable: "Upstream could not be reached",
  capped_call_timeout: "Call exceeded maximum duration",
  client_aborted: "Caller disconnected",
  stream_error: "Upstream stream error",
  response_failed: "Upstream response failed",
  response_incomplete: "Upstream response incomplete",
  content_filter: "Stopped by content filter",
  network_error: "Upstream stream interrupted",
  search_timeout: "Search timed out",
  search_rate_limited: "Search rate limited",
  search_failed: "Search failed",
  fetch_failed: "Search provider unreachable",
  read_unavailable: "Page reader unavailable",
};

function refusalLabel(code: string): string {
  return REFUSAL_LABELS[code] ?? code.replace(/_/g, " ");
}

function errorLabel(code: string): string {
  if (ERROR_LABELS[code]) return ERROR_LABELS[code];
  const upstream = /^upstream_(\d{3})$/.exec(code);
  if (upstream) return `Upstream HTTP ${upstream[1]}`;
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return `HTTP ${http[1]}`;
  return code.replace(/_/g, " ");
}

function formatUtcDate(ms: number | null): string {
  if (ms === null) return "Never";
  return new Date(ms).toISOString().slice(0, 10);
}

export function CallerUsageSection({
  data,
  onSelectCaller,
}: {
  data: CallerUsageResponse;
  onSelectCaller: (tab: string) => void;
}) {
  const isAll = data.caller === null;
  const scopes = new Set(data.caller?.scopes ?? []);
  const totalRefusals = data.refusals.reduce((n, r) => n + r.count, 0);
  const totalErrors = data.models.summary.errors + data.search.errors + data.embeddings.errors + data.reads.errors;
  const upstreamLimited = data.models.summary.upstreamLimited;
  const hasAnyActivity =
    data.models.summary.calls > 0 ||
    data.search.calls > 0 ||
    data.embeddings.calls > 0 ||
    data.reads.calls > 0 ||
    totalRefusals > 0;

  const showModels = isAll || scopes.has("models") || data.models.summary.calls > 0;
  const showSearch = isAll ? data.search.calls > 0 : scopes.has("search") || data.search.calls > 0;
  const showEmbeddings = isAll ? data.embeddings.calls > 0 : scopes.has("embeddings") || data.embeddings.calls > 0;
  const showReads = isAll ? data.reads.calls > 0 : scopes.has("read") || data.reads.calls > 0;

  const modelCards: [string, string, string][] = [
    [
      "Total input",
      formatTokenCount(data.models.summary.inputTotal),
      "All input tokens reported to the gateway, including cached input.",
    ],
    [
      "Cached input",
      formatTokenCount(data.models.summary.inputCached),
      "Input tokens served from the provider's prompt cache.",
    ],
    [
      "Uncached input",
      formatTokenCount(data.models.summary.inputUncached),
      "Input tokens that were not served from the provider's prompt cache.",
    ],
    ["Output", formatTokenCount(data.models.summary.outputTotal), "All output tokens reported to the gateway."],
    [
      "Total processed",
      formatTokenCount(data.models.summary.totalProcessed),
      "Total input and output tokens processed by the model.",
    ],
  ];

  return (
    <>
      <p className="m-0 text-sm text-muted-foreground">Since {data.trackingSince.slice(0, 10)} (UTC)</p>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>
          {data.from} to {data.to} · UTC
        </span>
        {isAll && (
          <InfoTip label="About combined gateway usage">
            Measured at the gateway across Rei and all outside callers. Totals may differ slightly from the Rei tab if
            Rei had calls before gateway rollups began or outside the gateway.
          </InfoTip>
        )}
      </div>

      {data.caller && (
        <div className="caller-meta flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          {data.caller.note && <span className="text-foreground">{data.caller.note}</span>}
          {data.caller.revokedAt !== null && <Badge variant="secondary">Revoked</Badge>}
          <span>Scopes: {data.caller.scopes.map((s) => SCOPE_LABELS[s] ?? s).join(" · ")}</span>
          <span>Last used: {formatUtcDate(data.caller.lastUsedAt)}</span>
        </div>
      )}

      {!hasAnyActivity && (
        <Empty className="usage-empty border py-8">
          <EmptyDescription>
            {data.period === "all" || data.from === data.trackingSince.slice(0, 10)
              ? "No usage recorded since tracking began"
              : "No usage recorded in this period"}
          </EmptyDescription>
        </Empty>
      )}

      {showModels && (
        <>
          <dl className={USAGE_CARD_GRID}>
            {modelCards.map(([label, value, tip]) => (
              <Card key={label} className="gap-0 py-0">
                <dt>
                  {label}
                  <InfoTip label={`About ${label.toLowerCase()}`}>{tip}</InfoTip>
                </dt>
                <dd>{value}</dd>
              </Card>
            ))}
            <Card className="gap-0 py-0">
              <dt>
                Cache hit
                <InfoTip label="About cache hit">
                  The share of input tokens served from the provider's prompt cache over calls that reported tokens.
                </InfoTip>
              </dt>
              <dd>{cacheHitLabel(data.models.summary.cacheHitPercent)}</dd>
            </Card>
            <Card className="gap-0 py-0">
              <dt>Model calls</dt>
              <dd>{number(data.models.summary.calls)}</dd>
            </Card>
          </dl>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{number(data.models.summary.callsUnreported)} calls without token reports</span>
            <InfoTip label="About calls without token reports">
              Unavailable means no calls in this bucket reported tokens. Failed or interrupted streams without a final
              usage event are counted here. Daily gateway counters persist after raw call logs expire.
            </InfoTip>
          </div>
        </>
      )}

      {isAll && !!data.byCaller.length && <ByCallerTable rows={data.byCaller} onSelectCaller={onSelectCaller} />}

      {!!data.models.byModel.length && (
        <UsageTable
          title="By model"
          cacheHit
          rows={data.models.byModel.map((r) => ({
            label: `${r.providerName} / ${r.model}`,
            inputTotal: r.inputTotal,
            inputCached: r.inputCached,
            outputTotal: r.outputTotal,
            cacheHitPercent: r.cacheHitPercent,
            calls: r.calls,
          }))}
        />
      )}

      {showSearch && (
        <section
          className="gateway-search-usage min-w-0 [&>h4]:mb-3 [&>h4]:text-sm [&>h4]:font-medium"
          aria-label="Web search usage"
        >
          <h4>Web search</h4>
          {!data.search.calls ? (
            <p className="m-0 text-sm text-muted-foreground">No web searches in this period.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <dl className={USAGE_CARD_GRID}>
                <Card className="gap-0 py-0">
                  <dt>Attempts</dt>
                  <dd>{number(data.search.calls)}</dd>
                </Card>
                <Card className="gap-0 py-0">
                  <dt>Succeeded</dt>
                  <dd>{number(data.search.ok)}</dd>
                </Card>
                <Card className="gap-0 py-0">
                  <dt>Failed</dt>
                  <dd>{number(data.search.errors)}</dd>
                </Card>
                <Card className="gap-0 py-0">
                  <dt>Average time</dt>
                  <dd>{data.search.averageMs === null ? "—" : duration(data.search.averageMs)}</dd>
                </Card>
              </dl>
              {!!data.search.byProvider.length && (
                <ul aria-label="Search providers" className="m-0 flex list-none flex-col gap-2 p-0">
                  {data.search.byProvider.map((p) => (
                    <li
                      key={p.provider}
                      className="flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">{p.providerName}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {number(p.calls)} attempts · {number(p.ok)} succeeded · {number(p.errors)} failed
                      </span>
                      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {p.averageMs === null ? "—" : duration(p.averageMs)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {showEmbeddings && <EmbeddingsUsageSection embeddings={data.embeddings} />}

      {showReads && <ReadsUsageSection reads={data.reads} />}

      <section
        className="gateway-limits-usage min-w-0 [&>h4]:mb-3 [&>h4]:text-sm [&>h4]:font-medium"
        aria-label="Limits and errors"
      >
        <h4>Limits and errors</h4>
        {!totalErrors && !upstreamLimited && !totalRefusals ? (
          <p className="m-0 text-sm text-muted-foreground">No errors or limit refusals in this period.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <dl className={USAGE_CARD_GRID}>
              <Card className="gap-0 py-0">
                <dt>
                  Errors
                  <InfoTip label="About errors">
                    Failed gateway calls across models, web search, embeddings, and page reads (HTTP 4xx/5xx, stream
                    errors, and timeouts). Upstream 429s also count under upstream rate limits; gateway budget refusals
                    are separate.
                  </InfoTip>
                </dt>
                <dd>{number(totalErrors)}</dd>
              </Card>
              <Card className="gap-0 py-0">
                <dt>
                  Upstream rate limits
                  <InfoTip label="About upstream rate limits">
                    Calls where the upstream provider returned HTTP 429 or a rate/usage limit error.
                  </InfoTip>
                </dt>
                <dd>{number(upstreamLimited)}</dd>
              </Card>
              <Card className="gap-0 py-0">
                <dt>
                  Budget refusals
                  <InfoTip label="About budget refusals">
                    Calls refused by the gateway because the caller reached its concurrency cap or a disabled route.
                  </InfoTip>
                </dt>
                <dd>{number(totalRefusals)}</dd>
              </Card>
            </dl>
            {!!data.errorBreakdown.length && (
              <ul aria-label="Error breakdown" className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
                {data.errorBreakdown.map((e) => (
                  <li key={e.code} className="flex justify-between gap-3">
                    <span className="min-w-0 break-words text-muted-foreground">{errorLabel(e.code)}</span>
                    <span className="shrink-0 tabular-nums">{number(e.count)}</span>
                  </li>
                ))}
              </ul>
            )}
            {!!data.refusals.length && (
              <ul aria-label="Budget refusal breakdown" className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
                {data.refusals.map((r) => (
                  <li key={r.code} className="flex justify-between gap-3">
                    <span className="min-w-0 break-words text-muted-foreground">{refusalLabel(r.code)}</span>
                    <span className="shrink-0 tabular-nums">{number(r.count)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </>
  );
}

function ByCallerTable({
  rows,
  onSelectCaller,
}: {
  rows: GatewayUsageCallerRow[];
  onSelectCaller: (tab: string) => void;
}) {
  return (
    <section className="usage-breakdown min-w-0 [&>h4]:mb-3 [&>h4]:text-sm [&>h4]:font-medium">
      <h4>By caller</h4>
      <section
        className="usage-table-wrap max-w-full overflow-x-auto rounded-2xl border outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable table region must be keyboard-reachable.
        tabIndex={0}
        aria-label="By caller usage table"
      >
        <table className="usage-table min-w-[36rem] w-full border-collapse text-xs [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:px-3 [&_th]:py-3 [&_th]:text-right [&_th]:font-medium [&_td]:whitespace-nowrap [&_td]:border-b [&_td]:px-3 [&_td]:py-3 [&_td]:text-right [&_td]:tabular-nums [&_th:first-child]:min-w-32 [&_th:first-child]:max-w-55 [&_th:first-child]:whitespace-normal [&_th:first-child]:text-left [&_th:first-child]:[overflow-wrap:anywhere] [&_thead]:bg-muted/40 [&_tr:last-child_td]:border-b-0 [&_tr:last-child_th]:border-b-0">
          <thead>
            <tr>
              <th scope="col">Caller</th>
              <th scope="col">Input</th>
              <th scope="col">Cached</th>
              <th scope="col">Output</th>
              <th scope="col">Model calls</th>
              <th scope="col">Other calls</th>
              <th scope="col">Errors</th>
              <th scope="col">Limits</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const label = r.caller === "rei" ? "Rei" : r.caller;
              const otherCalls = r.searchCalls + r.embeddingCalls + r.readCalls;
              const limits = r.upstreamLimited + r.refusals;
              return (
                <tr key={r.caller}>
                  <th scope="row">
                    <button
                      type="button"
                      onClick={() => onSelectCaller(r.caller)}
                      className="cursor-pointer rounded-sm text-left font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {label}
                    </button>
                  </th>
                  <td>{formatTokenCount(r.inputTotal)}</td>
                  <td>{formatTokenCount(r.inputCached)}</td>
                  <td>{formatTokenCount(r.outputTotal)}</td>
                  <td>{number(r.modelCalls)}</td>
                  <td>{number(otherCalls)}</td>
                  <td>{number(r.errors)}</td>
                  <td>{number(limits)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </section>
  );
}
