// Draws a surface: an A2UI v1.0 createSurface message in Rei's catalog. The engine walks the component tree from `root`,
// resolves bindings against a local copy of the data model, runs input checks locally (surface-eval, shared with the
// server), and posts an A2UI action when a button is pressed or a form is submitted. Inputs only change the local copy;
// the agent sees values only in an action. A frozen (fork copy) or removed surface draws read-only.

import {
  type A2uiComponent,
  absolutePath,
  failingChecks,
  pointerGet,
  pointerSet,
  resolveContext,
  resolveDynamic,
  resolveText,
  SURFACE_CATALOGS,
  type Surface,
  type SurfaceData,
} from "@rei/protocol";
import type { ReactNode } from "react";
import { Component, createContext, useContext, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Checkbox } from "@/components/primitives/checkbox.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { RadioGroup, RadioGroupItem } from "@/components/primitives/radio-group.tsx";
import { Separator } from "@/components/primitives/separator.tsx";
import { Spinner } from "@/components/primitives/spinner.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/primitives/tabs.tsx";
import { Textarea } from "@/components/primitives/textarea.tsx";
import { ApiError, describeError } from "../../api/client.ts";
import { newId } from "../../lib/id.ts";
import type { IconName } from "../Icon.tsx";
import { Icon } from "../Icon.tsx";
import { Markdown } from "../Markdown.tsx";
import { Tip } from "../Tip.tsx";
import { ChartView } from "./ChartView.tsx";
import { useSurfaceContext } from "./context.tsx";
import { GalleryView } from "./GalleryView.tsx";
import { LinksView } from "./LinksView.tsx";
import { MapView } from "./MapView.tsx";
import { UiFrame } from "./shared.tsx";
import { TableView } from "./TableView.tsx";
import { TimelineView } from "./TimelineView.tsx";
import type { ChartProps, GalleryProps, LinksProps, MapProps, TableProps, TimelineProps } from "./types.ts";
import { UiImage } from "./UiImage.tsx";

type Json = Record<string, unknown>;

/** Whether this client draws a surface's catalog and protocol version (otherwise its fallback text shows). */
export const canDraw = (surface: Surface): boolean =>
  !!surface.message &&
  SURFACE_CATALOGS.some(
    (c) => c.catalogId === surface.message?.createSurface.catalogId && c.protocolVersion === surface.protocolVersion,
  );

/** The ids a component refers to: children (or a template), child, tabs and form steps. */
export function childRefs(c: A2uiComponent): string[] {
  const out: string[] = [];
  const ch = c.children;
  if (Array.isArray(ch)) for (const x of ch) if (typeof x === "string") out.push(x);
  if (ch && typeof ch === "object" && !Array.isArray(ch) && typeof (ch as Json).componentId === "string")
    out.push((ch as Json).componentId as string);
  if (typeof c.child === "string") out.push(c.child);
  for (const key of ["tabs", "steps"] as const) {
    const list = c[key];
    if (Array.isArray(list)) for (const t of list as Json[]) if (typeof t.child === "string") out.push(t.child);
  }
  return out;
}

/** Components in a subtree, the root first (templates are walked once, without their items). */
function subtree(byId: ReadonlyMap<string, A2uiComponent>, rootId: string): A2uiComponent[] {
  const out: A2uiComponent[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const c = byId.get(id);
    if (!c) continue;
    out.push(c);
    stack.push(...childRefs(c).reverse());
  }
  return out;
}

const STATE_LABEL: Partial<Record<Surface["state"], { icon: IconName; text: string; tip: string }>> = {
  frozen: {
    icon: "branch",
    text: "Copy",
    tip: "A copy from the chat this one was branched from. It can't be used here.",
  },
  removed: { icon: "minus", text: "Removed", tip: "The agent removed this surface." },
};

function StateLabel({ surface }: { surface: Surface }) {
  if (surface.state === "live")
    return (
      <Tip label={surface.feed ? `Updated by ${surface.feed.title}` : "Updating"}>
        <span className="srf-state" data-state="live">
          <span className="srf-live-dot" aria-hidden="true" />
          Live
        </span>
      </Tip>
    );
  const label = STATE_LABEL[surface.state];
  if (!label) return null;
  return (
    <Tip label={label.tip}>
      <span className="srf-state" data-state={surface.state}>
        <Icon name={label.icon} size={13} />
        {label.text}
      </span>
    </Tip>
  );
}

