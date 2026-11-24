/** Cursors are decimal strings of a per-stream increasing integer. True when `incoming` is not newer than `current`. */
export function isStale(current: string | null, incoming: string | undefined): boolean {
  if (current === null || incoming === undefined || incoming === "") return false;
  try {
    return BigInt(incoming) <= BigInt(current);
  } catch {
    return false;
  }
}
