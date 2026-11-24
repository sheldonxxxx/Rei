// The "web" extension: web_search (the gateway's /search) and web_fetch (a page, read by the shared reader through the gateway).
// Public research in an interactive Standard chat runs automatically. Queries and URLs can carry private data out.

import type { JsonValue } from "@earendil-works/chord/json";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { arr, bool, int, num, obj, opt, str } from "@earendil-works/pi-schema";
import { ipFamily, isPrivateAddress, isRefusedAddress } from "@rei/network";
import type {
  ActionClass,
  ReadDetails,
  SearchAttemptSummary,
  SearchRequestOutcome,
  TaintLabel,
  WebFetchDetails,
} from "@rei/protocol";
import type { EgressService } from "../exec/egress.ts";
import { estimateTokens } from "../memory/text.ts";
import { MODEL_AND_SCRIPTS } from "../pi/callers.ts";
import { evaluateTool, POLICY_MEMO, policyTool, type ToolCatalog } from "../pi/policy-ext.ts";
import { toJson } from "../pi/structured.ts";
import type { ApprovalStore } from "../store/approvals.ts";
import type { AppStore, RunRow, SessionRow } from "../store/store.ts";
import { recordSearchUsage } from "../usage/search.ts";
import type { Logger } from "../util/log.ts";
import type { CachedPage } from "./cache.ts";
import type { WebDocument, WebDocumentStore } from "./documents.ts";
import { hostOf, parseFetchUrl, ReadFailed, readPage } from "./fetch.ts";
import { countTokens } from "./passages.ts";
import { type Rendered, renderOffset, renderOverview, renderQuery, renderSection } from "./render.ts";
import { FRESHNESS, formatResults, MAX_QUERY_CHARS, searchWeb } from "./search.ts";
import { WebError } from "./types.ts";

export const WEB_CONNECTOR = "web";

type ToolText = {
  output: { type: "text"; text: string }[];
  isError?: true;
  details?: WebFetchDetails;
  structuredOutput?: JsonValue;
};
const ok = (text: string, details?: WebFetchDetails, structuredOutput?: unknown): ToolText => ({
  output: [{ type: "text", text }],
  ...(details !== undefined ? { details } : {}),
  ...(structuredOutput !== undefined ? { structuredOutput: toJson(structuredOutput) } : {}),
});
const fail = (text: string, details?: WebFetchDetails): ToolText => ({
  isError: true,
  output: [{ type: "text", text }],
  ...(details !== undefined ? { details } : {}),
});
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** What a script gets from web_search: the results, and the cited answer when the provider gave one. */
const WebSearchOutput = obj({
  query: str(),
  provider: str({ description: "Which search provider answered." }),
  results: arr(
    obj({
      title: str(),
      url: str(),
      snippet: str({ description: "As the provider returned it (the text output shows the first 300 characters)." }),
      published: opt(str()),
    }),
  ),
  answer: opt(
    obj({
      text: str({ description: "The answer, without link markup; citations point into it." }),
      citations: arr(obj({ title: str(), url: str(), start: int(), end: int() })),
      sources: arr(obj({ title: str(), url: str() })),
      model: str(),
      searchCalls: int(),
    }),
  ),
});

/** What a script gets from web_fetch: the text as the model would read it, and what it needs to continue. */
const WebFetchOutput = obj({
  url: str({ description: "The address the page ended up at, after redirects." }),
  title: str(),
  text: str({
    description:
      "The result text exactly as the model sees it: the page between page-content markers, then any footer saying how to read on.",
  }),
  truncated: bool({
    description:
      "false only when text holds all that was asked for (the whole page, a whole section, the last slice). An outline of a long page, matching passages and a slice with more after it are true.",
  }),
  pageContentId: str({ description: "The id in text's <<<page-content id=…>>> markers." }),
  mode: StringEnum(["whole", "overview", "query", "section", "offset"]),
  cached: bool({ description: "Read from the stored copy, not fetched now." }),
  pageChars: num({ description: "Length of the whole page's text, in characters." }),
});

export const WEB_NOTE =
  "You can search the web (web_search) and read pages (web_fetch). Search for current facts and anything you are not sure of, then fetch a result instead of relying on its snippet. Cite the URLs you used, adding #section-id for a section you relied on.";

