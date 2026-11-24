// Content boundaries (prompt-injection defence): text a page controls reaches the model between two markers that carry
// an id. A page cannot forge the end marker because the id is never one that appears in the text, and the
// untrusted_content section of the system prompt says everything between the markers is data, never an instruction.
// Web Crypto, not node:crypto: this runs in the portable core.
export const newFenceId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Ids for a fence that must render the same text every time, such as one inside a prompt section (a fresh random id
 * per render would change the prompt and break the prompt cache): FNV-1a of a counter and the body. The ids are
 * predictable, which is fine: `fenceAs` skips every id that appears in the body, and that alone keeps the end marker
 * unforgeable.
 */
export function stableFenceIds(body: string): () => string {
  let n = 0;
  return () => {
    const text = `${n++}\n${body}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
}

/** The host of an http(s) address, lower case; null for anything else. */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** `fenceAs`, with the id it chose, for a caller that reports the id (web_fetch's structured result). */
export function fenceAsWithId(
  kind: string,
  body: string,
  nextId: () => string,
  attributes = "",
): { text: string; id: string } {
  let id = nextId();
  while (body.includes(id)) id = nextId();
  return { text: `<<<${kind} id=${id}${attributes}>>>\n${body}\n<<<end ${kind} id=${id}>>>`, id };
}

/** `body` between `<<<kind id=X …>>>` and `<<<end kind id=X>>>`. X comes from `nextId` and never appears in the body. */
export function fenceAs(kind: string, body: string, nextId: () => string, attributes = ""): string {
  return fenceAsWithId(kind, body, nextId, attributes).text;
}

/** `fence`, with the id it chose. */
export function fenceWithId(
  body: string,
  origin: string | null,
  nextId: () => string = newFenceId,
): { text: string; id: string } {
  return fenceAsWithId("page-content", body, nextId, origin ? ` origin=${origin}` : "");
}

/** `body` between the page-content markers. The id is fresh per call and is never one that appears in the text. */
export function fence(body: string, origin: string | null, nextId: () => string = newFenceId): string {
  return fenceWithId(body, origin, nextId).text;
}
