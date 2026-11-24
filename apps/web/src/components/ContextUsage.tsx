import type { ContextTokenCategory, ContextUsageResponse } from "@rei/protocol";
import { useEffect, useState } from "react";
import type { Api } from "../api/client.ts";
import { Icon } from "./Icon.tsx";
import { Button } from "./primitives/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./primitives/popover.tsx";
import { Tip } from "./Tip.tsx";

const CATEGORY_COLOR: Record<ContextTokenCategory, string> = {
  prompt: "bg-indigo-400",
  capabilities: "bg-purple-400",
  skills: "bg-violet-400",
  tools: "bg-blue-400",
  loaded_tools: "bg-cyan-400",
  conversation: "bg-teal-400",
  tool_calls: "bg-amber-400",
  tool_results: "bg-orange-400",
  mcp_calls: "bg-rose-400",
  mcp_results: "bg-pink-400",
  other: "bg-slate-400",
};

const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const number = (n: number | null) => (n === null ? "Unavailable" : compactNumber.format(n));

export function ContextUsage({
  api,
  sessionId,
  revision,
  running,
}: {
  api?: Api | undefined;
  sessionId?: string | undefined;
  revision?: string | undefined;
  running: boolean;
}) {
  const [usage, setUsage] = useState<ContextUsageResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setUsage(null);
    setFailed(false);
    if (!api?.getContextUsage || !sessionId) return;
    const refresh = () =>
      api.getContextUsage(sessionId).then(
        (value) => {
          if (!cancelled) {
            setUsage(value);
            setFailed(false);
          }
        },
        () => {
          if (!cancelled) {
            setUsage(null);
            setFailed(true);
          }
        },
      );
    void refresh();
    const timer = running
      ? setInterval(() => {
          void refresh();
        }, 3000)
      : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, sessionId, revision, running]);
  const categories = usage?.breakdown?.categories ?? [];
  const estimatedTotal = categories.reduce((total, category) => total + category.estimatedTokens, 0);
  const distribution = categories.filter((category) => category.estimatedTokens > 0);
  const noModelCall = usage !== null && usage.updatedAt === null;
  const input = noModelCall ? 0 : (usage?.inputTokens ?? null);
  const output = noModelCall ? 0 : (usage?.outputTokens ?? null);
  const max = usage?.maxTokens && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used = input !== null && output !== null ? input + output : null;
  const percent = noModelCall ? 0 : used !== null && max !== null ? Math.round((used / max) * 100) : null;
  const summary = noModelCall
    ? "0"
    : `${number(used)} / ${number(max)}${percent !== null ? ` · ${percent}% used` : ""}`;
  const rows: [string, number | null][] = [
    ["Input", input],
    ["Cached input (included above)", noModelCall ? 0 : (usage?.cachedTokens ?? null)],
    ["Latest output", output],
    ["Remaining", used !== null && max !== null ? Math.max(0, max - used) : null],
    ["Max context", max],
  ];
  return (
    <Popover>
      <Tip label={`Context usage: ${summary}`}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="cursor-pointer text-muted-foreground"
            aria-label={`Context usage: ${summary}`}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className={
                "size-[22px] " +
                (percent !== null && percent >= 90
                  ? "text-destructive"
                  : percent !== null && percent >= 75
                    ? "text-amber-500"
                    : "")
              }
            >
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.18" />
              <circle
                cx="12"
                cy="12"
                r="9"
                stroke="currentColor"
                strokeWidth="2.5"
                pathLength="100"
                strokeDasharray={`${Math.min(100, percent ?? 0)} 100`}
                transform="rotate(-90 12 12)"
                strokeLinecap="round"
              />
            </svg>
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        side="top"
        align="end"
        className="no-scrollbar w-96 max-w-[calc(100vw-1.5rem)] max-h-[min(75dvh,640px)] overflow-y-auto overscroll-contain gap-3"
        aria-label="Context usage breakdown"
      >
        <div>
          <h2 className="font-medium">Context usage</h2>
          <p className="mt-1 text-xs text-muted-foreground break-words">{usage?.model ?? "No model call recorded"}</p>
        </div>
        {!noModelCall && <p className="text-sm font-medium tabular-nums">{summary}</p>}
        <dl className="space-y-2 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="tabular-nums">{number(value)}</dd>
            </div>
          ))}
        </dl>
        <section className="border-t border-border pt-3" aria-label="Input breakdown">
          <h3 className="mb-2 flex justify-between gap-3 text-xs font-medium">
            <span title="Estimates use the o200k_base tokenizer and exclude provider formatting, media and encrypted reasoning.">
              Estimated input breakdown
            </span>
            {usage?.breakdown && (
              <span className="shrink-0 tabular-nums">~{number(usage.breakdown.estimatedTokens)}</span>
            )}
          </h3>
          {usage?.breakdown ? (
            <>
              <div
                role="group"
                aria-label={`Estimated input distribution: ${distribution.length ? distribution.map((category) => `${category.label} ${((category.estimatedTokens / estimatedTotal) * 100).toFixed(1)}%`).join(", ") : "No text usage"}`}
                className="mb-3 flex h-3 w-full overflow-hidden rounded-full bg-muted"
              >
                {distribution.map((category) => {
                  const label = `${category.label}: ~${number(category.estimatedTokens)} · ${((category.estimatedTokens / estimatedTotal) * 100).toFixed(1)}%`;
                  return (
                    <Tip key={category.id} label={label}>
                      <span
                        role="img"
                        tabIndex={0}
                        aria-label={label}
                        className={`${CATEGORY_COLOR[category.id]} h-full outline-none transition-[filter] hover:brightness-125 focus-visible:brightness-125 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/70`}
                        style={{ width: `${(category.estimatedTokens / estimatedTotal) * 100}%` }}
                      />
                    </Tip>
                  );
                })}
              </div>
              <div className="space-y-1">
                {usage.breakdown.categories.map((category) => (
                  <details key={category.id} className="group rounded-xl open:bg-muted/40">
                    <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-2 py-2 text-xs outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                      <span className="inline-flex min-w-0 flex-1 items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={`inline-block size-2 shrink-0 rounded-full ${CATEGORY_COLOR[category.id]}`}
                        />
                        {category.label}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {category.estimatedTokens ? "~" : ""}
                        {number(category.estimatedTokens)}
                      </span>
                      <span
                        aria-hidden="true"
                        className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-background/50 text-muted-foreground group-open:bg-accent group-open:text-foreground"
                      >
                        <Icon name="plus" size={12} className="group-open:hidden" />
                        <Icon name="minus" size={12} className="hidden group-open:block" />
                      </span>
                    </summary>
                    {category.details.length ? (
                      <dl className="space-y-2 px-3 pb-2 text-xs">
                        {category.details.map((detail) => (
                          <div key={detail.label} className="flex justify-between gap-3">
                            <dt className="min-w-0 break-words text-muted-foreground">{detail.label}</dt>
                            <dd className="shrink-0 tabular-nums">~{number(detail.estimatedTokens)}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="px-3 pb-2 text-xs text-muted-foreground">None in this request.</p>
                    )}
                  </details>
                ))}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Detailed request breakdown unavailable.</p>
          )}
        </section>
        {failed && (
          <p role="status" className="text-xs text-muted-foreground">
            Could not load context usage.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
