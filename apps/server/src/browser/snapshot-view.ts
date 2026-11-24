// Two cheaper readings of a page snapshot (Playwright's ariaSnapshot in "ai" mode: two spaces per level, every element line
// carries [ref=eN], and refs stay the same across snapshots of one page): what can be acted on, and what changed since last time.
import type { BrowserSnapshot } from "./driver.ts";

export type SnapshotView = "full" | "interactive" | "changes" | "text";
export const REF = /^p(\d+)(f\d+)?(e\d+)$/;
const NATIVE_REF = /^(f\d+)?(e\d+)$/;

export function snapshotRef(snapshot: Pick<BrowserSnapshot, "prefixes">, nativeRef: string): string | undefined {
  const m = NATIVE_REF.exec(nativeRef);
  if (!m) return undefined;
  const prefix = snapshot.prefixes.get(m[1] ?? "");
  return prefix ? `${prefix}${m[2]}` : undefined;
}

export function nativeRefPrefix(ref: string): string | undefined {
  const m = NATIVE_REF.exec(ref);
  return m ? (m[1] ?? "") : undefined;
}

interface Node {
  line: string;
  role: string;
  name: string | undefined;
  attrs: string;
  inline: string;
  ref: string | undefined;
  indent: number;
  children: Node[];
  parent: Node | undefined;
}

