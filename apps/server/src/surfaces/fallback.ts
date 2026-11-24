// The plain-text fallback of a surface: everything it shows, as text, for clients that cannot draw it, notifications,
// history search and copy. Written by the server from the catalog, never by the model.

import { type A2uiComponent, absolutePath, pointerGet, resolveDynamic, type SurfaceDataModel } from "@rei/protocol";

type Json = Record<string, unknown>;

export const FALLBACK_MAX_CHARS = 8_000;
const MAX_ROWS = 50;

const resolveValue = (value: unknown, data: SurfaceDataModel, scope?: string): unknown =>
  resolveDynamic(value, { data, ...(scope !== undefined ? { scope } : {}) });

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Writes a surface's fallback text. */
export function surfaceFallback(title: string, components: readonly A2uiComponent[], data: SurfaceDataModel): string {
  const byId = new Map(components.map((c) => [c.id, c]));
  const lines: string[] = [title];
  const seen = new Set<string>();
  const str = (v: unknown, scope?: string) => text(resolveValue(v, data, scope)).trim();
  const list = (v: unknown, scope?: string): Json[] => {
    const r = resolveValue(v, data, scope);
    return Array.isArray(r) ? (r as Json[]) : [];
  };
  const walk = (id: string, scope?: string): void => {
    const key = `${scope ?? ""}#${id}`;
    if (seen.has(key) || lines.length > 400) return;
    seen.add(key);
    const c = byId.get(id);
    if (!c) return;
    const push = (line: string) => {
      if (line.trim() !== "") lines.push(line);
    };
    const titleOf = () => (c.title !== undefined ? str(c.title, scope) : "");
    switch (c.component) {
      case "Text":
        push(str(c.text, scope));
        break;
      case "Image":
        push(`[Image${c.description ? `: ${str(c.description, scope)}` : ""}] ${str(c.url, scope)}`);
        break;
      case "Button": {
        const childText = typeof c.child === "string" ? childLabel(c.child) : "";
        push(`[${childText || "Button"}]`);
        return;
      }
      case "TextField":
        push(`${str(c.label, scope)}: ${c.variant === "obscured" ? "••••" : str(c.value, scope)}`);
        break;
      case "CheckBox":
        push(`[${resolveValue(c.value, data, scope) === true ? "x" : " "}] ${str(c.label, scope)}`);
        break;
      case "ChoicePicker": {
        const options = Array.isArray(c.options) ? (c.options as Json[]) : [];
        const chosen = resolveValue(c.value, data, scope);
        const picked = Array.isArray(chosen) ? chosen.map(String) : [];
        push(
          `${str(c.label, scope)}: ${options.map((o) => `${picked.includes(String(o.value)) ? "(x) " : ""}${str(o.label, scope)}`).join(", ")}`,
        );
        break;
      }
      case "Slider":
        push(`${str(c.label, scope)}: ${str(c.value, scope)}`);
        break;
      case "DateTimeInput":
        push(`${str(c.label, scope) || "Date"}: ${str(c.value, scope)}`);
        break;
      case "Table": {
        push(titleOf());
        const cols = Array.isArray(c.columns) ? (c.columns as Json[]) : [];
        const rows = list(c.rows, scope);
        push(cols.map((col) => String(col.label)).join(" | "));
        for (const row of rows.slice(0, MAX_ROWS)) push(cols.map((col) => text(row[String(col.key)])).join(" | "));
        if (rows.length > MAX_ROWS) push(`… ${rows.length - MAX_ROWS} more rows`);
        if (c.caption !== undefined) push(str(c.caption, scope));
        break;
      }
      case "Chart": {
        push(titleOf());
        const labels = list(c.labels, scope) as unknown as string[];
        const unit = typeof c.unit === "string" ? ` ${c.unit}` : "";
        for (const s of list(c.series, scope)) {
          const values = Array.isArray(s.values) ? s.values : [];
          push(`${text(s.name)}: ${labels.map((l, i) => `${l} ${text(values[i])}${unit}`).join(", ")}`);
        }
        break;
      }
      case "Map":
        push(titleOf());
        for (const p of list(c.places, scope))
          push(`${text(p.name)} (${text(p.lat)}, ${text(p.lon)})${p.note ? `: ${text(p.note)}` : ""}`);
        break;
      case "Timeline":
        push(titleOf());
        for (const it of list(c.items, scope))
          push(
            [it.date, it.time, it.title, it.location, it.detail]
              .filter((x) => x !== undefined && x !== "")
              .map(text)
              .join(" · "),
          );
        break;
      case "Gallery":
        push(titleOf());
        for (const img of list(c.images, scope)) push(`${text(img.caption) || "Image"}: ${text(img.url)}`);
        break;
      case "Links":
        push(titleOf());
        for (const l of list(c.links, scope)) push(`${text(l.title)} — ${text(l.url)}`);
        break;
      case "Progress": {
        const value = resolveValue(c.value, data, scope);
        const status = str(c.status, scope);
        push(
          [str(c.label, scope), typeof value === "number" ? `${Math.round(value)}%` : "", status ? `(${status})` : ""]
            .filter(Boolean)
            .join(" "),
        );
        break;
      }
      case "Steps":
        push(titleOf());
        if (c.variant === "checklist") {
          const mark: Record<string, string> = { done: "✓", failed: "✗", running: "…", skipped: "–", pending: "○" };
          for (const it of list(c.items, scope))
            push(`${mark[String(it.status)] ?? "○"} ${text(it.title)}${it.detail ? ` — ${text(it.detail)}` : ""}`);
        } else if (Array.isArray(c.steps)) {
          (c.steps as Json[]).forEach((s, i) => {
            push(`Step ${i + 1}: ${str(s.title, scope)}`);
            if (typeof s.child === "string") walk(s.child, scope);
          });
          push(`[${str(c.submitLabel, scope) || "Submit"}]`);
        }
        return;
      case "Tabs":
        if (Array.isArray(c.tabs))
          for (const t of c.tabs as Json[]) {
            push(str(t.title, scope));
            if (typeof t.child === "string") walk(t.child, scope);
          }
        return;
      default:
        break;
    }
    // Containers: static children, or a template repeated over a data list.
    const children = c.children;
    if (Array.isArray(children)) for (const ch of children) if (typeof ch === "string") walk(ch, scope);
    if (children && typeof children === "object" && !Array.isArray(children)) {
      const t = children as Json;
      const base = absolutePath(String(t.path), scope);
      const items = pointerGet(data, base);
      if (Array.isArray(items))
        items.slice(0, MAX_ROWS).forEach((_, i) => {
          walk(String(t.componentId), `${base}/${i}`);
        });
    }
    if (typeof c.child === "string") walk(c.child, scope);
  };
  const childLabel = (id: string): string => {
    const c = byId.get(id);
    if (!c) return "";
    if (c.component === "Text") return str(c.text);
    if (typeof c.child === "string") return childLabel(c.child);
    if (Array.isArray(c.children)) return c.children.map((x) => childLabel(String(x))).join(" ");
    return "";
  };
  walk("root");
  const out = lines.join("\n");
  return out.length > FALLBACK_MAX_CHARS ? `${out.slice(0, FALLBACK_MAX_CHARS - 1)}…` : out;
}
