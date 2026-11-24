import type { GatewayEmbeddingsUsage, GatewayReadsUsage } from "@rei/protocol";
import { Card } from "@/components/primitives/card.tsx";

export const USAGE_CARD_GRID =
  "usage-cards m-0 grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(140px,1fr))] [&>div]:rounded-2xl [&>div]:border [&>div]:p-4 [&_dt]:flex [&_dt]:items-center [&_dt]:gap-1 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:mt-2 [&_dd]:text-xl [&_dd]:font-semibold [&_dd]:tabular-nums [&_dd]:[overflow-wrap:anywhere]";

const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
export const number = (n: number) => compactNumber.format(n);

export function duration(ms: number): string {
  return ms > 1000 ? `${Math.ceil(ms / 1000).toLocaleString("en-US")} s` : `${ms.toLocaleString("en-US")} ms`;
}

export function formatTokenCount(n: number | null): string {
  return n === null ? "Unavailable" : number(n);
}

export function cacheHitLabel(percent: number | null): string {
  return percent === null ? "Unavailable" : `${percent.toFixed(1)}%`;
}

export interface UsageTableRow {
  label: string;
  inputTotal: number | null;
  inputCached: number | null;
  outputTotal: number | null;
  cacheHitPercent: number | null;
  calls: number;
}

export function UsageTable({
  title,
  rows,
  cacheHit = false,
}: {
  title: string;
  rows: UsageTableRow[];
  cacheHit?: boolean;
}) {
  return (
    <section className="usage-breakdown min-w-0 [&>h4]:mb-3 [&>h4]:text-sm [&>h4]:font-medium">
      <h4>{title}</h4>
      <section
        className="usage-table-wrap max-w-full overflow-x-auto rounded-2xl border outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable table region must be keyboard-reachable.
        tabIndex={0}
        aria-label={`${title} usage table`}
      >
        <table className="usage-table min-w-[28rem] [&_th:first-child]:min-w-40 w-full border-collapse text-xs [&_th]:whitespace-nowrap [&_th]:border-b [&_th]:px-3 [&_th]:py-3 [&_th]:text-right [&_th]:font-medium [&_td]:whitespace-nowrap [&_td]:border-b [&_td]:px-3 [&_td]:py-3 [&_td]:text-right [&_td]:tabular-nums [&_th:first-child]:max-w-55 [&_th:first-child]:whitespace-normal [&_th:first-child]:text-left [&_th:first-child]:[overflow-wrap:anywhere] [&_thead]:bg-muted/40 [&_tr:last-child_td]:border-b-0 [&_tr:last-child_th]:border-b-0">
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
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{formatTokenCount(row.inputTotal)}</td>
                <td>{formatTokenCount(row.inputCached)}</td>
                {cacheHit && <td>{cacheHitLabel(row.cacheHitPercent)}</td>}
                <td>{formatTokenCount(row.outputTotal)}</td>
                <td>{number(row.calls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  );
}

export function EmbeddingsUsageSection({ embeddings }: { embeddings: GatewayEmbeddingsUsage }) {
  return (
    <section
      className="gateway-embeddings-usage min-w-0 [&>h4]:mb-3 [&>h4]:text-sm [&>h4]:font-medium"
      aria-label="Embeddings usage"
    >
      <h4>Embeddings</h4>
      {!embeddings.calls ? (
        <p className="m-0 text-sm text-muted-foreground">No embedding calls in this period.</p>
      ) : (
        <dl className={USAGE_CARD_GRID}>
          <Card className="gap-0 py-0">
            <dt>Calls</dt>
            <dd>{number(embeddings.calls)}</dd>
          </Card>
          <Card className="gap-0 py-0">
            <dt>Input tokens</dt>
            <dd>{formatTokenCount(embeddings.inputTokens)}</dd>
          </Card>
          <Card className="gap-0 py-0">
            <dt>Failed</dt>
            <dd>{number(embeddings.errors)}</dd>
          </Card>
          <Card className="gap-0 py-0">
            <dt>Average time</dt>
            <dd>{embeddings.averageMs === null ? "—" : duration(embeddings.averageMs)}</dd>
          </Card>
        </dl>
      )}
    </section>
  );
}

export function ReadsUsageSection({ reads }: { reads: GatewayReadsUsage }) {
  return (
    <section
      className="gateway-reads-usage min-w-0 [&>h4]:mb-3 [&>h4]:text-sm [&>h4]:font-medium"
      aria-label="Page reads usage"
    >
      <h4>Page reads</h4>
      {!reads.calls ? (
        <p className="m-0 text-sm text-muted-foreground">No page reads in this period.</p>
      ) : (
        <dl className={USAGE_CARD_GRID}>
          <Card className="gap-0 py-0">
            <dt>Reads</dt>
            <dd>{number(reads.calls)}</dd>
          </Card>
          <Card className="gap-0 py-0">
            <dt>Succeeded</dt>
            <dd>{number(reads.ok)}</dd>
          </Card>
          <Card className="gap-0 py-0">
            <dt>Failed</dt>
            <dd>{number(reads.errors)}</dd>
          </Card>
          <Card className="gap-0 py-0">
            <dt>Average time</dt>
            <dd>{reads.averageMs === null ? "—" : duration(reads.averageMs)}</dd>
          </Card>
        </dl>
      )}
    </section>
  );
}
