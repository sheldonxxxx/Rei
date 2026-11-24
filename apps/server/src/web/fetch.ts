// web_fetch's network side (ADR 0020): the page is read by the shared reader through the gateway's POST /read. This file
// validates the URL, owns the destination policy (the reader fetches only the hosts it is told, and hands any other
// redirect back), follows the redirect contract, and turns the answer into a stored page or an error for the model.
import type { ReadDetails, ReadLocalNetworks, ReadPage, ReadRequest, ReadResponse, ReadSection } from "@rei/protocol";
import type { CachedPage } from "./cache.ts";
import { type PageQuality, WebError } from "./types.ts";

/** One read, from the first byte to the last: the reader's fetch (15 s), a wait for a slot (30 s) and two renders (20 s each). */
export const READ_TIMEOUT_MS = 120_000;
export const MAX_REDIRECTS = 5;
export const MAX_URL_CHARS = 2_000;
const STEP_ID_HEADER = "x-rei-step-id";
const PORTS = new Set(["", "80", "443"]);

/** The URL a fetch is allowed to start from: http(s), no credentials, ports 80 and 443 only, no fragment. */
export function parseFetchUrl(text: string): URL {
  if (typeof text !== "string" || text.length > MAX_URL_CHARS)
    throw new WebError("That is not a URL web_fetch can read.");
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new WebError("That is not a valid URL. Give a full address starting with http:// or https://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new WebError("Only http and https addresses can be fetched.");
  if (url.username !== "" || url.password !== "")
    throw new WebError("Addresses with a user name or password in them are not fetched.");
  if (!PORTS.has(url.port)) throw new WebError("Only ports 80 and 443 can be fetched.");
  if (url.hostname === "") throw new WebError("That address has no host.");
  url.hash = "";
  return url;
}

export const hostOf = (url: URL): string => url.hostname.toLowerCase();

export interface ReadPlan {
  /** The gateway's base URL and the caller token it accepts. */
  gatewayUrl: string;
  token: string;
  fetchImpl?: typeof fetch | undefined;
  /** The local-network addresses a read of these hosts may reach (the agent's network setting, decided per host). */
  localNetworksFor(hosts: string[]): ReadLocalNetworks;
  /** A redirect is about to go to a new host: undefined when the policy lets it through, else a message naming why not. */
  checkRedirect(host: string): string | undefined;
  /** The call being cancelled. */
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
  /** For logs: a redirect to a new host was followed. */
  onHop?(host: string): void;
  /** For logs: the model step the read belongs to (sent to the gateway, never to the site). */
  stepId?: string | undefined;
}

/** What a successful read gives back besides the page: how it was read, for the trace. */
export interface ReadResult {
  page: CachedPage;
  details: ReadDetails;
  /** Redirects followed, within and across hosts. */
  redirects: number;
}

/** A failed read with how far it got (for the trace). */
export class ReadFailed extends WebError {
  readonly details: ReadDetails | undefined;
  readonly redirects: number;
  constructor(message: string, quality: PageQuality | undefined, details: ReadDetails | undefined, redirects: number) {
    super(message, quality);
    this.name = "ReadFailed";
    this.details = details;
    this.redirects = redirects;
  }
}

/** The gateway's own answers to POST /read, in words for the model. */
function gatewayMessage(status: number, code: string | undefined): string {
  if (status === 401) return "Web reading is not available: the gateway did not accept Rei's credential.";
  if (code === "caller_concurrency" || status === 429)
    return "Too many pages are being read at once; try again shortly.";
  if (code === "read_unavailable" || status === 502 || status === 503)
    return "Web reading is not available right now: the page reader did not answer.";
  if (status === 403) return "Web reading is turned off for this installation.";
  return `Web reading failed (HTTP ${status}).`;
}

async function callRead(request: ReadRequest, plan: ReadPlan, signal: AbortSignal): Promise<ReadResponse> {
  const doFetch = plan.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await doFetch(`${plan.gatewayUrl.replace(/\/+$/, "")}/read`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${plan.token}`,
        "content-type": "application/json",
        ...(plan.stepId ? { [STEP_ID_HEADER]: plan.stepId } : {}),
      },
      body: JSON.stringify(request),
      signal,
    });
  } catch {
    throw new WebError("Web reading is not available right now: the gateway could not be reached.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: unknown } } | undefined)?.error;
    throw new WebError(gatewayMessage(response.status, typeof error?.code === "string" ? error.code : undefined));
  }
  const outcome = (body as { outcome?: unknown } | undefined)?.outcome;
  if (outcome !== "page" && outcome !== "redirect" && outcome !== "failed")
    throw new WebError("The page reader gave an answer Rei could not understand.");
  return body as ReadResponse;
}

const QUALITIES = new Set<PageQuality>(["success", "low_quality", "requires_js", "blocked", "unsupported_mime"]);

function toCached(page: ReadPage): CachedPage {
  return {
    title: page.title,
    url: page.finalUrl,
    text: page.text,
    quality: page.quality,
    extractor: page.extractor,
    sections: page.sections as ReadSection[],
    method: page.method,
    ...(page.note ? { note: page.note } : {}),
  };
}

/** Reads `start` through the reader and returns its text. Throws a WebError for everything the model should hear about. */
export async function readPage(start: URL, plan: ReadPlan): Promise<ReadResult> {
  const timeout = AbortSignal.timeout(plan.timeoutMs ?? READ_TIMEOUT_MS);
  const signal = plan.signal ? AbortSignal.any([timeout, plan.signal]) : timeout;
  const allowHosts = [hostOf(start)];
  let current = start;
  let redirects = 0;
  let remaining = MAX_REDIRECTS;
  for (;;) {
    const localNetworks = plan.localNetworksFor(allowHosts);
    let answer: ReadResponse;
    try {
      answer = await callRead(
        {
          url: current.href,
          allowHosts,
          render: "force",
          maxRedirects: remaining,
          ...(localNetworks !== "none" ? { localNetworks } : {}),
          ...(plan.stepId ? { stepId: plan.stepId } : {}),
        },
        plan,
        signal,
      );
    } catch (error) {
      if (plan.signal?.aborted) throw new ReadFailed("The fetch was cancelled.", undefined, undefined, redirects);
      if (timeout.aborted)
        throw new ReadFailed(`${hostOf(current)} did not finish loading in time.`, undefined, undefined, redirects);
      throw error;
    }
    if (answer.outcome === "redirect") {
      let next: URL;
      try {
        next = parseFetchUrl(answer.location);
      } catch (error) {
        throw new ReadFailed(
          `${hostOf(current)} redirected somewhere that cannot be fetched: ${error instanceof WebError ? error.message : "invalid address"}`,
          undefined,
          undefined,
          redirects,
        );
      }
      const hops = Math.max(1, answer.hops);
      redirects += hops;
      remaining -= hops;
      if (remaining < 0)
        throw new ReadFailed(`Too many redirects (more than ${MAX_REDIRECTS}).`, undefined, undefined, redirects);
      const nextHost = hostOf(next);
      if (!allowHosts.includes(nextHost)) {
        const refusal = plan.checkRedirect(nextHost);
        if (refusal !== undefined) throw new ReadFailed(refusal, undefined, undefined, redirects);
        allowHosts.push(nextHost);
        plan.onHop?.(nextHost);
      }
      current = next;
      continue;
    }
    if (answer.outcome === "failed") {
      const quality = answer.quality && QUALITIES.has(answer.quality) ? answer.quality : undefined;
      throw new ReadFailed(answer.message, quality, answer.details, redirects + (answer.details?.redirects ?? 0));
    }
    return { page: toCached(answer), details: answer.details, redirects: redirects + answer.details.redirects };
  }
}