export interface WebToolsDeps {
  treeId: string;
  store: AppStore;
  approvals: ApprovalStore;
  catalog: ToolCatalog;
  egress: EgressService;
  log: Logger;
  /** The pages web_fetch read, per agent (documents.ts). */
  documents: WebDocumentStore;
  /** Shared by every tree's extension: the policy catalog holds one tool declaration, so one tree's hook can decide another's call. */
  networkDecisions: NetworkDecisions;
  /** The gateway's base URL (web_search posts to `/search`); unset: web_search is unavailable. */
  searchUrl?: string | undefined;
  /** The stand-in token the gateway accepts (the same one model calls use). */
  searchToken(): Promise<string | undefined>;
  fetchImpl?: typeof fetch | undefined;
  /** Test hook: the whole-read deadline. */
  readTimeoutMs?: number;
}

/** Recognizable local destinations keep the local-network policy and never use public web grants. */
function publicHost(host: string): boolean {
  if (ipFamily(host) !== 0) return !isPrivateAddress(host) && !isRefusedAddress(host);
  return host.includes(".") && !/\.(?:localhost|local|lan|home\.arpa)$/.test(host);
}

/** Private-session web requests are sends: both queries and URLs can carry private data out. */
export const searchClass = (_args: unknown, taint: readonly TaintLabel[]): ActionClass =>
  taint.includes("private") ? "send" : "read_external";

/** What the policy hook learns before deciding a fetch: whether the agent has a fresh stored copy it will read instead. */
export interface FetchFacts {
  stored: boolean;
}

/**
 * A fetch the agent's fresh stored copy answers (no `refresh`) sends nothing out: read_internal. Anything else is a network
 * read, decided as before: a send in a private session, else read_external. Without facts (a redirect check), the network rule.
 */
export const fetchClass = (args: unknown, taint: readonly TaintLabel[], facts?: FetchFacts): ActionClass =>
  facts?.stored === true ? "read_internal" : searchClass(args, taint);

/** The destination of a fetch call: the URL's host, lower case; null when the URL does not parse. */
export function fetchDestination(args: { url: string }): string | null {
  try {
    return hostOf(new URL(args.url.trim()));
  } catch {
    return null;
  }
}

