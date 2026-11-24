// The same serialization is used for injection and validation. Budget estimates reserve the longest stale annotation,
// so passage of time cannot turn an accepted document into an over-budget prompt. Empty documents inject nothing.
import { MEMORY_STALE_DAYS, type MemoryDoc, type MemoryLine } from "@rei/protocol";
import { localDay } from "../util/time.ts";
import { estimateTokens } from "./text.ts";

export function formatMemoryDoc(
  doc: MemoryDoc,
  lines: readonly Pick<MemoryLine, "id" | "text" | "confirmedAt">[],
  now: number,
  budget = false,
): string {
  if (lines.length === 0) return "";
  const heading = doc === "profile" ? "About the user (profile.md):" : "Your notes (agent.md):";
  return [
    heading,
    ...lines.map((l) => {
      const days = Math.floor((now - l.confirmedAt) / 86_400_000);
      const stale = budget
        ? ", not confirmed for 999999999999 months"
        : days > MEMORY_STALE_DAYS
          ? `, not confirmed for ${Math.max(1, Math.floor(days / 30))} months`
          : "";
      return `- [${l.id}] ${l.text} (confirmed ${localDay(l.confirmedAt)}${stale})`;
    }),
  ].join("\n");
}

export function memoryDocTokens(
  doc: MemoryDoc,
  lines: readonly Pick<MemoryLine, "id" | "text" | "confirmedAt">[],
  now: number,
): number {
  const text = formatMemoryDoc(doc, lines, now, true);
  // Each nonempty scope conservatively pays the profile section's enclosing tags and separators.
  return text === "" ? 0 : estimateTokens(`<profile>\n${text}\n</profile>\n`);
}
