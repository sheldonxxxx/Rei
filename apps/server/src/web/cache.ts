// What web_fetch read from a page, and how a slice of it is shown to the model. Where pages are kept: documents.ts.
import type { ReadExtractor } from "@rei/protocol";
import { fenceWithId, originOf } from "./fence.ts";
import type { Section } from "./sections.ts";
import type { PageQuality } from "./types.ts";

export interface CachedPage {
  title: string;
  /** The URL after redirects. */
  url: string;
  text: string;
  /** What the page turned out to be and what read it (unset for pages made in tests). */
  quality?: PageQuality;
  extractor?: ReadExtractor;
  sections?: Section[];
  /** Ours, not the page's: where the text came from when it is not the page as shown. Told before the fence. */
  note?: string;
  /** "render": read from the page as the browser rendered it (ADR 0017); unset: fetched over HTTP. */
  method?: "http" | "render";
}

export const SLICE_CHARS = 20_000;

/** The page's header and the slice of its text from `offset` (fenced: it is the page's), then the footer that says where to go on. */
export function renderSlice(
  page: CachedPage,
  offset: number,
): { text: string; fenceId: string; truncated: boolean } | { error: string } {
  const total = page.text.length;
  if (offset > 0 && offset >= total)
    return { error: `offset ${offset} is past the end of the page (${total} characters).` };
  let end = Math.min(total, offset + SLICE_CHARS);
  if (end < total) {
    // Cut at a line break when there is one near the end, and never inside a surrogate pair.
    const nl = page.text.lastIndexOf("\n", end - 1);
    if (nl >= offset + SLICE_CHARS - 2_000) end = nl + 1;
    const code = page.text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  const body = page.text.slice(offset, end);
  const footer =
    end < total
      ? `\n\n[Showing characters ${offset}–${end} of ${total}. Call web_fetch again with offset=${end} for more.]`
      : "";
  const lead = page.note && offset === 0 ? `[${page.note}]\n\n` : "";
  const fenced = fenceWithId(`# ${page.title}\n${page.url}\n\n${body.trimEnd()}`, originOf(page.url));
  return { text: `${lead}${fenced.text}${footer}`, fenceId: fenced.id, truncated: end < total };
}
