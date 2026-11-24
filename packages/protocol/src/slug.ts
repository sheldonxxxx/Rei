// Section anchors for knowledge pages (docs/rendering.md, "Section links"). A heading's slug is GitHub's: the heading's
// text, lowercased, without punctuation except `-` and `_`, spaces as `-`. Letters of every script stay, so Chinese and
// Japanese headings get readable anchors. A repeated slug gets `-1`, `-2`, … in document order. The server (section
// lookup, link checks) and every client (heading ids, scrolling) use these functions, so they always agree; the
// conformance fixtures pin them down.

/** The text a reader sees in a heading's Markdown: link and image text without the target, code without backticks. */
function headingText(markdown: string): string {
  return (
    markdown
      .replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, "$1")
      .replace(/!?\[([^[\]\n]*)\]\([^()\n]*\)/g, "$1")
      .replace(/`+/g, "")
      // Emphasis underscores at a word's edge go; snake_case keeps its underscores.
      .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1")
  );
}

/** The base slug of one heading, before duplicates are numbered. */
export function headingSlug(markdown: string): string {
  return headingText(markdown)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** The slugs of a page's headings, in document order, with repeats numbered (`notes`, `notes-1`, `notes-2`). */
export function headingSlugs(headings: readonly string[]): string[] {
  const seen = new Map<string, number>();
  const taken = new Set<string>();
  return headings.map((h) => {
    const base = headingSlug(h);
    let slug = base;
    let n = seen.get(base) ?? 0;
    if (taken.has(slug))
      do slug = `${base}-${++n}`;
      while (taken.has(slug));
    seen.set(base, n);
    taken.add(slug);
    return slug;
  });
}

/** The anchor as a link carries it: percent-escapes decoded. Empty when there is none. */
export function linkAnchor(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Which heading an anchor names: its index in `slugs`, or -1. Matching ignores case, so `#Week-2` finds `week-2`. */
export function findSlug(slugs: readonly string[], anchor: string): number {
  const a = linkAnchor(anchor).replace(/^#/, "");
  if (a === "") return -1;
  const exact = slugs.indexOf(a);
  return exact >= 0 ? exact : slugs.indexOf(a.toLowerCase());
}
