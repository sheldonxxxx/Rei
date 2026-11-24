// The page-content markers around page text, taken apart: what came before them, what is inside, and what came after.
export function unfence(text: string): {
  id: string;
  origin: string | null;
  lead: string;
  body: string;
  footer: string;
} {
  const m =
    /^([\s\S]*?)<<<page-content id=([0-9a-f]{8})(?: origin=(\S+))?>>>\n([\s\S]*)\n<<<end page-content id=\2>>>([\s\S]*)$/.exec(
      text,
    );
  if (!m) throw new Error(`no page-content fence in:\n${text}`);
  return { id: m[2]!, origin: m[3] ?? null, lead: m[1]!, body: m[4]!, footer: m[5]! };
}