/** A surface in a reply: its title, state and content, or its fallback text when it cannot be drawn. */
export function SurfaceView({ surface }: { surface: Surface }) {
  const ctx = useSurfaceContext();
  const drawable = canDraw(surface);
  const fallback = <p className="srf-fallback">{surface.fallback}</p>;
  return (
    <section className="srf" data-state={surface.state} aria-label={surface.title} data-surface-id={surface.surfaceId}>
      <header className="srf-head">
        <h3 className="srf-title">{surface.title}</h3>
        <StateLabel surface={surface} />
        {ctx.inspect && (
          <Tip label="Inspect surface">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="srf-inspect text-muted-foreground"
              aria-label={`Inspect surface: ${surface.title}`}
              onClick={() => ctx.inspect?.(surface.surfaceId)}
            >
              <Icon name="eye" size={15} />
            </Button>
          </Tip>
        )}
      </header>
      {surface.state === "removed" || !drawable ? (
        fallback
      ) : (
        <SafeSurface fallback={fallback}>
          <SurfaceBody key={`${surface.surfaceId}:${surface.revision}`} surface={surface} />
        </SafeSurface>
      )}
    </section>
  );
}

/** A surface that throws while drawing (a shape the checks let through) shows its text instead of taking the chat down. */
class SafeSurface extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface Engine {
  surface: Surface;
  byId: ReadonlyMap<string, A2uiComponent>;
  data: SurfaceData;
  set: (path: string, value: unknown) => void;
  interactive: boolean;
  /** Inputs whose check messages show: touched by the reader, or revealed by Next or Submit. */
  shown: ReadonlySet<string>;
  touch: (ids: readonly string[]) => void;
  send: (sourceId: string, event: Json) => Promise<void>;
  base: string;
}

const EngineContext = createContext<Engine | null>(null);
const useEngine = () => useContext(EngineContext) as Engine;

function actionError(e: unknown): string {
  if (e instanceof ApiError && e.code === "stale_surface")
    return "This surface changed since you saw it. Check the latest version and try again.";
  return describeError(e);
}

function SurfaceBody({ surface }: { surface: Surface }) {
  const ctx = useSurfaceContext();
  const message = surface.message!.createSurface;
  const [data, setData] = useState<SurfaceData>(() => (message.dataModel ?? {}) as SurfaceData);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const base = useId();
  const byId = useMemo(() => new Map((message.components ?? []).map((c) => [c.id, c])), [message.components]);
  const interactive = !!ctx.sendAction && (surface.state === "idle" || surface.state === "live");
  const dataRef = useRef(data);
  dataRef.current = data;

  const engine: Engine = {
    surface,
    byId,
    data,
    interactive,
    shown,
    base,
    set: (path, value) => setData((d) => pointerSet(d, path, value)),
    touch: (ids) => setShown((s) => new Set([...s, ...ids])),
    send: async (sourceId, event) => {
      if (!ctx.sendAction) return;
      const now = dataRef.current;
      const userMessage = event.userMessage !== undefined ? resolveText(event.userMessage, { data: now }) : "";
      await ctx.sendAction(surface, {
        requestId: newId(),
        revision: surface.revision,
        dataModel: now,
        action: {
          version: "1.0",
          action: {
            name: String(event.name),
            surfaceId: surface.surfaceId,
            sourceComponentId: sourceId,
            timestamp: new Date().toISOString(),
            context: resolveContext(event.context, { data: now }),
            ...(userMessage ? { userMessage } : {}),
          },
        },
      });
    },
  };
  return (
    <EngineContext.Provider value={engine}>
      <div className="srf-body">
        <Node id="root" />
      </div>
    </EngineContext.Provider>
  );
}

interface NodeProps {
  id: string;
  scope?: string | undefined;
  index?: number | undefined;
  depth?: number;
}

const JUSTIFY: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  spaceBetween: "space-between",
  spaceAround: "space-around",
  spaceEvenly: "space-evenly",
  stretch: "stretch",
};
const ALIGN: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" };