export function createWebExtension(deps: WebToolsDeps): Extension {
  const { treeId, store, approvals, catalog, egress, log, documents, networkDecisions } = deps;
  const context = (conversationId: unknown): { session: SessionRow; run: RunRow | undefined } | undefined => {
    const session = store.sessionByConversation(treeId, String(conversationId));
    if (!session) return undefined;
    return { session, run: store.runningRun(session.id) };
  };

  const search = policyTool(
    catalog,
    {
      actionClass: "read_external",
      connector: WEB_CONNECTOR,
      operation: "search",
      classFor: searchClass,
      webResearch: () => true,
      summary: (a: { query: string }) => `Search the web: "${clip(String(a.query ?? ""), 200)}"`,
    },
    {
      name: "web_search",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Search the web for current information. Returns results or a cited answer with source links; keep its citations. Use web_fetch to read a result. In a script it returns { query, provider, results: [{ title, url, snippet, published? }], answer? }.",
      parameters: obj({
        query: str({ description: `What to search for (at most ${MAX_QUERY_CHARS} characters).` }),
        count: opt(int({ minimum: 1, maximum: 10, description: "Target number of results or sources (default 5)." })),
        freshness: opt(
          StringEnum(FRESHNESS, {
            description: "Prefer the last day, week, month or year (a preference, not a strict filter).",
          }),
        ),
      }),
      structuredOutputSchema: WebSearchOutput,
      replay: "safe",
      execute: async (args, api, abort) => {
        const query = args.query.trim();
        if (query === "") return fail("Give a query to search for.");
        if (query.length > MAX_QUERY_CHARS)
          return fail(`The query is too long (at most ${MAX_QUERY_CHARS} characters).`);
        if (!deps.searchUrl) return fail("Web search is not available: no gateway is configured.");
        const token = await deps.searchToken();
        if (!token) return fail("Web search is not available: the gateway credential is missing.");
        const ctx = context(api.conversationId);
        const stepId = ctx?.run ? store.latestModelStep(ctx.run.id) : undefined;
        const started = Date.now();
        // Usage counters only; a failed counter write must never fail the search itself.
        const count = (outcome: SearchRequestOutcome, trace: SearchAttemptSummary[]) => {
          try {
            recordSearchUsage(store.db, Date.now(), outcome, trace);
          } catch (cause) {
            log.warn("web.search_usage_failed", { sessionId: ctx?.session.id, error: String(cause) });
          }
        };
        try {
          const response = await searchWeb(
            {
              query,
              ...(args.count !== undefined ? { count: args.count } : {}),
              ...(args.freshness !== undefined ? { freshness: args.freshness } : {}),
            },
            { gatewayUrl: deps.searchUrl, token, stepId, fetchImpl: deps.fetchImpl, signal: abort.abortSignal },
          );
          log.debug("web.search", {
            sessionId: ctx?.session.id,
            runId: ctx?.run?.id,
            stepId,
            provider: response.provider,
            results: response.answer?.sources.length ?? response.results.length,
            searchCalls: response.answer?.searchCalls,
            durationMs: Date.now() - started,
          });
          count(response.answer || response.results.length ? "answered" : "empty", response.attempts ?? []);
          return ok(formatResults(query, response), undefined, {
            query,
            provider: response.provider,
            results: response.results,
            ...(response.answer
              ? {
                  answer: {
                    text: response.answer.text,
                    citations: response.answer.citations,
                    sources: response.answer.sources,
                    model: response.answer.model,
                    searchCalls: response.answer.searchCalls,
                  },
                }
              : {}),
          });
        } catch (error) {
          if (!abort.abortSignal?.aborted) count("failed", error instanceof WebError ? error.attempts : []);
          log.info("web.search_failed", {
            sessionId: ctx?.session.id,
            runId: ctx?.run?.id,
            stepId,
            durationMs: Date.now() - started,
          });
          return fail(error instanceof WebError ? error.message : "Web search failed.");
        }
      },
    },
  );

  const fetchTool = policyTool(
    catalog,
    {
      actionClass: "read_external",
      connector: WEB_CONNECTOR,
      operation: "fetch",
      destination: fetchDestination,
      webResearch: (args) => {
        const host = fetchDestination({ url: String(args.url ?? "") });
        return host !== null && publicHost(host);
      },
      inspect: async (a: { url?: unknown; refresh?: unknown }, session: SessionRow): Promise<FetchFacts> => {
        let href: string;
        try {
          href = parseFetchUrl(String(a.url ?? "")).href;
        } catch {
          return { stored: false };
        }
        const stored = a.refresh !== true && documents.has(session.agent_id, href);
        if (!stored) networkDecisions.record(session.id, href);
        return { stored };
      },
      classFor: fetchClass,
      summary: (a: { url: string; refresh?: boolean }) =>
        `${a.refresh === true ? "Fetch again" : "Fetch"} ${clip(String(a.url ?? ""), 250)}`,
    },
    {
      name: "web_fetch",
      callers: MODEL_AND_SCRIPTS,
      description:
        "Read a web page (http or https) as Markdown. A short page comes back whole; a long one as an outline of its sections (with ids) and its opening. Then pass query for the passages that match a question, or section to read one section in full. Pages are kept for a day; refresh fetches again. Reads web pages, text and JSON; not PDFs or images. Pages that need JavaScript are rendered first, which takes a few seconds longer. Docs sites often publish /llms.txt, a map of their pages written for agents: fetch it first when exploring one. In a script it returns { url, title, text, truncated, pageContentId, mode, cached, pageChars }; text is the same text the model would read, markers included.",
      parameters: obj({
        url: str({ description: "The full address, starting with http:// or https://." }),
        query: opt(str({ description: "A question or keywords: returns the passages of the page that match best." })),
        section: opt(str({ description: "A section id from the outline: returns that section in full." })),
        offset: opt(
          int({
            minimum: 0,
            description:
              "Character offset to continue from, as a footer gives it (inside the section when section is set).",
          }),
        ),
        refresh: opt(bool({ description: "Fetch the page again even if a stored copy is fresh." })),
      }),
      structuredOutputSchema: WebFetchOutput,
      replay: "safe",
      // A slice is 20,000 characters (up to 80 KB in UTF-8, one line each at worst); Pi's default cut-off (50 KB, 2,000 lines) would hide the footer.
      outputLimits: { maxBytes: 120_000, maxLines: 30_000 },
      execute: async (args, api, abort) => {
        let url: URL;
        try {
          url = parseFetchUrl(args.url);
        } catch (error) {
          return fail(error instanceof WebError ? error.message : "That is not a URL web_fetch can read.");
        }
        const ctx = context(api.conversationId);
        if (!ctx) return fail("This session is no longer available.");
        const { session, run } = ctx;
        const query = args.query?.trim();
        const sectionId = args.section?.trim();
        if (args.query !== undefined && !query) return fail("Give a query, or leave it out for the page's outline.");
        if (args.section !== undefined && !sectionId) return fail("Give a section id from the outline.");
        if (query && sectionId) return fail("Pass query or section, not both.");
        if (query && args.offset !== undefined)
          return fail("offset continues the raw text or a section; it does not apply to query.");
        const offset = args.offset ?? 0;
        const key = url.href;
        const started = Date.now();

        let doc: WebDocument | undefined = args.refresh === true ? undefined : documents.get(session.agent_id, key);
        const cache: "hit" | "miss" | "refresh" = doc ? "hit" : args.refresh === true ? "refresh" : "miss";
        let redirects = 0;
        let page: CachedPage | undefined;
        let read: ReadDetails | undefined;
        const host = hostOf(url);
        const renderOf = (details: ReadDetails | undefined): WebFetchDetails["render"] => {
          const r = details?.render;
          if (!r) return undefined;
          const { slotWaitMs, ...rest } = r;
          return { ...rest, ...(slotWaitMs !== undefined ? { queueMs: slotWaitMs } : {}) };
        };
        const failed = (details: ReadDetails | undefined, quality?: string): WebFetchDetails => {
          const render = renderOf(details);
          return {
            method: details?.method ?? "http",
            cache,
            host,
            ...(quality ? { quality } : {}),
            ...(details?.status !== undefined ? { status: details.status } : {}),
            ...(details?.bytes !== undefined ? { bytes: details.bytes } : {}),
            ...(details?.mediaType !== undefined ? { mediaType: details.mediaType } : {}),
            redirects,
            ...(render ? { render } : {}),
            durationMs: Date.now() - started,
            error: true,
          };
        };
        if (!doc) {
          // Only under a decision that covered the network: a copy that expired after a read_internal decision is not fetched.
          if (!networkDecisions.take(session.id, key))
            return fail("The stored copy of this page expired just now; call web_fetch again to fetch it.");
          if (!deps.searchUrl) return fail("Web fetch is not available: no gateway is configured.");
          const token = await deps.searchToken();
          if (!token) return fail("Web fetch is not available: the gateway credential is missing.");
          if (!run) return fail("Web fetch needs a running task.");
          const stepId = store.latestModelStep(run.id);
          try {
            const authority = await api.memo(POLICY_MEMO, abort);
            let publicOnly =
              typeof authority === "string" &&
              authority.startsWith("grant:") &&
              approvals.getGrant(authority.slice(6))?.length === "web_session";
            const result = await readPage(url, {
              gatewayUrl: deps.searchUrl,
              token,
              ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
              localNetworksFor: (hosts) => (publicOnly ? "none" : egress.localNetworksFor(session.agent_id, hosts)),
              checkRedirect: (next) => {
                const policy = catalog.get("web_fetch");
                const fresh = store.getSessionRow(session.id);
                if (!policy || !fresh) return "The page redirects to another site, which was not followed.";
                const { decision, grant } = evaluateTool(approvals, fresh, policy, { url: `https://${next}/` });
                if (decision.kind !== "allow")
                  return `The page redirects to ${next}, which is not allowed without the user's approval, so the redirect was not followed.`;
                if (decision.via === "grant" && grant?.length === "web_session") publicOnly = true;
                return undefined;
              },
              stepId,
              signal: abort.abortSignal,
              ...(deps.readTimeoutMs !== undefined ? { timeoutMs: deps.readTimeoutMs } : {}),
            });
            page = result.page;
            read = result.details;
            redirects = result.redirects;
            // Anything read from outside is outside content to the session.
            store.addTaint(session.id, ["external"]);
            log.debug("web.fetch", {
              sessionId: session.id,
              runId: run.id,
              stepId,
              host,
              redirects,
              chars: page.text.length,
              quality: page.quality,
              extractor: page.extractor,
              method: page.method,
              sections: page.sections?.length,
              durationMs: Date.now() - started,
            });
          } catch (error) {
            const details = error instanceof ReadFailed ? error.details : undefined;
            if (error instanceof ReadFailed) redirects = error.redirects;
            log.info("web.fetch_failed", {
              sessionId: session.id,
              runId: run.id,
              stepId,
              host,
              redirects,
              quality: error instanceof WebError ? error.quality : undefined,
              renderReason: details?.render?.reason,
              durationMs: Date.now() - started,
            });
            return fail(
              error instanceof WebError ? error.message : "The page could not be fetched.",
              failed(details, error instanceof WebError ? error.quality : undefined),
            );
          }
          try {
            // A cancelled call keeps nothing: the run stopped, so what it fetched is not the agent's to re-read.
            if (abort.abortSignal?.aborted) return fail("The fetch was cancelled.");
            doc = await documents.put(session.agent_id, session.id, key, page);
          } catch {
            log.warn("web.store_failed", { sessionId: session.id, host });
            return fail("The page was fetched but could not be kept for reading; try again.");
          }
        }
        const cached = cache === "hit";
        const rendered: Rendered = sectionId
          ? renderSection(doc, sectionId, offset, cached)
          : query
            ? renderQuery(doc, query, documents.search(doc, query), cached)
            : args.offset !== undefined
              ? renderOffset(doc, offset)
              : renderOverview(doc, cached);
        if ("error" in rendered) return fail(rendered.error);
        // For the trace (detail mode): how the page was read and what this result cost; never the page text.
        const details: WebFetchDetails = {
          method: doc.method ?? "http",
          cache,
          mode: rendered.mode,
          host: hostOf(new URL(doc.url)),
          title: doc.title,
          quality: doc.quality,
          extractor: doc.extractor,
          ...(rendered.sections ? { sections: rendered.sections } : {}),
          ...(read?.status !== undefined ? { status: read.status } : {}),
          ...(read?.bytes !== undefined ? { bytes: read.bytes } : {}),
          ...(read?.mediaType !== undefined ? { mediaType: read.mediaType } : {}),
          ...(page ? { redirects } : {}),
          ...(renderOf(read) ? { render: renderOf(read)! } : {}),
          tokensReturned: countTokens(rendered.text),
          pageTokens: estimateTokens(doc.text),
          pageChars: doc.text.length,
          durationMs: Date.now() - started,
        };
        if (api.callId && doc.id) {
          try {
            documents.recordCall(session.id, api.callId, doc);
          } catch {
            log.warn("web.call_record_failed", { sessionId: session.id });
          }
        }
        const { sections: shown, title: _title, render: renderInfo, ...logged } = details;
        log.debug("web.fetch_result", {
          sessionId: session.id,
          runId: run?.id,
          ...logged,
          sectionsShown: shown?.length,
          renderReason: renderInfo?.reason,
        });
        return ok(rendered.text, details, {
          url: doc.url,
          title: doc.title,
          text: rendered.text,
          truncated: rendered.truncated,
          pageContentId: rendered.fenceId,
          mode: rendered.mode,
          cached,
          pageChars: doc.text.length,
        });
      },
    },
  );

  return defineExtension({
    name: "web",
    namespace: { name: "web", description: "Search the web and read pages." },
    tools: [search, fetchTool],
    sections: [section("web", () => WEB_NOTE)],
  });
}

/**
 * The fetches the policy decided as network reads, per session and URL, until execute takes them. execute fetches only
 * against one of these: a call decided as a stored read (read_internal) never reaches the network, even when the copy
 * expired in between or the process restarted (then there is no entry, and the call fails and is made again).
 */
export class NetworkDecisions {
  static readonly MAX = 1_000;
  readonly #pending = new Map<string, number>();

  record(sessionId: string, href: string): void {
    const key = `${sessionId}\n${href}`;
    this.#pending.set(key, (this.#pending.get(key) ?? 0) + 1);
    // Calls that were blocked never come to take theirs: the oldest go first.
    while (this.#pending.size > NetworkDecisions.MAX) this.#pending.delete(this.#pending.keys().next().value!);
  }

  take(sessionId: string, href: string): boolean {
    const key = `${sessionId}\n${href}`;
    const n = this.#pending.get(key) ?? 0;
    if (n <= 0) return false;
    if (n === 1) this.#pending.delete(key);
    else this.#pending.set(key, n - 1);
    return true;
  }
}