// `- role "name" [attr] [attr]:` or `: inline text`; ref-less children (`text: x`, `/url: x`, `option "A"`) parse the same way.
const LINE = /^- ([^\s:"[]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::(?: (.*))?)?$/;
const REF_ATTR = / \[ref=((?:f\d+)?e\d+)\]/g;

/** The ref attribute lives in the node header, outside labels and inline text. */
export function mapSnapshotRefs(raw: string, map: (ref: string) => string | undefined): string {
  return raw
    .split("\n")
    .map((line) => {
      const node = LINE.exec(line.trimStart());
      const attrs = node?.[3];
      if (!attrs || !node) return line;
      const head = `- ${node[1]}${node[2] === undefined ? "" : ` "${node[2]}"`}`;
      const start = line.length - line.trimStart().length + head.length;
      const rewritten = attrs.replaceAll(REF_ATTR, (_attr, ref: string) => {
        const mapped = map(ref);
        return mapped ? ` [ref=${mapped}]` : "";
      });
      return `${line.slice(0, start)}${rewritten}${line.slice(start + attrs.length)}`;
    })
    .join("\n");
}

/** Read only real ref attributes from the snapshot. */
export function nativeSnapshotRefs(raw: string): string[] {
  const refs: string[] = [];
  mapSnapshotRefs(raw, (ref) => {
    refs.push(ref);
    return ref;
  });
  return refs;
}

function parse(raw: string): Node[] {
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const full of raw.split("\n")) {
    const line = full.trim();
    if (line === "") continue;
    const indent = (full.length - full.trimStart().length) >> 1;
    const m = LINE.exec(line);
    const attrs = m?.[3] ?? "";
    const node: Node = {
      line,
      role: m?.[1] ?? "",
      name: m?.[2],
      attrs,
      inline: m?.[4] ?? "",
      ref: /\[ref=([^\]]+)\]/.exec(attrs)?.[1],
      indent,
      children: [],
      parent: undefined,
    };
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    node.parent = parent;
    (parent ? parent.children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

export const ACTIONABLE = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
]);
// Containers that say nothing when they have no name and no text of their own.
const WRAPPERS = new Set(["generic", "group", "none", "presentation"]);
const LABEL_CHARS = 80;

const canAct = (n: Node): boolean => ACTIONABLE.has(n.role) || n.attrs.includes("[cursor=pointer]");
const clipLine = (n: Node): string => (n.line.length > LABEL_CHARS ? `${n.line.slice(0, LABEL_CHARS - 1)}…` : n.line);

type Out = { d: number; text: string };
const deeper = (outs: Out[]): Out[] => outs.map((o) => ({ d: o.d + 1, text: o.text }));

/** Lines of `n` at depth 0 (or of what survives of it: a bare wrapper hands its children up one level). */
function emit(n: Node): Out[] {
  const mine = canAct(n) || n.role === "heading";
  const labels = n.children.some((c) => c.ref !== undefined && canAct(c));
  const inner: Out[] = [];
  for (const c of n.children) {
    if (c.ref !== undefined) inner.push(...emit(c));
    // Ref-less children belong to an element that can be acted on (its /url, its options); next to one they are its label.
    else if (canAct(n) || (labels && c.role === "text"))
      inner.push({ d: 0, text: c.role === "text" ? clipLine(c) : c.line });
  }
  if (!mine && inner.length === 0) return [];
  if (!mine && WRAPPERS.has(n.role) && n.name === undefined && n.inline === "") return inner;
  return [{ d: 0, text: n.line }, ...deeper(inner)];
}

/** The page cut down to what can be clicked or filled in, with the headings and landmarks around it. Empty when there is none. */
export function interactiveView(raw: string): string {
  const roots = parse(raw);
  const anyActionable = (n: Node): boolean => canAct(n) || n.children.some(anyActionable);
  if (!roots.some(anyActionable)) return ""; // headings alone are not worth a view
  const outs = roots.flatMap(emit);
  return outs.map((o) => `${"  ".repeat(o.d)}${o.text}`).join("\n");
}

// Focus moving ([active]) is not a change: every click would otherwise report the old and the new focus.
const own = (n: Node): string =>
  [n.line, ...n.children.filter((c) => c.ref === undefined).map((c) => c.line)].join("\n").replaceAll(" [active]", "");

type ResolveRef = (ref: string) => string | undefined;
const identityRef = (ref: string): string => ref;

function byRef(roots: Node[], resolve: ResolveRef): Map<string, Node> {
  const map = new Map<string, Node>();
  const walk = (n: Node): void => {
    const ref = n.ref === undefined ? undefined : resolve(n.ref);
    if (ref !== undefined) map.set(ref, n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return map;
}

/** Puts `tag` after the attributes of an element line, before its `:` or inline text. */
function mark(n: Node, tag: string): string {
  const head = `- ${n.role}${n.name !== undefined ? ` "${n.name}"` : ""}${n.attrs}`;
  return n.line.startsWith(head) ? `${head} ${tag}${n.line.slice(head.length)}` : `${n.line} ${tag}`;
}

const REMOVED_LISTED = 50;

/** What differs between two snapshots of one page, matched by ref: added and changed elements under their ancestors, then the removed refs. */
export function changesView(
  before: string,
  after: string,
  beforeRef: ResolveRef = identityRef,
  afterRef: ResolveRef = identityRef,
): { text: string; added: number; changed: number; removed: number } {
  const old = byRef(parse(before), beforeRef);
  const roots = parse(after);
  const now = byRef(roots, afterRef);
  const lines: string[] = [];
  const shown = new Set<Node>();
  let added = 0;
  let changed = 0;
  const show = (n: Node, text: string): void => {
    shown.add(n);
    lines.push(`${"  ".repeat(n.indent)}${text}`);
  };
  const context = (n: Node): void => {
    if (n.parent && !shown.has(n.parent)) context(n.parent);
    if (!shown.has(n)) show(n, n.line);
  };
  const subtree = (n: Node): void => {
    n.children.forEach((c) => {
      show(c, c.line);
      subtree(c);
    });
  };
  const walk = (n: Node): void => {
    const ref = n.ref === undefined ? undefined : afterRef(n.ref);
    const was = ref === undefined ? undefined : old.get(ref);
    if (n.ref !== undefined && was === undefined) {
      if (n.parent) context(n.parent);
      show(n, mark(n, "[new]"));
      subtree(n);
      added += 1 + countRefs(n);
      return; // its children are new too
    }
    if (n.ref !== undefined && was !== undefined && own(was) !== own(n)) {
      changed += 1;
      if (n.parent) context(n.parent);
      show(n, mark(n, "[changed]"));
      n.children.filter((c) => c.ref === undefined).forEach((c) => show(c, c.line));
    }
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  const gone = [...old.keys()].filter((ref) => !now.has(ref));
  if (gone.length > 0)
    lines.push(
      `Removed: ${gone.slice(0, REMOVED_LISTED).join(", ")}${gone.length > REMOVED_LISTED ? `, … and ${gone.length - REMOVED_LISTED} more` : ""}`,
    );
  return { text: lines.join("\n"), added, changed, removed: gone.length };
}

function snapshotNodes(snapshot: BrowserSnapshot): Node[] {
  const all: Node[] = [];
  const walk = (node: Node): void => {
    all.push(node);
    node.children.forEach(walk);
  };
  parse(snapshot.raw).forEach(walk);
  return all;
}

export interface SnapshotTarget {
  role: string;
  name: string;
}

const matchesTarget = (node: Node, target: SnapshotTarget): boolean =>
  node.role === target.role && node.name !== undefined && unquote(`"${node.name}"`) === target.name;

export function uniqueSnapshotTarget(before: BrowserSnapshot, ref: string): SnapshotTarget | undefined {
  const prior = snapshotNodes(before);
  const source = prior.find((node) => node.ref !== undefined && snapshotRef(before, node.ref) === ref);
  if (!source?.name) return undefined;
  const target = { role: source.role, name: unquote(`"${source.name}"`) };
  return prior.filter((node) => matchesTarget(node, target)).length === 1 ? target : undefined;
}

export function replacementRef(after: BrowserSnapshot, target: SnapshotTarget, ref: string): string | undefined {
  const [match, duplicate] = snapshotNodes(after).filter((node) => matchesTarget(node, target));
  if (!match?.ref || duplicate) return undefined;
  const next = snapshotRef(after, match.ref);
  if (!next || next === ref || REF.exec(next)?.[1] !== REF.exec(ref)?.[1]) return undefined;
  return next;
}

function countRefs(n: Node): number {
  return n.children.reduce((sum, c) => sum + (c.ref !== undefined ? 1 : 0) + countRefs(c), 0);
}

// ---- text: the page to read, with refs only on what can be acted on ------------------------------------------------

const URL_CHARS = 120;
const FIELDS = new Set([
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
]);
// Lines whose children read as one line: a list entry, a table row, a paragraph with links in it.
const JOINED: Record<string, string> = { listitem: " ", row: " | ", paragraph: " ", cell: " " };

const unquote = (v: string): string => (/^"(?:[^"\\]|\\.)*"$/.test(v) ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v);
const refTag = (n: Node): string => (n.ref !== undefined && canAct(n) ? ` [ref=${n.ref}]` : "");
const clipUrl = (u: string): string => (u.length > URL_CHARS ? `${u.slice(0, URL_CHARS - 1)}…` : u);

function readable(n: Node): string[] {
  const raw = n.name ?? (n.inline !== "" ? unquote(n.inline) : undefined);
  const label = raw?.trim() ? raw.trim() : undefined;
  const kids = (): string[] => n.children.flatMap(readable);
  switch (n.role) {
    case "text":
      return label ? [label] : [];
    case "/url":
      return [];
    case "img":
    case "image":
      return n.name ? [`[Image: ${n.name}]`] : [];
    case "heading": {
      const level = Number(/\[level=(\d)\]/.exec(n.attrs)?.[1] ?? 2);
      const text = label ?? kids().join(" ");
      return text ? [`${"#".repeat(Math.min(6, Math.max(1, level)))} ${text}`] : [];
    }
    case "link": {
      const url = n.children.find((c) => c.role === "/url")?.inline;
      const text = (label ?? kids().join(" ")).trim();
      const href = url === undefined ? undefined : unquote(url).trim();
      // A link with no text that goes nowhere (#, javascript:) tells a reader nothing.
      if (!text && (!href || href === "#" || /^javascript:/i.test(href))) return [];
      return [`${href ? `[${text || "link"}](${clipUrl(href)})` : text}${refTag(n)}`];
    }
    case "option":
      return label ? [`option "${label}"${n.attrs.includes("[selected]") ? " (selected)" : ""}`] : [];
  }
  if (FIELDS.has(n.role)) {
    const state = n.attrs.includes("[checked]") ? " (checked)" : "";
    return [`${n.role}${label ? ` "${label}"` : ""}${state}${refTag(n)}`, ...kids().map((l) => `  ${l}`)];
  }
  if (n.role === "button") {
    const text = (label ?? kids().join(" ")).trim();
    return [`[button${text ? `: ${text}` : ""}]${refTag(n)}`];
  }
  if (canAct(n) && label !== undefined) return [`[${label}]${refTag(n)}`];
  const inner = [
    ...(label !== undefined && !WRAPPERS.has(n.role) && n.name !== undefined ? [] : label ? [label] : []),
    ...kids(),
  ];
  const joiner = JOINED[n.role];
  if (joiner !== undefined && inner.length > 1 && inner.every((l) => !l.includes("\n") && l.length <= 200))
    return [`${n.role === "listitem" ? "- " : ""}${inner.join(joiner)}${refTag(n)}`];
  if (n.role === "listitem" && inner.length > 0) inner[0] = `- ${inner[0]}`;
  // A named landmark or region: its name, then its content.
  if (n.name !== undefined && !WRAPPERS.has(n.role)) return [n.name, ...inner];
  return inner;
}

/** The page as readable text: headings, prose, links as Markdown, and [ref=eN] only on what can be acted on. */
export function textView(raw: string): string {
  const lines = parse(raw).flatMap(readable);
  const out: string[] = [];
  for (const l of lines) if (l.trim() !== "" && l !== out[out.length - 1]) out.push(l);
  return out.join("\n");
}
