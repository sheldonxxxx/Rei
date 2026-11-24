// The sections of a page's Markdown: one per ATX heading (headings inside fenced code do not count), plus "top" for the
// text before the first heading. Ids are slugs of the heading text, numbered when repeated, so the same page gives the same
// ids on every fetch and a section keeps its id when other sections change. Pure and portable.

export interface Section {
  /** Stable id: the heading's slug ("when-to-go", "when-to-go-2"), or "top" for the text before the first heading. */
  id: string;
  /** 1-6 for a heading, 0 for "top". */
  level: number;
  /** The heading text ("" for "top"). */
  heading: string;
  /** The headings above this one and this one, outermost first. */
  path: string[];
  /** Character offsets into the text: from the heading line to the next heading (of any level) or the end. */
  start: number;
  end: number;
}

export const TOP_SECTION = "top";
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** A heading as an id: lower case, Markdown links and emphasis reduced to their text, letters (any script), digits and hyphens. */
export function slug(heading: string): string {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export function sectionsOf(text: string): Section[] {
  const heads: { level: number; heading: string; start: number }[] = [];
  let fence: string | undefined;
  for (let at = 0; at < text.length; ) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(at, end);
    const open = FENCE.exec(line)?.[1];
    if (fence !== undefined) {
      if (open && open[0] === fence[0] && open.length >= fence.length && line.trim() === open) fence = undefined;
    } else if (open) {
      fence = open;
    } else {
      const m = HEADING.exec(line);
      if (m) heads.push({ level: m[1]!.length, heading: m[2]!, start: at });
    }
    at = end + 1;
  }

  const sections: Section[] = [];
  const firstStart = heads[0]?.start ?? text.length;
  if (text.slice(0, firstStart).trim() !== "")
    sections.push({ id: TOP_SECTION, level: 0, heading: "", path: [], start: 0, end: firstStart });

  const ids = new Set<string>([TOP_SECTION]);
  const stack: { level: number; heading: string }[] = [];
  heads.forEach((h, i) => {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push(h);
    const base = slug(h.heading) || "section";
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    sections.push({
      id,
      level: h.level,
      heading: h.heading,
      path: stack.map((s) => s.heading),
      start: h.start,
      end: heads[i + 1]?.start ?? text.length,
    });
  });
  return sections;
}