/** A2UI icon names Rei draws; others draw nothing. */
const ICONS: Record<string, IconName> = {
  check: "check",
  close: "close",
  search: "search",
  info: "info",
  warning: "alert",
  error: "alert",
  settings: "settings",
  home: "chat",
  calendarToday: "clock",
  event: "clock",
  locationOn: "mapPin",
  place: "mapPin",
  mail: "send",
  send: "send",
  add: "plus",
  delete: "trash",
  edit: "edit",
  download: "download",
  upload: "upload",
  share: "external",
  image: "image",
  photo: "image",
  lock: "lock",
  lockOpen: "lock",
  star: "sparkle",
  favorite: "sparkle",
  help: "info",
  arrowBack: "back",
  arrowForward: "forward",
  refresh: "reload",
  notifications: "bell",
};

function Node({ id, scope, index, depth = 0 }: NodeProps) {
  const e = useEngine();
  const c = e.byId.get(id);
  if (!c || depth > 40) return null;
  const ctx = { data: e.data, ...(scope !== undefined ? { scope } : {}), ...(index !== undefined ? { index } : {}) };
  const val = (v: unknown) => resolveDynamic(v, ctx);
  const text = (v: unknown) => (v === undefined ? undefined : resolveText(v, ctx));
  const list = <T,>(v: unknown): T[] => {
    const r = val(v);
    return Array.isArray(r) ? (r as T[]) : [];
  };
  const child = (cid: unknown) =>
    typeof cid === "string" ? <Node id={cid} scope={scope} index={index} depth={depth + 1} /> : null;
  const style = typeof c.weight === "number" ? { flexGrow: c.weight, flexBasis: 0, minWidth: 0 } : undefined;

  switch (c.component) {
    case "Text": {
      const t = text(c.text) ?? "";
      return c.variant === "caption" ? (
        <p className="srf-caption" style={style}>
          {t}
        </p>
      ) : (
        <div className="srf-text" style={style}>
          <Markdown text={t} />
        </div>
      );
    }
    case "Image": {
      const url = text(c.url) ?? "";
      return (
        <div
          className="srf-image"
          data-variant={c.variant ?? "mediumFeature"}
          data-fit={c.fit ?? "cover"}
          style={style}
        >
          <UiImage url={url} alt={text(c.description) ?? ""} />
        </div>
      );
    }
    case "Icon": {
      const name = ICONS[text(c.name) ?? ""];
      return name ? <Icon name={name} size={18} /> : null;
    }
    case "Row":
    case "Column":
    case "List": {
      const horizontal = c.component === "Row" || (c.component === "List" && c.direction === "horizontal");
      return (
        <div
          className={`srf-flex${c.component === "List" && horizontal ? " srf-scroll-x" : ""}`}
          data-axis={horizontal ? "row" : "column"}
          role={c.component === "List" ? "list" : undefined}
          style={{
            ...style,
            justifyContent: JUSTIFY[String(c.justify ?? "start")],
            alignItems: ALIGN[String(c.align ?? (horizontal ? "center" : "stretch"))],
          }}
        >
          <Children c={c} scope={scope} index={index} depth={depth} listItems={c.component === "List"} />
        </div>
      );
    }
    case "Card":
      return (
        <div className="srf-card" style={style}>
          {child(c.child)}
        </div>
      );
    case "Tabs":
      return <TabsNode c={c} scope={scope} index={index} depth={depth} />;
    case "Divider":
      return <Separator orientation={c.axis === "vertical" ? "vertical" : "horizontal"} className="srf-divider" />;
    case "Button":
      return <ButtonNode c={c} scope={scope} index={index} depth={depth} />;
    case "TextField":
    case "CheckBox":
    case "ChoicePicker":
    case "Slider":
    case "DateTimeInput":
      return <InputNode c={c} scope={scope} index={index} />;
    case "Table":
      return (
        <TableView
          props={{
            title: text(c.title),
            columns: Array.isArray(c.columns) ? (c.columns as TableProps["columns"]) : [],
            rows: list(c.rows),
            caption: text(c.caption),
            sortable: c.sortable === true,
            filterable: c.filterable === true,
            pageSize: typeof c.pageSize === "number" ? c.pageSize : undefined,
          }}
        />
      );
    case "Chart":
      return (
        <ChartView
          props={{
            title: text(c.title),
            variant: (c.variant as ChartProps["variant"] | undefined) ?? "bar",
            labels: list<unknown>(c.labels).map(String),
            series: list<ChartProps["series"][number]>(c.series).filter((s) => s && Array.isArray(s.values)),
            unit: typeof c.unit === "string" ? c.unit : undefined,
          }}
        />
      );
    case "Map":
      return <MapView props={{ title: text(c.title), places: list<MapProps["places"][number]>(c.places) }} />;
    case "Timeline":
      return <TimelineView props={{ title: text(c.title), items: list<TimelineProps["items"][number]>(c.items) }} />;
    case "Gallery":
      return <GalleryView props={{ title: text(c.title), images: list<GalleryProps["images"][number]>(c.images) }} />;
    case "Links":
      return <LinksView props={{ title: text(c.title), links: list<LinksProps["links"][number]>(c.links) }} />;
    case "Progress":
      return <ProgressNode c={c} value={val(c.value)} label={text(c.label)} status={text(c.status)} />;
    case "Steps":
      return c.variant === "checklist" ? (
        <Checklist title={text(c.title)} items={list<Json>(c.items)} />
      ) : (
        <StepsForm c={c} scope={scope} index={index} depth={depth} />
      );
    default:
      return null;
  }
}

