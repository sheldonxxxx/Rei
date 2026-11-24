// The result of the last `probe-models` run: not secret, read by /status. Models are never probed automatically.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface ProbeResult {
  at: string;
  accepted: string[];
  rejected: { id: string; reason: string }[];
}

export function readProbe(file: string): ProbeResult | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ProbeResult;
    return Array.isArray(parsed.accepted) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeProbe(file: string, result: ProbeResult): void {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Cheap enough to call per /status request; re-reads when the file changes. */
export function modelsReader(file: string): () => string[] {
  return () => readProbe(file)?.accepted ?? [];
}
