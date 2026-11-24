export type Segment = { type: "text"; text: string } | { type: "link"; text: string; href: string };

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?)\]}'"»”’]+$/;

/** Splits plain text into text and http(s) link segments. The result is rendered as React text nodes, never as HTML. */
export function linkify(input: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of input.matchAll(URL_RE)) {
    let url = m[0];
    const start = m.index ?? 0;
    // Keep a closing paren that balances one inside the URL (wikipedia links).
    let trimmed = url.replace(TRAILING, "");
    if (url.endsWith(")") && (trimmed.match(/\(/g)?.length ?? 0) > (trimmed.match(/\)/g)?.length ?? 0)) {
      trimmed = trimmed + ")";
    }
    url = trimmed;
    if (url.length <= "https://".length) continue;
    if (start > last) out.push({ type: "text", text: input.slice(last, start) });
    out.push({ type: "link", text: url, href: url });
    last = start + url.length;
  }
  if (last < input.length) out.push({ type: "text", text: input.slice(last) });
  return out;
}
