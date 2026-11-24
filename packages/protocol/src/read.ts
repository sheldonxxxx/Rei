// The shared reader's wire contract: POST /read on the gateway, which hands it to the reader (docs/gateway-callers.md,
// docs/reader.md). One read of one URL. The caller owns the destination policy: it names the hosts it allowed, and the
// reader answers a redirect to any other host with `outcome: "redirect"` instead of following it.

/** What a page turned out to be (the extractor's judgement). */
export type ReadQuality = "success" | "low_quality" | "requires_js" | "blocked" | "unsupported_mime";

/** What produced the text: Readability, the whole body, a text/JSON body, data the page embeds, or nothing. */
export type ReadExtractor =
  | "readability"
  | "body"
  | "text"
  | "json"
  | "json-ld"
  | "next-data"
  | "nuxt-data"
  | "meta"
  | "none";

/** A section of the page's Markdown: character offsets into `text`, from its heading to the next heading. */
export interface ReadSection {
  /** Stable id: the heading's slug ("when-to-go", "when-to-go-2"), or "top" for the text before the first heading. */
  id: string;
  /** 1-6 for a heading, 0 for "top". */
  level: number;
  heading: string;
  /** The headings above this one and this one, outermost first. */
  path: string[];
  start: number;
  end: number;
}

/** Which local-network addresses a read may reach: "all", "none", or the IP addresses and networks that name them. */
export type ReadLocalNetworks = "all" | "none" | string[];

/** The engines that render, and the order they are tried in (READER_ENGINES). */
export type ReadEngine = "moli" | "chromium";

export interface ReadRequest {
  /** http or https, ports 80 and 443 only, at most 2,000 characters. */
  url: string;
  /** Hosts the caller's policy already allowed; the start host at least. A redirect to any other host is handed back. */
  allowHosts: string[];
  /** auto: render only a page that needs JavaScript; off: never; force: read directly in the browser without an HTTP preflight. */
  render?: "auto" | "off" | "force";
  /** "none" (the default) unless the caller holds the `read-local` scope; any other value without it is a 403. */
  localNetworks?: ReadLocalNetworks;
  /** The caller's remaining budget of redirect hops (default 5, at most 5). */
  maxRedirects?: number;
  /** Ties the read to the caller's step in logs; also accepted as the `x-rei-step-id` header. */
  stepId?: string;
}

/** How a read rendered its page, or why it did not. */
export interface ReadRenderDetails {
  /** Why rendering ran: the page had no text without JavaScript, only its embedded summary, or `render: "force"`. */
  reason: "requires_js" | "low_quality" | "forced";
  /** Set when it did not render: the request said off, or no engine is available. */
  skipped?: "off" | "unavailable";
  /** Time spent waiting for a render slot. */
  slotWaitMs?: number;
  renderMs?: number;
  /** "stable": read once the text stopped changing; "deadline": read with what it had when time ran out. */
  ended?: "stable" | "deadline";
  /** Connections the render opened, and the ones refused. */
  connections?: number;
  refused?: number;
  /** Images, media and fonts failed in the browser before they were requested. */
  blockedMedia?: number;
  /** The HTML read back was longer than 5 MiB and was cut. */
  truncated?: true;
  /** The render failed, so the page as fetched (its summary or embedded data) was used instead. */
  failed?: true;
  /** The engine whose result was used. */
  engine?: ReadEngine;
  engineVersion?: string;
  /** The result came from the fallback engine; `reason` is the rule that fired (docs/reader.md). */
  fallback?: { from: ReadEngine; reason: "failed" | "requires_js" | "thin" };
}

/** Everything the app's Fetch section shows about how a page was read. */
export interface ReadDetails {
  method: "http" | "render";
  /** The last response, when one was read. */
  status?: number;
  bytes?: number;
  mediaType?: string;
  /** Redirects followed in this call (a redirect handed back to the caller is not counted). */
  redirects: number;
  render?: ReadRenderDetails;
  durationMs: number;
}

export interface ReadPage {
  outcome: "page";
  finalUrl: string;
  title: string;
  /** Normalized Markdown. */
  text: string;
  sections: ReadSection[];
  /** "success" or "low_quality": the other qualities are failures. */
  quality: "success" | "low_quality";
  extractor: ReadExtractor;
  method: "http" | "render";
  /** SHA-256 of `text`, hex. */
  contentHash: string;
  /** The reader's own note about where the text came from when it is not the page as shown. */
  note?: string;
  details: ReadDetails;
}

/** The page redirects to a host outside `allowHosts`. Decide on it and call again with the host added. */
export interface ReadRedirect {
  outcome: "redirect";
  /** The absolute URL the page redirects to. */
  location: string;
  /** Redirects taken in this call, this one included: subtract them from `maxRedirects` for the next call. */
  hops: number;
}

/** A blocked, `requires_js`, unsupported or unreachable page; `message` is written for a model. */
export interface ReadFailure {
  outcome: "failed";
  quality?: ReadQuality;
  message: string;
  details: ReadDetails;
}

export type ReadResponse = ReadPage | ReadRedirect | ReadFailure;

export const READ_MAX_REDIRECTS = 5;
export const READ_MAX_URL_CHARS = 2_000;
/** The header the gateway adds when it forwards a read: who asked (the reader trusts it; only the gateway reaches it). */
export const READ_CALLER_HEADER = "x-rei-caller";
/** The header the gateway adds when it forwards a read: its id for the call, which `render_attempts` rows carry. */
export const READ_ID_HEADER = "x-rei-read-id";