function Children({
  c,
  scope,
  index,
  depth,
  listItems,
}: {
  c: A2uiComponent;
  scope: string | undefined;
  index: number | undefined;
  depth: number;
  listItems: boolean;
}) {
  const e = useEngine();
  const wrap = (key: string, node: ReactNode) =>
    listItems ? (
      // biome-ignore lint/a11y/useSemanticElements: the list is a flex container shared with Row and Column, so its items stay divs.
      <div role="listitem" key={key}>
        {node}
      </div>
    ) : (
      <Wrapped key={key}>{node}</Wrapped>
    );
  const ch = c.children;
  if (Array.isArray(ch))
    return (
      <>
        {ch.map((id, i) => wrap(`${id}-${i}`, <Node id={String(id)} scope={scope} index={index} depth={depth + 1} />))}
      </>
    );
  if (ch && typeof ch === "object") {
    const t = ch as Json;
    const path = absolutePath(String(t.path), scope);
    const items = pointerGet(e.data, path);
    if (!Array.isArray(items)) return null;
    return (
      <>
        {items.map((_, i) =>
          wrap(`${path}/${i}`, <Node id={String(t.componentId)} scope={`${path}/${i}`} index={i} depth={depth + 1} />),
        )}
      </>
    );
  }
  return null;
}

const Wrapped = ({ children }: { children: ReactNode }) => <>{children}</>;

function TabsNode({
  c,
  scope,
  index,
  depth,
}: {
  c: A2uiComponent;
  scope?: string | undefined;
  index?: number | undefined;
  depth: number;
}) {
  const e = useEngine();
  const tabs = Array.isArray(c.tabs) ? (c.tabs as Json[]) : [];
  const [value, setValue] = useState("0");
  if (tabs.length === 0) return null;
  const ctx = { data: e.data, ...(scope !== undefined ? { scope } : {}) };
  return (
    <Tabs value={value} onValueChange={setValue} className="srf-tabs">
      <TabsList>
        {tabs.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tabs are positional and fixed within a revision.
          <TabsTrigger key={i} value={String(i)}>
            {resolveText(t.title, ctx)}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: tabs are positional and fixed within a revision.
        <TabsContent key={i} value={String(i)} className="srf-tab-panel">
          {typeof t.child === "string" && <Node id={t.child} scope={scope} index={index} depth={depth + 1} />}
        </TabsContent>
      ))}
    </Tabs>
  );
}

