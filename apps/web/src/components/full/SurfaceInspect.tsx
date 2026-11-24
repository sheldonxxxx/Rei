import type { A2uiComponent, Surface, SurfaceDetailResponse, SurfaceRevision } from "@rei/protocol";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { cn } from "@/lib/utils.ts";
import type { Api } from "../../api/client.ts";
import { describeError } from "../../api/client.ts";
import { formatWhen } from "../../lib/time.ts";
import { Icon } from "../Icon.tsx";
import { SurfaceView } from "../surface/SurfaceView.tsx";
import { FACTS, NOTE, NOTE_ERROR, QUIET, SECTION } from "./factStyles.ts";

const ITEM =
  "ctx-item mt-1.5 rounded-lg border bg-card text-sm [&>p]:m-2.5 [&>pre]:m-0 [&>pre]:max-h-80 [&>pre]:overflow-auto [&>pre]:p-2.5 [&>pre]:text-xs [&>summary]:flex [&>summary]:min-h-9 [&>summary]:cursor-pointer [&>summary]:items-baseline [&>summary]:gap-2 [&>summary]:px-2.5 [&>summary]:py-1.5 [&>summary]:font-medium [&[open]>summary]:border-b";
const ROW =
  "flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-muted data-[active=true]:bg-muted";

const DECISION: Record<string, string> = {
  accepted: "Accepted",
  stale: "Stale",
  rejected: "Refused",
  duplicate: "Duplicate",
};

/** Every JSON Pointer in a value whose leaf differs between two data models. */
export function changedPaths(before: unknown, after: unknown, path = ""): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const isObj = (v: unknown) => v !== null && typeof v === "object";
  if (!isObj(before) || !isObj(after) || Array.isArray(before) !== Array.isArray(after)) return [path || "/"];
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.flatMap((k) => changedPaths(a[k], b[k], `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`));
}

/** Component ids added, removed and changed between two revisions. */
export function componentDiff(before: A2uiComponent[], after: A2uiComponent[]) {
  const a = new Map(before.map((c) => [c.id, JSON.stringify(c)]));
  const b = new Map(after.map((c) => [c.id, JSON.stringify(c)]));
  return {
    added: [...b.keys()].filter((id) => !a.has(id)),
    removed: [...a.keys()].filter((id) => !b.has(id)),
    changed: [...b.keys()].filter((id) => a.has(id) && a.get(id) !== b.get(id)),
  };
}

const authorLabel = (r: SurfaceRevision) => (r.author.kind === "agent" ? `Agent · ${r.author.tool}` : "Worker feed");

