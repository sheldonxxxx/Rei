import type { SearchAttemptSummary } from "@rei/protocol";
// What the web tools share: the quality of a page and the error the model reads (ADR 0020).

/**
 * What a fetched page turned out to be. `success`: a page to read. `low_quality`: only part of it could be read (a
 * summary, or text embedded for scripts). `requires_js`: an app shell with nothing to read without JavaScript.
 * `blocked`: a bot check, a sign-in wall, or HTTP 401/403/429; never a reason to try another way in.
 * `unsupported_mime`: not text (a PDF, an image).
 */
export type PageQuality = "success" | "low_quality" | "requires_js" | "blocked" | "unsupported_mime";

/** An error whose message is meant for the model as it stands (no URLs with queries, no tokens). */
export class WebError extends Error {
  /** Provider attempts reported by the gateway for a failed search; empty when none were. */
  attempts: SearchAttemptSummary[] = [];
  /** For a fetch: what the page turned out to be, when that is why there is nothing to read. */
  readonly quality: PageQuality | undefined;
  constructor(message: string, quality?: PageQuality) {
    super(message);
    this.name = "WebError";
    this.quality = quality;
  }
}
