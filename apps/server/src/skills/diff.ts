// A small line diff (longest common subsequence) in the unified format, for the card of a skill's new version.
export const DIFF_MAX_LINES = 400;
const CONTEXT = 3;

type Op = { t: " " | "-" | "+"; text: string };

function ops(a: string[], b: string[]): Op[] {
  // Common ends first: most edits are in the middle, and it keeps the table small.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const out: Op[] = a.slice(0, head).map((text) => ({ t: " ", text }));
  if (x.length * y.length > 4_000_000) {
    // Too big to compare line by line: show the middle as replaced.
    for (const text of x) out.push({ t: "-", text });
    for (const text of y) out.push({ t: "+", text });
  } else {
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i * w + j] =
          x[i] === y[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        out.push({ t: " ", text: x[i]! });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) out.push({ t: "-", text: x[i++]! });
      else out.push({ t: "+", text: y[j++]! });
    }
    while (i < x.length) out.push({ t: "-", text: x[i++]! });
    while (j < y.length) out.push({ t: "+", text: y[j++]! });
  }
  for (const text of a.slice(a.length - tail)) out.push({ t: " ", text });
  return out;
}

/** "--- from", "+++ to" and hunks of changed lines with three lines of context; cut at 400 lines. Empty when nothing changed. */
export function unifiedDiff(before: string, after: string, from: string, to: string): string {
  if (before === after) return "";
  const all = ops(before.split("\n"), after.split("\n"));
  const lines: string[] = [`--- ${from}`, `+++ ${to}`];
  // Where each op sits in the old and the new text (1-based line numbers).
  const at = all.map(() => [0, 0] as [number, number]);
  let a = 1;
  let b = 1;
  all.forEach((op, k) => {
    at[k] = [a, b];
    if (op.t !== "+") a++;
    if (op.t !== "-") b++;
  });
  const changed = all.map((o, k) => (o.t === " " ? -1 : k)).filter((k) => k >= 0);
  let k = 0;
  while (k < changed.length) {
    let start = Math.max(0, changed[k]! - CONTEXT);
    let end = Math.min(all.length, changed[k]! + CONTEXT + 1);
    // Changes close together share a hunk.
    while (k + 1 < changed.length && changed[k + 1]! - CONTEXT <= end) {
      k++;
      end = Math.min(all.length, changed[k]! + CONTEXT + 1);
    }
    k++;
    start = Math.min(start, end);
    const slice = all.slice(start, end);
    const oldCount = slice.filter((o) => o.t !== "+").length;
    const newCount = slice.filter((o) => o.t !== "-").length;
    lines.push(
      `@@ -${oldCount === 0 ? at[start]![0] - 1 : at[start]![0]},${oldCount} +${newCount === 0 ? at[start]![1] - 1 : at[start]![1]},${newCount} @@`,
    );
    for (const o of slice) lines.push(`${o.t}${o.text}`);
  }
  if (lines.length > DIFF_MAX_LINES)
    return `${lines.slice(0, DIFF_MAX_LINES).join("\n")}\n… (${lines.length - DIFF_MAX_LINES} more lines not shown)`;
  return lines.join("\n");
}