/** The Inspector's Surfaces tab: the chat's surfaces, and one in full (revisions, content, diffs, refusals, actions). */
export function SurfaceInspect({
  api,
  sessionId,
  surfaces,
  selected,
  onSelect,
  onOpenCall,
}: {
  api: Api;
  sessionId: string;
  surfaces: Surface[];
  selected: string | null;
  onSelect: (surfaceId: string | null) => void;
  /** Opens the step of a tool call, when the trace holds it. */
  onOpenCall?: ((toolCallId: string) => boolean) | undefined;
}) {
  const current = surfaces.find((s) => s.surfaceId === selected);
  if (!current)
    return surfaces.length === 0 ? (
      <p className={QUIET}>No surfaces in this chat.</p>
    ) : (
      <section aria-label="Surfaces">
        <h4 className={SECTION}>Surfaces · {surfaces.length}</h4>
        <ul className="m-0 list-none p-0">
          {surfaces.map((s) => (
            <li key={s.surfaceId}>
              <button type="button" className={ROW} onClick={() => onSelect(s.surfaceId)}>
                <Icon name="grid" size={14} />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="text-xs text-muted-foreground">
                  {s.state} · rev {s.revision}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <SurfaceDetail key={current.surfaceId} api={api} sessionId={sessionId} surface={current} onOpenCall={onOpenCall} />
  );
}

function SurfaceDetail({
  api,
  sessionId,
  surface,
  onOpenCall,
}: {
  api: Api;
  sessionId: string;
  surface: Surface;
  onOpenCall?: ((toolCallId: string) => boolean) | undefined;
}) {
  const [detail, setDetail] = useState<SurfaceDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  // Fetch again when the surface changes (a new revision, a removal, a feed ending).
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and state are refetch triggers, not values read here.
  useEffect(() => {
    let live = true;
    api
      .surfaceDetail(sessionId, surface.surfaceId)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setError(null);
      })
      .catch((e) => live && setError(describeError(e)));
    return () => {
      live = false;
    };
  }, [api, sessionId, surface.surfaceId, surface.revision, surface.state]);

  const revisions = detail?.revisions ?? [];
  const shown = revisions.find((r) => r.revision === (pick ?? surface.revision)) ?? revisions.at(-1);
  const previous = useMemo(() => {
    if (!shown) return undefined;
    return [...revisions].reverse().find((r) => r.revision < shown.revision && r.components);
  }, [revisions, shown]);
  if (error)
    return (
      <p className={NOTE_ERROR} role="alert">
        <Icon name="alert" size={16} />
        <span>{error}</span>
      </p>
    );
  if (!detail || !shown)
    return (
      <p className={QUIET} role="status">
        Loading…
      </p>
    );

  const drawn: Surface | null =
    shown.components && shown.dataModel
      ? {
          ...detail.surface,
          revision: shown.revision,
          message: {
            version: "1.0",
            createSurface: {
              surfaceId: surface.surfaceId,
              catalogId: detail.surface.message?.createSurface.catalogId ?? "rei/catalog/1",
              components: shown.components,
              dataModel: shown.dataModel,
            },
          },
        }
      : null;
  const diff = previous?.components && shown.components ? componentDiff(previous.components, shown.components) : null;
  const dataChanges = previous?.dataModel && shown.dataModel ? changedPaths(previous.dataModel, shown.dataModel) : [];

  return (
    <div className="flex flex-col gap-2">
      <dl className={FACTS}>
        <div>
          <dt>Surface</dt>
          <dd>{surface.title}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{detail.surface.state}</dd>
        </div>
        <div>
          <dt>Id</dt>
          <dd className="font-mono text-xs">{surface.surfaceId}</dd>
        </div>
        <div>
          <dt>Catalog</dt>
          <dd>
            {detail.surface.message?.createSurface.catalogId ?? "—"} · A2UI {detail.surface.protocolVersion}
          </dd>
        </div>
        {detail.surface.feed && (
          <div>
            <dt>Fed by</dt>
            <dd>{detail.surface.feed.title}</dd>
          </div>
        )}
      </dl>

      <section aria-label="Revisions">
        <h4 className={SECTION}>Revisions · {revisions.length}</h4>
        <ol className="m-0 flex max-h-56 list-none flex-col overflow-y-auto p-0">
          {[...revisions].reverse().map((r) => (
            <li key={r.revision}>
              <button
                type="button"
                className={ROW}
                data-active={r.revision === shown.revision}
                aria-current={r.revision === shown.revision ? "true" : undefined}
                onClick={() => setPick(r.revision)}
              >
                <span className="w-8 shrink-0 tabular-nums text-muted-foreground">{r.revision}</span>
                <span className="min-w-0 flex-1 truncate">{r.summary}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{authorLabel(r)}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label={`Revision ${shown.revision}`}>
        <h4 className={SECTION}>
          Revision {shown.revision} · {formatWhen(shown.at)}
        </h4>
        {shown.author.kind === "agent" && onOpenCall && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => {
              if (shown.author.kind === "agent" && !onOpenCall(shown.author.toolCallId))
                setError("That tool call isn't in the loaded trace.");
            }}
          >
            Open the {shown.author.tool} step
          </Button>
        )}
        {drawn ? (
          <div className="mt-1.5">
            <SurfaceView surface={drawn} />
          </div>
        ) : (
          <p className={NOTE}>Only the summary of this revision is kept; its content is past the kept window.</p>
        )}
        {diff && (
          <dl className={cn(FACTS, "mt-2")}>
            <div>
              <dt>Components</dt>
              <dd>
                {[
                  diff.added.length ? `added ${diff.added.join(", ")}` : "",
                  diff.removed.length ? `removed ${diff.removed.join(", ")}` : "",
                  diff.changed.length ? `changed ${diff.changed.join(", ")}` : "",
                ]
                  .filter(Boolean)
                  .join("; ") || "unchanged"}
              </dd>
            </div>
            <div>
              <dt>Data</dt>
              <dd className="font-mono text-xs">
                {dataChanges.length ? dataChanges.slice(0, 20).join(", ") : "unchanged"}
              </dd>
            </div>
          </dl>
        )}
        {shown.messages && (
          <details className={ITEM}>
            <summary>A2UI messages · {shown.messages.length}</summary>
            <pre>{JSON.stringify(shown.messages, null, 2)}</pre>
          </details>
        )}
        {shown.components && (
          <details className={ITEM}>
            <summary>Components · {shown.components.length}</summary>
            <pre>{JSON.stringify(shown.components, null, 2)}</pre>
          </details>
        )}
        {shown.dataModel && (
          <details className={ITEM}>
            <summary>Data model</summary>
            <pre>{JSON.stringify(shown.dataModel, null, 2)}</pre>
          </details>
        )}
      </section>

      <section aria-label="Refused calls">
        <h4 className={SECTION}>Refused calls · {detail.failures.length}</h4>
        {detail.failures.length === 0 ? (
          <p className={NOTE}>None. Every call for this surface passed the checks.</p>
        ) : (
          detail.failures.map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log with no ids.
            <details key={i} className={ITEM}>
              <summary>
                {f.tool} · {formatWhen(f.at)}
              </summary>
              <pre>{f.errors.join("\n")}</pre>
            </details>
          ))
        )}
      </section>

      <section aria-label="Actions">
        <h4 className={SECTION}>Actions · {detail.actions.length}</h4>
        {detail.actions.length === 0 ? (
          <p className={NOTE}>Nothing was pressed or submitted yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
            {[...detail.actions].reverse().map((a, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: an append-only log with no ids.
              <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{DECISION[a.decision] ?? a.decision}</span>
                <span>
                  {a.name} from {a.componentId}, rev {a.revision}
                </span>
                <span className="text-xs text-muted-foreground">{formatWhen(a.at)}</span>
                {a.reason && <span className="basis-full text-xs text-muted-foreground">{a.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
