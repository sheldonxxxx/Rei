// One line per check: `ok   <title>  <detail>`, and under a warn or fail an indented `-> <fix>` line.
import type { Out } from "./io.ts";

export type Status = "ok" | "warn" | "fail" | "skip";
export interface CheckResult {
  status: Status;
  detail: string;
  fix?: string | undefined;
}
export interface Row extends CheckResult {
  id: string;
  title: string;
}

const LABEL: Record<Status, string> = { ok: "ok", warn: "warn", fail: "FAIL", skip: "skip" };
const COLOR: Record<Status, string> = { ok: "32", warn: "33", fail: "31", skip: "2" };

export const row = (id: string, title: string, result: CheckResult): Row => ({ id, title, ...result });

export function printRow(out: Out, r: Row): void {
  const label = LABEL[r.status].padEnd(5);
  out.line(
    `${out.color ? `\x1b[${COLOR[r.status]}m${label}\x1b[0m` : label}${r.title.padEnd(24)}  ${r.detail}`.trimEnd(),
  );
  if (r.fix && (r.status === "warn" || r.status === "fail")) out.line(`     → ${r.fix}`);
}

/** First line of some command output, bounded: for details that quote a child's complaint. */
export const firstLine = (text: string, max = 160): string => (text.trim().split(/\r?\n/, 1)[0] ?? "").slice(0, max);

export const ok = (detail: string): CheckResult => ({ status: "ok", detail });
export const warn = (detail: string, fix?: string): CheckResult => ({ status: "warn", detail, fix });
export const fail = (detail: string, fix?: string): CheckResult => ({ status: "fail", detail, fix });
export const skip = (detail: string): CheckResult => ({ status: "skip", detail });
