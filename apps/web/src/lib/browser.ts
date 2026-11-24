import type { Takeover } from "@rei/protocol";

/** The host of a page for display ("example.com"), or null when there is no usable URL. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** A takeover that still needs attention from the app (pending or active). */
export const isOpenTakeover = (t: Pick<Takeover, "status">) => t.status === "pending" || t.status === "active";

/**
 * What you typed in the address field as an http(s) URL, or null when it isn't a web address. The server also refuses
 * anything but http(s); this only saves a round trip and gives a message.
 */
export function normalizeAddress(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/]+:\d+(\/|$)/.test(text); // "localhost:3000" is a host, not a scheme
  const candidate = hasScheme ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
    return url.href;
  } catch {
    return null;
  }
}