function ButtonNode({
  c,
  scope,
  index,
  depth,
}: {
  c: A2uiComponent;
  scope?: string | undefined;
  index?: number | undefined;
  depth: number;
}) {
  const e = useEngine();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const event = (c.action as Json | undefined)?.event as Json | undefined;
  const ctx = { data: e.data, ...(scope !== undefined ? { scope } : {}) };
  const blocked = failingChecks(c as Json, ctx);
  const disabled = !e.interactive || !event || busy || blocked.length > 0;
  async function press() {
    if (disabled || !event) return;
    setBusy(true);
    setError(null);
    try {
      await e.send(c.id, event);
      setSent(true);
    } catch (err) {
      setError(actionError(err));
    } finally {
      setBusy(false);
    }
  }
  const variant = c.variant === "primary" ? "default" : c.variant === "borderless" ? "ghost" : "outline";
  const button = (
    <Button type="button" size="sm" variant={variant} disabled={disabled} aria-busy={busy} onClick={() => void press()}>
      {busy ? <Spinner /> : null}
      {typeof c.child === "string" && <Node id={c.child} scope={scope} index={index} depth={depth + 1} />}
    </Button>
  );
  return (
    <div className="srf-button">
      {blocked.length > 0 && e.interactive ? <Tip label={blocked[0]!}>{button}</Tip> : button}
      {sent && (
        <span className="ui-sent" role="status">
          <Icon name="check" size={14} /> Sent
        </span>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function InputNode({ c, scope, index }: { c: A2uiComponent; scope?: string | undefined; index?: number | undefined }) {
  const e = useEngine();
  const ctx = { data: e.data, ...(scope !== undefined ? { scope } : {}), ...(index !== undefined ? { index } : {}) };
  const key = `${scope ?? ""}#${c.id}`;
  const fid = `${e.base}-${key}`;
  const binding =
    c.value && typeof c.value === "object" && typeof (c.value as Json)["@path"] === "string"
      ? absolutePath((c.value as Json)["@path"] as string, scope)
      : undefined;
  const value = resolveDynamic(c.value, ctx);
  const disabled = !e.interactive || !binding;
  const set = (v: unknown) => {
    if (binding) e.set(binding, v);
  };
  const errors = e.shown.has(key) || e.shown.has(c.id) ? failingChecks(c as Json, ctx) : [];
  const label = c.label !== undefined ? resolveText(c.label, ctx) : "";
  const errorId = errors.length ? `${fid}-err` : undefined;
  const touch = () => e.touch([key]);
  let control: ReactNode;
  switch (c.component) {
    case "TextField": {
      const common = {
        id: fid,
        value: value === undefined || value === null ? "" : String(value),
        disabled,
        placeholder: c.placeholder !== undefined ? resolveText(c.placeholder, ctx) : undefined,
        "aria-invalid": errors.length > 0 || undefined,
        "aria-describedby": errorId,
        onBlur: touch,
      };
      control =
        c.variant === "longText" ? (
          <Textarea {...common} onChange={(ev) => set(ev.target.value)} className="min-h-20" />
        ) : (
          <Input
            {...common}
            type={c.variant === "obscured" ? "password" : "text"}
            inputMode={c.variant === "number" ? "decimal" : undefined}
            onChange={(ev) => set(ev.target.value)}
          />
        );
      break;
    }
    case "CheckBox":
      return (
        <div className="srf-field" data-invalid={errors.length > 0 || undefined}>
          <label className="srf-check" htmlFor={fid}>
            <Checkbox
              id={fid}
              checked={value === true}
              disabled={disabled}
              aria-describedby={errorId}
              onCheckedChange={(v) => {
                set(v === true);
                touch();
              }}
            />
            <span>{label}</span>
          </label>
          <FieldErrors id={errorId} errors={errors} />
        </div>
      );
    case "ChoicePicker": {
      const options = Array.isArray(c.options) ? (c.options as Json[]) : [];
      const picked = Array.isArray(value) ? value.map(String) : [];
      const single = c.variant === "mutuallyExclusive";
      const optionLabel = (o: Json) => resolveText(o.label, ctx);
      if (c.displayStyle === "chips")
        control = (
          <fieldset className="srf-chips srf-fieldset" aria-labelledby={`${fid}-label`}>
            {options.map((o) => {
              const v = String(o.value);
              const on = picked.includes(v);
              return (
                <Button
                  key={v}
                  type="button"
                  size="sm"
                  variant={on ? "default" : "outline"}
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => {
                    set(single ? [v] : on ? picked.filter((p) => p !== v) : [...picked, v]);
                    touch();
                  }}
                >
                  {optionLabel(o)}
                </Button>
              );
            })}
          </fieldset>
        );
      else if (single)
        control = (
          <RadioGroup
            aria-labelledby={`${fid}-label`}
            value={picked[0] ?? ""}
            disabled={disabled}
            onValueChange={(v) => {
              set([v]);
              touch();
            }}
          >
            {options.map((o, i) => (
              <label key={String(o.value)} className="srf-check" htmlFor={`${fid}-o${i}`}>
                <RadioGroupItem id={`${fid}-o${i}`} value={String(o.value)} />
                <span>{optionLabel(o)}</span>
              </label>
            ))}
          </RadioGroup>
        );
      else
        control = (
          <fieldset aria-labelledby={`${fid}-label`} className="srf-options srf-fieldset">
            {options.map((o, i) => {
              const v = String(o.value);
              return (
                <label key={v} className="srf-check" htmlFor={`${fid}-o${i}`}>
                  <Checkbox
                    id={`${fid}-o${i}`}
                    checked={picked.includes(v)}
                    disabled={disabled}
                    onCheckedChange={(on) => {
                      set(on === true ? [...picked, v] : picked.filter((p) => p !== v));
                      touch();
                    }}
                  />
                  <span>{optionLabel(o)}</span>
                </label>
              );
            })}
          </fieldset>
        );
      return (
        <div className="srf-field" data-invalid={errors.length > 0 || undefined}>
          {label && (
            <span className="srf-label" id={`${fid}-label`}>
              {label}
            </span>
          )}
          {control}
          <FieldErrors id={errorId} errors={errors} />
        </div>
      );
    }
    case "Slider": {
      const min = typeof c.min === "number" ? c.min : 0;
      const max = typeof c.max === "number" ? c.max : 100;
      const step = typeof c.steps === "number" && c.steps > 0 ? (max - min) / c.steps : "any";
      const n = typeof value === "number" ? value : min;
      control = (
        <div className="srf-slider">
          <input
            id={fid}
            type="range"
            min={min}
            max={max}
            step={step}
            value={n}
            disabled={disabled}
            aria-describedby={errorId}
            onChange={(ev) => set(Number(ev.target.value))}
            onBlur={touch}
          />
          <output htmlFor={fid}>{n}</output>
        </div>
      );
      break;
    }
    case "DateTimeInput": {
      const date = c.enableDate !== false;
      const time = c.enableTime === true;
      control = (
        <Input
          id={fid}
          type={date && time ? "datetime-local" : time ? "time" : "date"}
          value={typeof value === "string" ? value : ""}
          min={typeof c.min === "string" ? c.min : undefined}
          max={typeof c.max === "string" ? c.max : undefined}
          disabled={disabled}
          aria-invalid={errors.length > 0 || undefined}
          aria-describedby={errorId}
          onChange={(ev) => set(ev.target.value)}
          onBlur={touch}
        />
      );
      break;
    }
    default:
      return null;
  }
  return (
    <div className="srf-field" data-invalid={errors.length > 0 || undefined}>
      {label && (
        <label className="srf-label" htmlFor={fid}>
          {label}
        </label>
      )}
      {control}
      <FieldErrors id={errorId} errors={errors} />
    </div>
  );
}

function FieldErrors({ id, errors }: { id: string | undefined; errors: string[] }) {
  if (!errors.length) return null;
  return (
    <p id={id} className="form-error" role="alert">
      {errors.join(" ")}
    </p>
  );
}

const STEP_ICON: Record<string, IconName> = { done: "check", failed: "alert", skipped: "minus", pending: "clock" };

function ProgressNode({
  c,
  value,
  label,
  status,
}: {
  c: A2uiComponent;
  value: unknown;
  label?: string | undefined;
  status?: string | undefined;
}) {
  const pct = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
  const statusIcon = status ? STEP_ICON[status] : undefined;
  if (c.variant === "status")
    return (
      <p className="srf-progress-status" data-status={status}>
        {status === "running" ? <Spinner /> : statusIcon ? <Icon name={statusIcon} size={14} /> : null}
        <span>{label}</span>
        {status && <span className="ui-sub">{status}</span>}
      </p>
    );
  return (
    <div className="srf-progress" data-status={status}>
      <div className="srf-progress-line">
        <span>{label}</span>
        <span className="ui-sub">
          {[pct !== undefined ? `${Math.round(pct)}%` : "", status ?? ""].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div
        className="srf-bar"
        role="progressbar"
        aria-label={label || "Progress"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        data-indeterminate={pct === undefined && status !== "done" ? "true" : undefined}
      >
        <span style={{ width: `${pct ?? (status === "done" ? 100 : 30)}%` }} />
      </div>
    </div>
  );
}

function Checklist({ title, items }: { title?: string | undefined; items: Json[] }) {
  return (
    <UiFrame kind="steps" title={title}>
      <ol className="srf-checklist">
        {items.map((it, i) => {
          const status = typeof it.status === "string" ? it.status : "pending";
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: checklist items have no ids; position is their identity.
            <li key={i} data-status={status}>
              <span className="srf-check-icon" aria-hidden="true">
                {status === "running" ? <Spinner /> : <Icon name={STEP_ICON[status] ?? "clock"} size={14} />}
              </span>
              <span className="srf-check-main">
                <span>{String(it.title ?? "")}</span>
                {typeof it.detail === "string" && it.detail && <span className="ui-sub">{it.detail}</span>}
              </span>
              <span className="sr-only"> ({status})</span>
            </li>
          );
        })}
      </ol>
    </UiFrame>
  );
}

function StepsForm({
  c,
  scope,
  index,
  depth,
}: {
  c: A2uiComponent;
  scope?: string | undefined;
  index?: number | undefined;
  depth: number;
}) {
  const e = useEngine();
  const ctxValue = useSurfaceContext();
  const steps = Array.isArray(c.steps) ? (c.steps as Json[]) : [];
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentNow, setSentNow] = useState(false);
  const event = (c.action as Json | undefined)?.event as Json | undefined;
  const ctx = { data: e.data, ...(scope !== undefined ? { scope } : {}) };
  const title = c.title !== undefined ? resolveText(c.title, ctx) : undefined;
  const sent = sentNow || !!ctxValue.submitted?.(e.surface.surfaceId, c.id);
  if (steps.length === 0) return null;

  const failingIn = (i: number) => {
    const child = steps[i]?.child;
    if (typeof child !== "string") return [];
    return subtree(e.byId, child).filter((x) => failingChecks(x as Json, { data: e.data }).length > 0);
  };
  const reveal = (bad: A2uiComponent[]) => {
    e.touch(bad.map((b) => b.id));
    const first = bad[0];
    if (first) setTimeout(() => document.getElementById(`${e.base}-#${first.id}`)?.focus(), 0);
  };
  const next = () => {
    const bad = failingIn(at);
    if (bad.length) return reveal(bad);
    setAt(at + 1);
  };
  async function submit() {
    if (!event || busy) return;
    for (let i = 0; i < steps.length; i++) {
      const bad = failingIn(i);
      if (bad.length) {
        setAt(i);
        return reveal(bad);
      }
    }
    setBusy(true);
    setError(null);
    try {
      await e.send(c.id, event);
      setSentNow(true);
    } catch (err) {
      setError(actionError(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    const values = resolveContext(event?.context, { data: e.data });
    return (
      <UiFrame kind="form" title={title}>
        <p className="ui-submitted" role="status">
          <Icon name="check" size={14} /> Sent
        </p>
        {!sentNow ? null : (
          <dl className="ui-fields ui-sent-values">
            {Object.entries(values).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{Array.isArray(v) ? v.join(", ") : String(v ?? "")}</dd>
              </div>
            ))}
          </dl>
        )}
      </UiFrame>
    );
  }

  const step = steps[at]!;
  const last = at === steps.length - 1;
  const submitLabel = c.submitLabel !== undefined ? resolveText(c.submitLabel, ctx) : "Submit";
  return (
    <UiFrame kind="form" title={title}>
      {steps.length > 1 && (
        <ol className="srf-stepper" aria-label="Steps">
          {steps.map((s, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional and fixed within a revision.
              key={i}
              data-state={i < at ? "done" : i === at ? "current" : "next"}
              aria-current={i === at ? "step" : undefined}
            >
              <span className="srf-stepper-n" aria-hidden="true">
                {i < at ? <Icon name="check" size={12} /> : i + 1}
              </span>
              <span className="srf-stepper-t">{resolveText(s.title, ctx)}</span>
            </li>
          ))}
        </ol>
      )}
      <form
        className="srf-step"
        aria-label={`Step ${at + 1} of ${steps.length}: ${resolveText(step.title, ctx)}`}
        onSubmit={(ev) => {
          ev.preventDefault();
          if (last) void submit();
          else next();
        }}
      >
        {typeof step.child === "string" && <Node id={step.child} scope={scope} index={index} depth={depth + 1} />}
        <div className="srf-step-actions">
          {at > 0 && (
            <Tip label="Back">
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Back" onClick={() => setAt(at - 1)}>
                <Icon name="back" size={16} />
              </Button>
            </Tip>
          )}
          <Button type="submit" size="sm" disabled={!e.interactive || busy || (last && !event)} aria-busy={busy}>
            {busy && <Spinner />}
            {last ? submitLabel : "Next"}
          </Button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </UiFrame>
  );
}
