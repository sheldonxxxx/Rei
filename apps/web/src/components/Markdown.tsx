// biome-ignore-all lint/suspicious/noArrayIndexKey: the tree is re-parsed from text on every render and holds no state, so position is its identity.
import type { MouseEvent, ReactNode } from "react";
import { useEffect, useId, useMemo, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import type { Block, CalloutKind, Inline, TaskMark } from "../lib/markdown.ts";
import { type ImageEmbed, imageOnly, parseMarkdown, splitChips } from "../lib/markdown.ts";
import { useTheme } from "../lib/theme.tsx";
import { CitationChip } from "./CitationChip.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

/** What a Knowledge page knows about its links; without it, `page:` and `file:` links are plain links into Knowledge and the Library. */
export interface MarkdownRefs {
  /** A linked page's current title; null when the page is gone (trashed or deleted). */
  pageTitle?: (pageId: string) => string | null | undefined;
  file?: (
    fileId: string,
    versionId: string | null,
  ) =>
    | { name: string | null; available: boolean; contentVersionId: string | null; mediaType: string | null }
    | undefined;
  /** Ticks a task by its position on the page; without it checkboxes are read-only. */
  onTask?: (index: number, done: boolean) => void;
  /** Opens a Library file (a preview); without it, file links go to the Library. */
  openFile?: (fileId: string, versionId: string | null) => void;
}

/** The element id of a section's heading on a Knowledge page; the address's fragment is the bare slug. */
export const sectionElementId = (slug: string): string => `section-${slug}`;

/**
 * Markdown rendered as React elements (never as HTML). Chat replies shift headings down two levels (h1/h2 belong to the
 * page); a Knowledge page, whose title is the h1, shifts them by one. `sectionsOf` is the page this text is: its
 * headings get ids to scroll to and a button that copies a link to the section.
 */
export function Markdown({
  text,
  streaming = false,
  inlineCitations = false,
  refs,
  headingShift = 2,
  sectionsOf,
}: {
  text: string;
  streaming?: boolean;
  inlineCitations?: boolean;
  refs?: MarkdownRefs;
  headingShift?: number;
  sectionsOf?: string;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const last = blocks.at(-1);
  const notes = inlineCitations && last?.t === "footnotes" ? last.items : [];
  // Footnote anchors must be unique on a screen that shows many messages.
  const uid = useId().replace(/\W/g, "");
  const render = renderer(refs ?? {}, headingShift, sectionsOf, uid, notes);
  return <div className={`md${streaming ? " streaming" : ""}`}>{render.blocks(blocks)}</div>;
}

const CALLOUTS: Record<CalloutKind, { label: string; icon: IconName }> = {
  note: { label: "Note", icon: "info" },
  tip: { label: "Tip", icon: "sparkle" },
  important: { label: "Important", icon: "alert" },
  warning: { label: "Warning", icon: "alert" },
  caution: { label: "Caution", icon: "alert" },
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Scrolls to a footnote reference or note in the same message, without touching the address (a page's fragment is its section). */
const jumpTo = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  el.scrollIntoView({ block: "center" });
  el.focus({ preventScroll: true });
};

type Footnote = Extract<Block, { t: "footnotes" }>["items"][number];

const fileUrl = (fileId: string, versionId: string) =>
  `/api/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(versionId)}/content`;

function renderer(
  refs: MarkdownRefs,
  headingShift: number,
  sectionsOf: string | undefined,
  uid: string,
  inlineNotes: Footnote[],
) {
  const noteId = (n: number) => `fn-${uid}-${n}`;
  const refId = (n: number, use: number) => `fnref-${uid}-${n}-${use}`;

  type Shown = { node: ImageEmbed; name: string | null; src: string };

  /** A paragraph of nothing but Library images that can all be shown; otherwise null (it renders as text and links). */
  function figures(b: Block): Shown[] | null {
    const images = b.t === "p" ? imageOnly(b.children) : null;
    if (!images) return null;
    const shown: Shown[] = [];
    for (const node of images) {
      const f = refs.file?.(node.fileId, node.versionId);
      if (!f?.available || !f.contentVersionId || !f.mediaType?.startsWith("image/")) return null;
      shown.push({ node, name: f.name, src: fileUrl(node.fileId, f.contentVersionId) });
    }
    return shown;
  }

  /** Top-level blocks; images in neighbouring paragraphs share one gallery so they sit side by side. */
  function blocks(list: Block[]): ReactNode[] {
    const out: ReactNode[] = [];
    for (let i = 0; i < list.length; i++) {
      let run = figures(list[i]!);
      if (!run) {
        out.push(block(list[i]!, i, false));
        continue;
      }
      const key = i;
      for (let next = list[i + 1] && figures(list[i + 1]!); next; next = list[i + 1] && figures(list[i + 1]!)) {
        run = [...run, ...next];
        i++;
      }
      out.push(gallery(run, key));
    }
    return out;
  }

  function gallery(shown: Shown[], key: number): ReactNode {
    return (
      <div key={key} className={`md-gallery${shown.length > 1 ? " md-gallery-many" : ""}`}>
        {shown.map((s, i) => figure(s, i))}
      </div>
    );
  }

  /** An embedded Library image: the picture opens the preview, a corner button downloads it, the alt text is its caption. */
  function figure({ node, name, src }: Shown, key: number): ReactNode {
    const caption = node.alt.trim();
    const label = caption || name || "image";
    const img = <img className="md-image" src={src} alt={caption || name || ""} loading="lazy" />;
    return (
      <figure key={key} className="md-figure">
        {refs.openFile ? (
          <button
            type="button"
            className="md-figure-open"
            aria-label={`Preview ${label}`}
            onClick={() => refs.openFile!(node.fileId, node.versionId)}
          >
            {img}
          </button>
        ) : (
          <a
            className="md-figure-open"
            href={`/library/${encodeURIComponent(node.fileId)}`}
            aria-label={`Open ${label}`}
          >
            {img}
          </a>
        )}
        <a
          className="md-figure-download"
          href={src}
          download={name ?? ""}
          aria-label={`Download ${label}`}
          title="Download"
        >
          <Icon name="download" size={16} />
        </a>
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
    );
  }

  function block(b: Block, key: number, chips: boolean): ReactNode {
    switch (b.t) {
      case "p": {
        const shown = figures(b);
        if (shown) return gallery(shown, key);
        return <p key={key}>{inlines(b.children, chips)}</p>;
      }
      case "h": {
        const Tag = `h${Math.min(6, b.level + headingShift)}` as "h2" | "h3" | "h4" | "h5" | "h6";
        const slug = sectionsOf && b.slug ? b.slug : null;
        return (
          <Tag key={key} id={slug ? sectionElementId(slug) : undefined} className={`md-h md-h${b.level}`}>
            {inlines(b.children, chips)}
            {slug && (
              <span className="md-h-link">
                <CopyButton
                  text={`[${inlineText(b.children).replace(/[[\]\\]/g, "\\$&")}](page:${sectionsOf}#${slug})`}
                  label="Copy section link"
                />
              </span>
            )}
          </Tag>
        );
      }
      case "code":
        return b.lang === "mermaid" && !b.open ? (
          <MermaidBlock key={key} text={b.text} />
        ) : (
          <CodeBlock key={key} lang={b.lang} text={b.text} />
        );
      case "quote":
        return <blockquote key={key}>{b.blocks.map((x, i) => block(x, i, chips))}</blockquote>;
      case "callout": {
        const meta = CALLOUTS[b.kind];
        const title = b.title.length > 0 ? inlines(b.title, chips) : meta.label;
        const body = b.blocks.map((x, i) => block(x, i, chips));
        const head = (
          <>
            <Icon name={meta.icon} size={16} />
            <span>{title}</span>
          </>
        );
        if (b.fold)
          return (
            <details key={key} className={`md-callout md-callout-${b.kind}`} open={b.fold === "open"}>
              <summary className="md-callout-title">{head}</summary>
              <div className="md-callout-body">{body}</div>
            </details>
          );
        return (
          <div key={key} className={`md-callout md-callout-${b.kind}`} role="note">
            <div className="md-callout-title">{head}</div>
            {body.length > 0 && <div className="md-callout-body">{body}</div>}
          </div>
        );
      }
      case "list": {
        const items = b.items.map((item, i) => {
          const task = b.tasks?.[i];
          if (!task) return <li key={i}>{item.map((x, j) => block(x, j, chips))}</li>;
          return (
            <li key={i} className={`md-task${task.done ? " done" : ""}`}>
              <TaskBox task={task} onTask={refs.onTask} label={plain(item)} />
              <div className="md-task-body">{item.map((x, j) => block(x, j, true))}</div>
            </li>
          );
        });
        const cls = b.tasks ? "md-tasks" : undefined;
        return b.ordered ? (
          <ol key={key} className={cls} start={b.start === 1 ? undefined : b.start}>
            {items}
          </ol>
        ) : (
          <ul key={key} className={cls}>
            {items}
          </ul>
        );
      }
      case "table":
        return (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable table must be reachable by keyboard to scroll.
          <section key={key} className="md-table" tabIndex={0} aria-label="Table">
            <table>
              <thead>
                <tr>
                  {b.head.map((cell, c) => (
                    <th key={c} style={b.align[c] ? { textAlign: b.align[c]! } : undefined}>
                      {inlines(cell, chips)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} style={b.align[c] ? { textAlign: b.align[c]! } : undefined}>
                        {inlines(cell, chips)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      case "hr":
        return <hr key={key} />;
      case "footnotes": {
        if (inlineNotes.length) {
          const unused = b.items.filter((item) => item.uses === 0);
          return unused.length ? (
            <p key={key}>
              {citation(
                unused.flatMap((item) => item.blocks),
                0,
                "Notes",
              )}
            </p>
          ) : null;
        }
        return (
          <section key={key} className="md-footnotes" aria-label="Notes">
            <ol className="md-fn-list">
              {b.items.map((item) => {
                const back = Array.from({ length: item.uses }, (_, k) => (
                  <a
                    key={k}
                    className="md-fn-back"
                    href={`#${refId(item.n, k + 1)}`}
                    onClick={jumpTo(refId(item.n, k + 1))}
                    aria-label={item.uses > 1 ? `Back to reference ${k + 1}` : "Back to reference"}
                  >
                    {k === 0 ? "↩" : `↩${k + 1}`}
                  </a>
                ));
                const last = item.blocks[item.blocks.length - 1];
                const head = last?.t === "p" ? item.blocks.slice(0, -1) : item.blocks;
                return (
                  <li key={item.n} id={noteId(item.n)} className="md-fn" tabIndex={-1}>
                    {head.map((x, j) => block(x, j, false))}
                    {last?.t === "p" ? (
                      <p>
                        {inlines(last.children, false)} {back}
                      </p>
                    ) : (
                      back.length > 0 && <p>{back}</p>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      }
    }
  }

  function text(value: string, chips: boolean, key: number): ReactNode {
    if (!chips) return value;
    const parts = splitChips(value);
    if (parts.every((p) => p.t === "text")) return value;
    return parts.map((part, i) => {
      if (part.t === "text") return part.text;
      if (part.t === "mention")
        return (
          <span key={`${key}-${i}`} className="md-chip md-chip-agent">
            @{part.name}
          </span>
        );
      const overdue = part.date < today();
      return (
        <span
          key={`${key}-${i}`}
          className={`md-chip md-chip-date${overdue ? " overdue" : ""}`}
          title={overdue ? "Past due" : undefined}
        >
          <Icon name="clock" size={12} />
          {part.date}
        </span>
      );
    });
  }

  function inlines(nodes: Inline[], chips: boolean): ReactNode[] {
    return nodes.map((node, i) => {
      switch (node.t) {
        case "text":
          return text(node.text, chips, i);
        case "br":
          return <br key={i} />;
        case "fnref": {
          const note = inlineNotes[node.n - 1];
          if (note) return citation(note.blocks, i);
          return (
            <sup key={i} className="md-fnref">
              <a
                id={refId(node.n, node.use)}
                href={`#${noteId(node.n)}`}
                onClick={jumpTo(noteId(node.n))}
                aria-label={`Note ${node.n}`}
              >
                {node.n}
              </a>
            </sup>
          );
        }
        case "code":
          return <code key={i}>{node.text}</code>;
        case "strong":
          return <strong key={i}>{inlines(node.children, chips)}</strong>;
        case "em":
          return <em key={i}>{inlines(node.children, chips)}</em>;
        case "del":
          return <del key={i}>{inlines(node.children, chips)}</del>;
        case "link":
          return (
            <a key={i} href={node.href} target="_blank" rel="noopener noreferrer nofollow">
              {inlines(node.children, chips)}
            </a>
          );
        case "page": {
          const title = refs.pageTitle?.(node.pageId);
          if (title === null)
            return (
              <span key={i} className="md-ref md-ref-gone" title="This page was moved to Trash or deleted">
                <Icon name="file" size={14} />
                {inlines(node.children, false)}
              </span>
            );
          const label = node.children.length > 0 ? inlines(node.children, false) : (title ?? "Untitled page");
          return (
            <a
              key={i}
              className="md-ref"
              href={`/knowledge/${encodeURIComponent(node.pageId)}${node.anchor ? `#${encodeURIComponent(node.anchor)}` : ""}`}
              title={title ?? undefined}
            >
              <Icon name="file" size={14} />
              {label}
            </a>
          );
        }
        case "file":
          return fileLink(i, node.fileId, node.versionId, inlines(node.children, false));
        case "image": {
          const f = refs.file?.(node.fileId, node.versionId);
          if (f?.available && f.contentVersionId && f.mediaType?.startsWith("image/"))
            return (
              <img
                key={i}
                className="md-image"
                src={fileUrl(node.fileId, f.contentVersionId)}
                alt={node.alt || f.name || ""}
                loading="lazy"
              />
            );
          return fileLink(i, node.fileId, node.versionId, node.alt || null);
        }
        case "webimage":
          return <WebImage key={i} src={node.src} alt={node.alt} />;
        default:
          return null;
      }
    });
  }

  function fileLink(key: number, fileId: string, versionId: string | null, label: ReactNode): ReactNode {
    const f = refs.file?.(fileId, versionId);
    const shown = (Array.isArray(label) ? label.length > 0 : !!label) ? label : (f?.name ?? "File");
    if (f && !f.available)
      return (
        <span key={key} className="md-ref md-ref-gone" title="This file was deleted from the Library">
          <Icon name="file" size={14} />
          {shown} <span className="md-ref-note">File removed</span>
        </span>
      );
    const version = versionId ? <span className="md-ref-note">pinned version</span> : null;
    if (refs.openFile)
      return (
        <button key={key} type="button" className="md-ref" onClick={() => refs.openFile!(fileId, versionId)}>
          <Icon name="file" size={14} />
          {shown}
          {version}
        </button>
      );
    return (
      <a key={key} className="md-ref" href={`/library/${encodeURIComponent(fileId)}`}>
        <Icon name="file" size={14} />
        {shown}
        {version}
      </a>
    );
  }

  function citation(blocks: Block[], key: number, label?: string): ReactNode {
    const sources = new Map<string, CitationSource>();
    const sourceNodes = new Set<Inline>();
    for (const link of noteBlockLinks(blocks)) {
      const source = describeSource(link, refs);
      if (!source) continue;
      sourceNodes.add(link);
      if (!sources.has(source.id)) sources.set(source.id, source);
    }
    const entries = [...sources.values()];
    const details = blocks.filter((entry) => !sourceOnlyBlock(entry, sourceNodes));
    return (
      <CitationChip
        key={key}
        label={label ?? entries[0]?.label ?? "Note"}
        more={label ? 0 : Math.max(0, entries.length - 1)}
      >
        {entries.length > 0 && (
          <div className="md-citation-sources">
            {entries.map(({ id, label, node }) => {
              const href = node.t === "link" ? node.href : node.t === "webimage" ? node.src : null;
              const title =
                node.t === "link" ? inlineText(node.children).trim() : node.t === "webimage" ? node.alt.trim() : label;
              return (
                <div key={id} className="md-citation-source">
                  {href !== null ? (
                    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                      <span>{title && title !== href ? title : label}</span>
                      <span className="md-citation-url">{href}</span>
                    </a>
                  ) : node.t === "page" ? (
                    inlines([node], false)
                  ) : node.t === "file" || node.t === "image" ? (
                    fileLink(0, node.fileId, node.versionId, label)
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {details.length > 0 && (
          <div className="md md-citation-details">{details.map((entry, i) => block(entry, i, false))}</div>
        )}
      </CitationChip>
    );
  }

  return { block, blocks };
}

type NoteLink = Extract<Inline, { t: "link" | "file" | "page" | "image" | "webimage" }>;
type CitationSource = { id: string; label: string; node: NoteLink };

function describeSource(node: NoteLink, refs: MarkdownRefs): CitationSource | null {
  const title = node.t === "image" || node.t === "webimage" ? node.alt : inlineText(node.children).trim();
  switch (node.t) {
    case "link":
    case "webimage": {
      const url = URL.parse(node.t === "link" ? node.href : node.src);
      if (!url) return null;
      const label = url.hostname.replace(/^www\./i, "") || title || url.pathname;
      return { id: url.href, label, node };
    }
    case "page":
      return {
        id: `page:${node.pageId}#${node.anchor ?? ""}`,
        label: refs.pageTitle?.(node.pageId) || title || "Knowledge page",
        node,
      };
    case "file":
    case "image":
      return {
        id: `file:${node.fileId}@${node.versionId ?? ""}`,
        label: refs.file?.(node.fileId, node.versionId)?.name || title || "File",
        node,
      };
  }
}

function noteLinks(nodes: Inline[]): NoteLink[] {
  return nodes.flatMap((node) => {
    if (node.t === "link" || node.t === "file" || node.t === "page" || node.t === "image" || node.t === "webimage")
      return [node];
    return "children" in node ? noteLinks(node.children) : [];
  });
}

function noteBlockLinks(blocks: Block[]): NoteLink[] {
  return blocks.flatMap((block) => {
    switch (block.t) {
      case "p":
      case "h":
        return noteLinks(block.children);
      case "quote":
        return noteBlockLinks(block.blocks);
      case "callout":
        return [...noteLinks(block.title), ...noteBlockLinks(block.blocks)];
      case "list":
        return block.items.flatMap(noteBlockLinks);
      case "table":
        return [...block.head, ...block.rows.flat()].flatMap(noteLinks);
      default:
        return [];
    }
  });
}

/** Drop bare source lines from the detail because the card already shows their links above it. */
function sourceOnlyBlock(block: Block, sources: ReadonlySet<Inline>): boolean {
  if (block.t === "list") {
    return !block.tasks && block.items.every((item) => item.every((part) => sourceOnlyBlock(part, sources)));
  }
  return block.t === "p" && noteLinks(block.children).length > 0 && sourceOnlyInlines(block.children, sources);
}

function sourceOnlyInlines(nodes: Inline[], sources: ReadonlySet<Inline>): boolean {
  return nodes.every((node) => {
    if (node.t === "br") return true;
    if (node.t === "text") return /^[\s\p{P}]*$/u.test(node.text);
    if (node.t === "strong" || node.t === "em" || node.t === "del") return sourceOnlyInlines(node.children, sources);
    return node.t !== "image" && node.t !== "webimage" && sources.has(node);
  });
}

/**
 * An image from the web, loaded lazily and without a referrer. If it cannot be loaded, its alt text (or its address)
 * becomes an ordinary link to it.
 */
function WebImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  // A different image in the same place gets its own chance to load.
  const [shown, setShown] = useState(src);
  if (shown !== src) {
    setShown(src);
    setFailed(false);
  }
  if (failed)
    return (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow">
        {alt || src}
      </a>
    );
  return (
    <img
      className="md-image"
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function TaskBox({
  task,
  onTask,
  label,
}: {
  task: TaskMark;
  onTask: ((index: number, done: boolean) => void) | undefined;
  label: string;
}) {
  const index = task.index;
  const editable = !!onTask && index !== null;
  return (
    <input
      type="checkbox"
      className="md-task-box"
      checked={task.done}
      disabled={!editable}
      aria-label={label ? `Task: ${label}` : "Task"}
      onChange={(e) => {
        if (editable) onTask(index, e.currentTarget.checked);
      }}
    />
  );
}

/** The text a reader sees in a run of inlines. */
function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) =>
      n.t === "text" || n.t === "code"
        ? n.text
        : n.t === "br" || n.t === "image" || n.t === "webimage"
          ? " "
          : "children" in n
            ? inlineText(n.children)
            : "",
    )
    .join("");
}

/** A task's text for its checkbox's label. */
function plain(blocks: Block[]): string {
  const first = blocks[0];
  if (first?.t !== "p") return "";
  return inlineText(first.children).trim().slice(0, 120);
}

type Highlighter = typeof import("highlight.js/lib/common")["default"];
let highlighter: Highlighter | null = null;
let loading: Promise<void> | null = null;

/** Loads highlight.js once; resolves when it is ready to colour synchronously. */
function loadHighlighter(): Promise<void> {
  loading ??= import("highlight.js/lib/common").then(
    (m) => {
      highlighter = m.default;
    },
    () => {
      loading = null;
    },
  );
  return loading;
}

/**
 * Code coloured by highlight.js (loaded on first use, common languages only); an unknown or empty language stays plain.
 * Once the library is loaded, colour is computed in the same render as the text, so a block that grows while a reply
 * streams never drops back to plain text and re-colours on every update (a flicker that also reflows the block).
 */
export function CodeBlock({
  lang,
  text,
  note,
  lineNumbers = false,
}: {
  lang: string;
  text: string;
  note?: string;
  /** Number the lines in a gutter that is not part of the copied text. */
  lineNumbers?: boolean;
}) {
  const [ready, loaded] = useState(highlighter !== null);
  const language = lang.toLowerCase();
  useEffect(() => {
    if (!language || highlighter) return;
    let cancelled = false;
    void loadHighlighter().then(() => {
      if (!cancelled) loaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [language]);
  const html = useMemo(
    () =>
      ready && highlighter?.getLanguage(language)
        ? highlighter.highlight(text, { language, ignoreIllegals: true }).value
        : null,
    [ready, language, text],
  );

  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || "code"}</span>
        <CopyButton text={text} label="Copy code" compact />
      </div>
      {note && (
        <p className="code-note" role="status">
          {note}
        </p>
      )}
      <pre className={lineNumbers ? "code-numbered" : undefined}>
        {lineNumbers && (
          <span className="code-gutter" aria-hidden="true">
            {Array.from({ length: text.replace(/\n$/, "").split("\n").length }, (_, i) => i + 1).join("\n")}
          </span>
        )}
        {html === null ? (
          <code>{text}</code>
        ) : (
          // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js escapes the source and emits only <span class="hljs-*">.
          <code dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
    </div>
  );
}

type MermaidState = { kind: "pending" } | { kind: "svg"; svg: string } | { kind: "error"; message: string };

/**
 * A closed `mermaid` fence drawn as a diagram. Mermaid is loaded on first use, in strict mode with plain-text labels (the
 * dialect never interprets HTML). A syntax error shows the code with a note, never an empty area; the source is one click
 * away (and copyable) beside the diagram.
 */
function MermaidBlock({ text }: { text: string }) {
  const { scheme } = useTheme();
  const id = `mmd${useId().replace(/\W/g, "")}`;
  const [state, setState] = useState<MermaidState>({ kind: "pending" });
  const [source, setSource] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "pending" });
    void (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        if (cancelled) return;
        const styles = getComputedStyle(document.documentElement);
        const token = (name: string) => styles.getPropertyValue(`--${name}`).trim();
        const foreground = token("foreground");
        const border = token("control-border");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          suppressErrorRendering: true,
          theme: "base",
          themeVariables: {
            darkMode: scheme === "dark",
            fontFamily: token("sans"),
            background: token("card"),
            primaryColor: token("accent"),
            secondaryColor: token("sidebar"),
            tertiaryColor: token("muted"),
            primaryTextColor: foreground,
            secondaryTextColor: foreground,
            tertiaryTextColor: foreground,
            primaryBorderColor: border,
            secondaryBorderColor: border,
            tertiaryBorderColor: border,
            lineColor: token("supporting-text"),
            edgeLabelBackground: token("card"),
          },
        });
        const { svg } = await mermaid.render(id, text);
        if (!cancelled) setState({ kind: "svg", svg });
      } catch (e) {
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled)
          setState({ kind: "error", message: e instanceof Error ? e.message : "Could not draw this diagram." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text, scheme, id]);

  if (state.kind === "error")
    return <CodeBlock lang="mermaid" text={text} note="This diagram has a syntax error, so its source is shown." />;
  if (state.kind === "pending") return <CodeBlock lang="mermaid" text={text} />;
  return (
    <div className="code-block mermaid-block">
      <div className="code-head">
        <span>mermaid</span>
        <span className="code-actions">
          <Tip label={source ? "Show diagram" : "Show source"}>
            <Button
              type="button"
              variant={source ? "secondary" : "ghost"}
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={source ? "Show diagram" : "Show source"}
              aria-pressed={source}
              onClick={() => setSource((v) => !v)}
            >
              <Icon name="code" size={16} />
            </Button>
          </Tip>
          <CopyButton text={text} label="Copy code" />
        </span>
      </div>
      {source ? (
        <pre>
          <code>{text}</code>
        </pre>
      ) : (
        <div
          className="mermaid-diagram"
          data-enter="fade"
          role="img"
          aria-label="Diagram"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid's strict security level sanitizes the SVG it returns.
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}
    </div>
  );
}
