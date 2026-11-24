// POST /read's body, checked. The gateway has already authenticated the caller and checked the read-local scope for a
// `localNetworks` other than "none"; this only decides whether the request is well formed.
import { READ_MAX_REDIRECTS, READ_MAX_URL_CHARS, type ReadLocalNetworks, type ReadRequest } from "@rei/protocol";
import { ReaderError } from "./types.ts";

const PORTS = new Set(["", "80", "443"]);
const MAX_ALLOW_HOSTS = 50;
const MAX_LOCAL_ENTRIES = 200;

export interface ParsedRead {
  url: URL;
  /** Lower case, without a trailing dot; the start host is always among them. */
  allowHosts: ReadonlySet<string>;
  render: "auto" | "off" | "force";
  localNetworks: ReadLocalNetworks;
  maxRedirects: number;
  stepId: string | undefined;
}

export const hostOf = (url: URL): string => url.hostname.toLowerCase();

/** The URL a read may start from (or be redirected to): http(s), no credentials, ports 80 and 443 only, no fragment. */
export function parseReadUrl(text: unknown): URL {
  if (typeof text !== "string" || text.length > READ_MAX_URL_CHARS)
    throw new ReaderError("That is not a URL web_fetch can read.");
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new ReaderError("That is not a valid URL. Give a full address starting with http:// or https://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ReaderError("Only http and https addresses can be fetched.");
  if (url.username !== "" || url.password !== "")
    throw new ReaderError("Addresses with a user name or password in them are not fetched.");
  if (!PORTS.has(url.port)) throw new ReaderError("Only ports 80 and 443 can be fetched.");
  if (url.hostname === "") throw new ReaderError("That address has no host.");
  url.hash = "";
  return url;
}

const normalizeHost = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

/** The request as the reader uses it; throws a ReaderError whose message says what is wrong. */
export function parseReadRequest(input: unknown, headerStepId?: string | null): ParsedRead {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new ReaderError("The body must be a JSON object.");
  const body = input as Partial<Record<keyof ReadRequest, unknown>>;
  const url = parseReadUrl(body.url);

  if (!Array.isArray(body.allowHosts) || body.allowHosts.length > MAX_ALLOW_HOSTS)
    throw new ReaderError(`allowHosts must be a list of at most ${MAX_ALLOW_HOSTS} host names.`);
  const hosts = new Set<string>();
  for (const entry of body.allowHosts) {
    const host = typeof entry === "string" ? normalizeHost(entry) : "";
    if (host === "" || host.length > 253) throw new ReaderError("allowHosts holds an entry that is not a host name.");
    hosts.add(host);
  }
  const start = normalizeHost(url.hostname);
  if (!hosts.has(start)) throw new ReaderError("allowHosts must include the host of url.");

  const render = body.render ?? "auto";
  if (render !== "auto" && render !== "off" && render !== "force")
    throw new ReaderError("render must be auto, off or force.");

  const local = body.localNetworks ?? "none";
  if (local !== "none" && local !== "all") {
    if (
      !Array.isArray(local) ||
      local.length > MAX_LOCAL_ENTRIES ||
      !local.every((entry) => typeof entry === "string" && entry.length <= 64)
    )
      throw new ReaderError('localNetworks must be "none", "all" or a list of addresses and networks.');
  }

  const redirects = body.maxRedirects ?? READ_MAX_REDIRECTS;
  if (typeof redirects !== "number" || !Number.isInteger(redirects) || redirects < 0 || redirects > READ_MAX_REDIRECTS)
    throw new ReaderError(`maxRedirects must be a whole number from 0 to ${READ_MAX_REDIRECTS}.`);

  const stepCandidate = typeof body.stepId === "string" ? body.stepId : (headerStepId ?? undefined);
  const stepId = stepCandidate !== undefined && /^[\w.:-]{1,128}$/.test(stepCandidate) ? stepCandidate : undefined;
  return {
    url,
    allowHosts: hosts,
    render,
    localNetworks: local as ReadLocalNetworks,
    maxRedirects: redirects,
    stepId,
  };
}
