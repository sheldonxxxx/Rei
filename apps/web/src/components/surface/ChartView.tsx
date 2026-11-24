import type { KeyboardEvent } from "react";
import { useId, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { chartColor, formatValue, niceTicks, pieSlices, valueRange, wedgePath } from "../../lib/chart.ts";
import { UiFrame } from "./shared.tsx";
import type { ChartProps } from "./types.ts";

const W = 480;
const H = 240;
const M = { left: 46, right: 12, top: 14, bottom: 34 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Our own SVG charts: grouped bars, lines with gaps, and a pie. Values show on hover, focus and arrow keys; "Show data" gives a table. */
/** Each series keeps its colour when others are hidden. */
type Shown = Omit<ChartProps, "series"> & { series: (ChartProps["series"][number] & { ci: number })[] };

export function ChartView({ props: all }: { props: ChartProps }) {
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
  const props: Shown = {
    ...all,
    series: all.series.map((s, ci) => ({ ...s, ci })).filter((s) => all.variant === "pie" || !hidden.has(s.ci)),
  };
  const toggle = (i: number) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(i)) next.delete(i);
      else if (all.series.length - next.size > 1) next.add(i);
      return next;
    });
  const [active, setActive] = useState<number | null>(null);
  const [data, setData] = useState(false);
  const tableId = useId();
  const slices = props.variant === "pie" ? pieSlices(props.labels, props.series[0]?.values ?? []) : [];
  const count = props.variant === "pie" ? slices.length : props.labels.length;

  const key = (e: KeyboardEvent) => {
    if (count === 0) return;
    const move =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (move) {
      e.preventDefault();
      setActive((a) => (a === null ? (move > 0 ? 0 : count - 1) : (a + move + count) % count));
    } else if (e.key === "Escape") setActive(null);
  };

  const readout = (() => {
    if (active === null) return null;
    if (props.variant === "pie") {
      const s = slices[active];
      return s ? `${s.label}: ${formatValue(s.value, props.unit)} (${Math.round(s.share * 100)}%)` : null;
    }
    const label = props.labels[active];
    if (label === undefined) return null;
    const parts = props.series.map((s) =>
      props.series.length > 1
        ? `${s.name}: ${formatValue(s.values[active] ?? null, props.unit)}`
        : formatValue(s.values[active] ?? null, props.unit),
    );
    return `${label}: ${parts.join(" · ")}`;
  })();

  const summary = `${props.variant} chart${props.title ? `: ${props.title}` : ""}, ${props.labels.length} ${props.variant === "pie" ? "slices" : "points"}${props.series.length > 1 ? `, ${props.series.length} series` : ""}`;

  return (
    <UiFrame kind="chart" title={props.title}>
      <div
        className="ui-chart"
        tabIndex={0}
        role="group"
        aria-roledescription="chart"
        aria-label={`${summary}. Use the arrow keys to read values.`}
        onKeyDown={key}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
      >
        {props.variant === "pie" ? (
          <Pie slices={slices} active={active} onActive={setActive} />
        ) : (
          <Axes props={props} active={active} onActive={setActive} />
        )}
      </div>
      <p className="ui-readout" aria-live="polite">
        {readout ?? <span className="ui-readout-hint">Select a point to read values</span>}
      </p>
      {(all.series.length > 1 || props.variant === "pie") && (
        <ul className="ui-legend" aria-label="Legend">
          {props.variant === "pie"
            ? slices.map((s, i) => (
                <li key={i} data-active={active === i ? "true" : undefined} onMouseEnter={() => setActive(i)}>
                  <span
                    className="ui-swatch"
                    style={{ background: s.other ? "var(--muted-foreground)" : chartColor(i) }}
                    aria-hidden="true"
                  />
                  {s.label}
                  <span className="ui-legend-v">{Math.round(s.share * 100)}%</span>
                </li>
              ))
            : all.series.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: series are positional; names may repeat.
                <li key={i}>
                  <button
                    type="button"
                    className="ui-legend-toggle"
                    aria-pressed={!hidden.has(i)}
                    aria-label={`${hidden.has(i) ? "Show" : "Hide"} ${s.name}`}
                    onClick={() => toggle(i)}
                  >
                    <span className="ui-swatch" style={{ background: chartColor(i) }} aria-hidden="true" />
                    {s.name}
                  </button>
                </li>
              ))}
        </ul>
      )}
      <Button
        variant="ghost"
        size="sm"
        type="button"
        className="more-btn"
        aria-expanded={data}
        aria-controls={tableId}
        onClick={() => setData((d) => !d)}
      >
        {data ? "Hide data" : "Show data"}
      </Button>
      <div
        id={tableId}
        hidden={!data}
        className="ui-table-wrap"
        tabIndex={data ? 0 : -1}
        role="region"
        aria-label="Chart data"
      >
        {data && (
          <table>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: "left" }}>
                  {props.variant === "pie" ? "Slice" : "Label"}
                </th>
                {props.series.map((s, i) => (
                  <th key={i} scope="col" style={{ textAlign: "right" }}>
                    {s.name}
                    {props.unit ? ` (${props.unit})` : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.labels.map((l, r) => (
                <tr key={r}>
                  <th scope="row" style={{ textAlign: "left" }}>
                    {l}
                  </th>
                  {props.series.map((s, i) => (
                    <td key={i} style={{ textAlign: "right" }}>
                      {s.values[r] === null || s.values[r] === undefined ? "–" : formatValue(s.values[r]!)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </UiFrame>
  );
}

function Axes({
  props,
  active,
  onActive,
}: {
  props: Shown;
  active: number | null;
  onActive: (i: number | null) => void;
}) {
  const isBar = props.variant === "bar";
  const range = valueRange(
    props.series.map((s) => s.values),
    isBar,
  );
  const { ticks, min, max } = niceTicks(range.min, range.max);
  const n = Math.max(1, props.labels.length);
  const band = PLOT_W / n;
  const y = (v: number) => M.top + PLOT_H - ((v - min) / (max - min || 1)) * PLOT_H;
  const x = (i: number) => M.left + band * (i + 0.5);
  const every = Math.max(1, Math.ceil((n * 46) / PLOT_W)); // label every k-th tick so they don't overlap
  const barW = Math.min(28, (band * 0.8) / Math.max(1, props.series.length));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="ui-svg" aria-hidden="true" focusable="false">
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={M.left}
            x2={W - M.right}
            y1={y(t)}
            y2={y(t)}
            className={t === 0 && min < 0 ? "ui-axis" : "ui-grid"}
          />
          <text x={M.left - 6} y={y(t)} className="ui-tick" textAnchor="end" dominantBaseline="middle">
            {formatValue(t)}
          </text>
        </g>
      ))}
      {props.labels.map((l, i) =>
        i % every === 0 ? (
          <text key={i} x={x(i)} y={H - M.bottom + 16} className="ui-tick" textAnchor="middle">
            {short(l, 10)}
          </text>
        ) : null,
      )}
      {props.labels.map((_, i) => (
        <rect
          key={i}
          x={M.left + band * i}
          y={M.top}
          width={band}
          height={PLOT_H}
          className="ui-hit"
          data-active={active === i ? "true" : undefined}
          onMouseEnter={() => onActive(i)}
          onClick={() => onActive(i)}
        />
      ))}
      {isBar
        ? props.series.map((s, si) =>
            s.values.map((v, i) => {
              if (v === null || v === undefined) return null;
              const x0 = x(i) - (barW * props.series.length) / 2 + si * barW;
              const top = y(Math.max(v, 0));
              const h = Math.max(1, Math.abs(y(v) - y(0)));
              return (
                <rect
                  key={`${si}-${i}`}
                  x={x0 + 1}
                  y={v >= 0 ? top : y(0)}
                  width={Math.max(1, barW - 2)}
                  height={h}
                  rx={2}
                  style={{ fill: chartColor(s.ci) }}
                  className="ui-bar"
                  pointerEvents="none"
                />
              );
            }),
          )
        : props.series.map((s, si) => {
            const runs: { i: number; v: number }[][] = [];
            s.values.forEach((v, i) => {
              if (v === null || v === undefined) runs.push([]);
              else {
                if (runs.length === 0) runs.push([]);
                runs[runs.length - 1]!.push({ i, v });
              }
            });
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: series are positional; names may repeat.
              <g key={si} style={{ color: chartColor(s.ci) }} pointerEvents="none">
                {runs
                  .filter((r) => r.length > 1)
                  .map((r, k) => (
                    <polyline
                      key={k}
                      points={r.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}
                      className="ui-line"
                    />
                  ))}
                {runs.flat().map((p) => (
                  <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={active === p.i ? 5 : 3.5} className="ui-dot" />
                ))}
              </g>
            );
          })}
      {active !== null && active < props.labels.length && (
        <g pointerEvents="none">
          {props.series.map((s, si) => {
            const v = s.values[active];
            if (v === null || v === undefined) return null;
            const isB = isBar;
            const xx = isB ? x(active) - (barW * props.series.length) / 2 + si * barW + barW / 2 : x(active);
            return (
              <text key={si} x={xx} y={y(Math.max(v, 0)) - 6} className="ui-value" textAnchor="middle">
                {formatValue(v)}
              </text>
            );
          })}
        </g>
      )}
    </svg>
  );
}

function Pie({
  slices,
  active,
  onActive,
}: {
  slices: ReturnType<typeof pieSlices>;
  active: number | null;
  onActive: (i: number | null) => void;
}) {
  if (slices.length === 0) return <p className="ui-sub">Nothing to show: no positive values.</p>;
  const r = 84;
  return (
    <svg viewBox="0 0 240 200" className="ui-svg ui-pie" aria-hidden="true" focusable="false">
      {slices.map((s, i) => (
        <path
          key={i}
          d={wedgePath(120, 100, active === i ? r + 5 : r, s.start, s.end)}
          className="ui-slice"
          style={{ fill: s.other ? "var(--muted-foreground)" : chartColor(i) }}
          onMouseEnter={() => onActive(i)}
          onClick={() => onActive(i)}
        />
      ))}
    </svg>
  );
}
