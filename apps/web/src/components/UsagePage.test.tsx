import {
  type CallerUsageResponse,
  type ImageUsageResponse,
  type SearchUsageResponse,
  USAGE_METRICS,
  USAGE_PURPOSES,
  type UsageCallersResponse,
  type UsageResponse,
  type UsageTotals,
} from "@rei/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../api/client.ts";
import { UsagePage } from "./UsagePage.tsx";

function totals(calls = 1): UsageTotals {
  return {
    tokens: {
      inputTotal: 1000 * calls,
      inputCached: 600 * calls,
      inputUncached: 400 * calls,
      outputTotal: 150 * calls,
      totalProcessed: 1150 * calls,
      reasoningOutput: 50 * calls,
    },
    unknown: Object.fromEntries(USAGE_METRICS.map((m) => [m, 0])) as UsageTotals["unknown"],
    modelCalls: calls,
    callsReported: calls,
    callsUnreported: 0,
    cacheHitPercent: calls ? 60 : null,
  };
}
function response(summary = totals()): UsageResponse {
  return {
    period: "30d",
    timezone: "UTC",
    trackingSince: "2026-11-01T03:00:00.000Z",
    from: "2026-11-01",
    to: "2026-11-02",
    summary,
    byPurpose: USAGE_PURPOSES.map((purpose) => ({ purpose, usage: purpose === "chat" ? summary : totals(0) })),
    byModel: summary.modelCalls
      ? [{ provider: "openai", providerName: "OpenAI", model: "example-model", usage: summary }]
      : [],
    byAgent: [],
    daily: [],
    search: { searches: 0, answered: 0, empty: 0, failed: 0, searchesWithFallback: 0, byProvider: [] },
    images: { requests: 0, succeeded: 0, failed: 0, generated: 0, edited: 0, averageMs: null, failures: [] },
  };
}
const NO_CALLERS: UsageCallersResponse = { available: true, callers: [] };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockUsageFetch(
  usageBody: UsageResponse | (() => UsageResponse | Response | Promise<Response>) = () => response(),
  callers: UsageCallersResponse = NO_CALLERS,
  gatewayHandler?: (url: URL) => Response | Promise<Response>,
) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input), "https://test.invalid");
    if (url.pathname === "/api/usage/callers") return json(callers);
    if (url.pathname === "/api/usage/gateway") {
      if (gatewayHandler) return gatewayHandler(url);
      return json({ error: { code: "not_found", message: "missing mock" } }, 404);
    }
    const res = typeof usageBody === "function" ? await usageBody() : usageBody;
    return res instanceof Response ? res : json(res);
  });
}

function setup(fetchMock = mockUsageFetch(), tab: string | null = null) {
  const api = createApi({ fetch: fetchMock });
  const view = render(<UsagePage api={api} tab={tab} />);
  return { fetchMock, view };
}
const card = (label: string) =>
  screen.getByText(label, { selector: "dt" }).parentElement!.querySelector("dd")!.textContent;
/** The summary cards of the Web search section, which share some labels with its provider rows. */
const searchCard = (label: string) => {
  const dl = screen.getByRole("region", { name: "Web search usage" }).querySelector("dl")!;
  const dt = [...dl.querySelectorAll("dt")].find((d) => d.textContent?.startsWith(label));
  return dt!.parentElement!.querySelector("dd")!.textContent;
};

function callerUsageResponse(overrides: Partial<CallerUsageResponse> = {}): CallerUsageResponse {
  return {
    period: "30d",
    timezone: "UTC",
    trackingSince: "2026-11-05T00:00:00.000Z",
    from: "2026-11-05",
    to: "2026-11-24",
    caller: {
      id: "reports",
      note: "nightly summaries",
      scopes: ["models", "search", "embeddings", "read"],
      revokedAt: null,
      lastUsedAt: Date.parse("2026-11-24T08:00:00Z"),
    },
    models: {
      summary: {
        inputTotal: 5000,
        inputCached: 1000,
        inputUncached: 4000,
        outputTotal: 800,
        totalProcessed: 5800,
        cacheHitPercent: 20,
        calls: 4,
        callsReported: 3,
        callsUnreported: 1,
        ok: 3,
        errors: 1,
        upstreamLimited: 1,
      },
      byModel: [
        {
          provider: "openai",
          providerName: "OpenAI",
          model: "gpt-5-mini",
          inputTotal: 5000,
          inputCached: 1000,
          inputUncached: 4000,
          outputTotal: 800,
          totalProcessed: 5800,
          cacheHitPercent: 20,
          calls: 4,
          callsReported: 3,
          callsUnreported: 1,
          ok: 3,
          errors: 1,
          upstreamLimited: 1,
        },
      ],
    },
    byCaller: [],
    search: {
      calls: 3,
      ok: 2,
      errors: 1,
      averageMs: 320,
      byProvider: [{ provider: "brave", providerName: "Brave", calls: 3, ok: 2, errors: 1, averageMs: 320 }],
    },
    embeddings: { calls: 2, ok: 2, errors: 0, inputTokens: 640, averageMs: 45 },
    reads: { calls: 5, ok: 4, errors: 1, averageMs: 1200 },
    refusals: [{ code: "caller_concurrency", count: 2 }],
    errorBreakdown: [
      { code: "rate_limited", count: 1 },
      { code: "upstream_502", count: 2 },
    ],
    ...overrides,
  };
}

describe("UsagePage", () => {
  it("shows loading until the authenticated API request resolves, then renders inclusive metrics and real category/model rows", async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input) === "/api/usage/callers") return Promise.resolve(json(NO_CALLERS));
      return new Promise((r) => {
        resolve = r;
      });
    });
    setup(fetchMock);
    expect(screen.getByRole("status", { name: "Loading usage" })).toBeTruthy();
    expect(screen.queryByText("Total input")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/usage?period=30d",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
    await act(async () => resolve(json(response())));
    expect(screen.queryByRole("tablist", { name: "Usage caller" })).toBeNull();
    expect(card("Total input")).toBe("1K");
    expect(card("Cached input")).toBe("600");
    expect(card("Uncached input")).toBe("400");
    expect(card("Output")).toBe("150");
    expect(card("Total processed")).toBe("1.2K");
    expect(card("Cache hit")).toBe("60.0%");
    expect(card("Model calls")).toBe("1");
    expect(screen.getByText(/Since 2026-11-01 \(UTC\)/)).toBeTruthy();
    await userEvent.hover(screen.getByRole("button", { name: "About unreliable reports" }));
    expect((await screen.findByRole("tooltip")).textContent).toContain("persist regardless of detailed log expiration");
    const purpose = screen.getByRole("region", { name: "By purpose usage table" });
    expect(
      within(purpose)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["Chat", "Memory maintenance", "Titles", "Agent tasks", "Other"]);
    const chat = within(purpose).getByRole("rowheader", { name: "Chat" }).parentElement!;
    expect(
      within(chat)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["1K", "600", "150", "1"]);
    const model = screen.getByRole("region", { name: "By model usage table" });
    const modelRow = within(model).getByRole("rowheader", { name: "OpenAI / example-model" }).parentElement!;
    expect(
      within(modelRow)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["1K", "600", "60.0%", "150", "1"]);
    expect(within(model).getByRole("columnheader", { name: "Cache hit" })).toBeTruthy();
    expect(within(purpose).queryByRole("columnheader", { name: "Cache hit" })).toBeNull();
    expect(model.tabIndex).toBe(0); // keyboard users can reach the locally scrolling table
  });

  it("shows a truthful empty state with zero counters and an unavailable cache ratio", async () => {
    setup(mockUsageFetch(response(totals(0))));
    await screen.findByText("No usage recorded since tracking began");
    expect(card("Total input")).toBe("0");
    expect(card("Model calls")).toBe("0");
    expect(card("Cache hit")).toBe("Unavailable");
    expect(screen.queryByRole("region", { name: "By model usage table" })).toBeNull();
  });

  it("distinguishes a quiet selected period from all-time empty tracking", async () => {
    setup(mockUsageFetch({ ...response(totals(0)), from: "2026-12-01", to: "2026-12-07" }));
    expect(await screen.findByText("No usage recorded in this period")).toBeTruthy();
    expect(screen.queryByText("No usage recorded since tracking began")).toBeNull();
  });

  it("keeps known partial totals as lower bounds and missing input/output/cache reports unavailable", async () => {
    const partial = totals();
    partial.modelCalls = 3;
    partial.callsUnreported = 2;
    partial.tokens.inputCached = null;
    partial.tokens.inputUncached = null;
    partial.tokens.outputTotal = null;
    partial.tokens.totalProcessed = null;
    partial.unknown = {
      inputTotal: 2,
      inputCached: 3,
      inputUncached: 3,
      outputTotal: 3,
      totalProcessed: 3,
      reasoningOutput: 2,
    };
    partial.cacheHitPercent = null;
    setup(mockUsageFetch(response(partial)));
    await screen.findByText(/2 calls with missing/);
    expect(card("Total input")).toBe("1K");
    expect(card("Cached input")).toBe("Unavailable");
    expect(card("Uncached input")).toBe("Unavailable");
    expect(card("Output")).toBe("Unavailable");
    expect(card("Total processed")).toBe("Unavailable");
    expect(card("Cache hit")).toBe("Unavailable");
    expect(card("Model calls")).toBe("3");
    const chat = screen.getByRole("rowheader", { name: "Chat" }).parentElement!;
    expect(
      within(chat)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["1K", "Unavailable", "Unavailable", "3"]);
  });

  it("never displays a fabricated zero for calls with no reliable report", async () => {
    const unknown = totals(0);
    unknown.modelCalls = 2;
    unknown.callsUnreported = 2;
    for (const m of USAGE_METRICS) {
      unknown.tokens[m] = null;
      unknown.unknown[m] = 2;
    }
    setup(mockUsageFetch(response(unknown)));
    await screen.findByText(/2 calls with missing/);
    for (const name of ["Total input", "Cached input", "Uncached input", "Output", "Total processed", "Cache hit"])
      expect(card(name)).toBe("Unavailable");
    expect(screen.queryByText(/No usage recorded/)).toBeNull();
  });

  it("refetches each period through the API and ignores an older response that resolves late", async () => {
    let resolveOld!: (r: Response) => void;
    let firstUsage = true;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url) === "/api/usage/callers") return json(NO_CALLERS);
      if (firstUsage) {
        firstUsage = false;
        return new Promise((r) => {
          resolveOld = r;
        });
      }
      return json({
        ...response(totals(2)),
        period: new URL(String(url), "https://test.invalid").searchParams.get("period"),
      });
    });
    setup(fetchMock);
    const group = screen.getByRole("radiogroup", { name: "Usage period" });
    expect(within(group).getAllByRole("radio")).toHaveLength(7);
    for (const [label, period] of [
      ["Today", "today"],
      ["Last 7 days", "7d"],
      ["This month", "month"],
      ["This year", "year"],
      ["All time", "all"],
      ["Last 30 days", "30d"],
    ] as const) {
      fireEvent.click(within(group).getByRole("radio", { name: label }));
      expect(within(group).getByRole("radio", { name: label }).getAttribute("aria-checked")).toBe("true");
      await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(`/api/usage?period=${period}`, expect.anything()));
      await waitFor(() => expect(card("Total input")).toBe("2K"));
    }
    await act(async () => resolveOld(json(response(totals(9)))));
    expect(card("Total input")).toBe("2K");
  });

  it("reads an inclusive UTC custom range from two date inputs and waits for a valid range", async () => {
    const fetchMock = mockUsageFetch(() => response(totals(4)));
    setup(fetchMock);
    await screen.findByText("Total input");
    expect(screen.queryByLabelText("From")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Custom range" }));
    const from = screen.getByLabelText("From");
    const to = screen.getByLabelText("To");
    fireEvent.change(from, { target: { value: "2026-11-03" } });
    fireEvent.change(to, { target: { value: "2026-11-05" } });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/usage?period=custom&from=2026-11-03&to=2026-11-05",
        expect.anything(),
      ),
    );
    await waitFor(() => expect(card("Total input")).toBe("4K"));
    const sent = fetchMock.mock.calls.length;
    fireEvent.change(to, { target: { value: "2026-11-01" } });
    expect((await screen.findByRole("alert")).textContent).toContain("on or after the From date");
    fireEvent.change(to, { target: { value: "" } });
    expect((await screen.findByRole("alert")).textContent).toContain("Choose both dates");
    expect(fetchMock).toHaveBeenCalledTimes(sent);
    fireEvent.change(to, { target: { value: "2026-11-05" } });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/usage?period=custom&from=2026-11-03&to=2026-11-05",
        expect.anything(),
      ),
    );
    fireEvent.click(screen.getByRole("radio", { name: "Today" }));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/api/usage?period=today", expect.anything()));
    expect(screen.queryByLabelText("From")).toBeNull();
  });

  it("offers retry after an API failure and retries the selected period", async () => {
    let usageAttempts = 0;
    const fetchMock = mockUsageFetch(() => {
      usageAttempts++;
      if (usageAttempts === 1) return json({ error: { code: "unavailable", message: "test failure" } }, 503);
      return response();
    });
    setup(fetchMock);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load usage");
    expect(screen.queryByText("Total input")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(card("Total input")).toBe("1K"));
    expect(usageAttempts).toBe(2);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/usage?period=30d", expect.anything());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows web search counters per provider, with fallback and failure detail behind a collapsed row", async () => {
    const search: SearchUsageResponse = {
      searches: 5,
      answered: 4,
      empty: 0,
      failed: 1,
      searchesWithFallback: 3,
      byProvider: [
        {
          provider: "exa",
          providerName: "Exa",
          succeeded: 2,
          empty: 0,
          failed: 3,
          skipped: 0,
          fallback: 0,
          answeredAfterFallback: 0,
          averageMs: 820,
          details: [
            { outcome: "succeeded", reason: null, fallback: false, calls: 2 },
            { outcome: "failed", reason: "search_timeout", fallback: false, calls: 3 },
          ],
        },
        {
          provider: "brave",
          providerName: "Brave",
          succeeded: 2,
          empty: 0,
          failed: 1,
          skipped: 1,
          fallback: 3,
          answeredAfterFallback: 2,
          averageMs: 400,
          details: [
            { outcome: "succeeded", reason: null, fallback: true, calls: 2 },
            { outcome: "failed", reason: "search_failed", fallback: true, calls: 1 },
            { outcome: "skipped", reason: "not_configured", fallback: false, calls: 1 },
          ],
        },
      ],
    };
    setup(mockUsageFetch({ ...response(), search }));
    await screen.findByText("Web search");
    expect(searchCard("Searches")).toBe("5");
    expect(searchCard("Answered")).toBe("4");
    expect(searchCard("Failed")).toBe("1");
    expect(searchCard("Used fallback")).toBe("3");
    const exa = screen.getByText("Exa").closest("details")!;
    expect(exa.open).toBe(false);
    expect(exa.textContent).toContain("5 searched · 2 succeeded · 3 failed");
    expect(exa.textContent).toContain("820 ms");
    const brave = screen.getByText("Brave").closest("details")!;
    expect(brave.textContent).toContain("3 searched · 2 succeeded · 1 failed");
    expect(brave.textContent).toContain("400 ms");
    await userEvent.click(within(brave).getByText("Brave"));
    expect(brave.open).toBe(true);
    const detail = within(brave);
    expect(detail.getByText("Asked as fallback").parentElement!.textContent).toContain("3");
    expect(detail.getByText("Answered as fallback").parentElement!.textContent).toContain("2");
    // Succeeded outcomes are already in the summary grid, so the detail list leaves them out.
    expect(detail.queryByText("Succeeded (as fallback)")).toBeNull();
    expect(detail.getByText("Failed · search failed (as fallback)").parentElement!.textContent).toContain("1");
    expect(detail.getByText("Skipped · not configured").parentElement!.textContent).toContain("1");
  });

  it("shows image counters, with failures by reason and an empty state", async () => {
    const images: ImageUsageResponse = {
      requests: 6,
      succeeded: 4,
      failed: 2,
      generated: 5,
      edited: 1,
      averageMs: 31250,
      failures: [
        { reason: "rate_limited", calls: 1 },
        { reason: "sign_in_required", calls: 1 },
      ],
    };
    setup(mockUsageFetch({ ...response(), images }));
    const section = await screen.findByRole("region", { name: "Image generation usage" });
    const value = (label: string) =>
      within(section).getByText(label, { selector: "dt" }).parentElement!.querySelector("dd")!.textContent;
    expect(value("Requests")).toBe("6");
    expect(value("Succeeded")).toBe("4");
    expect(value("Failed")).toBe("2");
    expect(value("Generated")).toBe("5");
    expect(value("Edited")).toBe("1");
    expect(value("Average time")).toBe("32 s");
    const failures = within(section).getByRole("list", { name: "Image failures" });
    expect(within(failures).getByText("Rate limited by Codex").parentElement!.textContent).toContain("1");
    expect(within(failures).getByText("Codex Images needs sign-in")).toBeTruthy();
  });

  it("says when no images were requested in the period", async () => {
    setup();
    expect(await screen.findByText("No image requests in this period.")).toBeTruthy();
  });

  it("says when no web search ran in the period", async () => {
    setup();
    expect(await screen.findByText("No web searches in this period.")).toBeTruthy();
  });

  it("shows caller tabs ordered Rei -> callers -> All, keeps period on switch, and renders caller stats", async () => {
    const callers: UsageCallersResponse = {
      available: true,
      callers: [
        {
          id: "reports",
          note: "nightly summaries",
          scopes: ["models", "search", "embeddings", "read"],
          revokedAt: null,
          lastUsedAt: Date.parse("2026-11-24T08:00:00Z"),
        },
        {
          id: "old-used",
          note: "",
          scopes: ["models"],
          revokedAt: Date.parse("2026-11-10T00:00:00Z"),
          lastUsedAt: Date.parse("2026-11-09T00:00:00Z"),
        },
        {
          id: "old-unused",
          note: "",
          scopes: ["models"],
          revokedAt: Date.parse("2026-11-10T00:00:00Z"),
          lastUsedAt: null,
        },
      ],
    };
    const fetchMock = mockUsageFetch(response(), callers, (url) => {
      expect(url.searchParams.get("caller")).toBe("reports");
      return json(callerUsageResponse({ period: (url.searchParams.get("period") as "7d") ?? "30d" }));
    });
    setup(fetchMock);
    const tablist = await screen.findByRole("tablist", { name: "Usage caller" });
    expect(
      within(tablist)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Rei", "reports", "All"]);

    // Change period to Last 7 days first, then switch to reports tab and verify period stays 7d.
    fireEvent.click(screen.getByRole("radio", { name: "Last 7 days" }));
    await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/api/usage?period=7d", expect.anything()));
    await userEvent.click(within(tablist).getByRole("tab", { name: "reports" }));
    await screen.findByText("nightly summaries");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/usage/gateway?period=7d&caller=reports", expect.anything());
    expect(card("Total input")).toBe("5K");
    expect(card("Model calls")).toBe("4");
    expect(screen.getByText(/1 calls without token reports/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Web search usage" }).textContent).toContain("Brave");
    expect(screen.getByRole("region", { name: "Embeddings usage" }).textContent).toContain("640");
    expect(screen.getByRole("region", { name: "Page reads usage" }).textContent).toContain("2 s");
    const limits = screen.getByRole("region", { name: "Limits and errors" });
    expect(within(limits).getByRole("button", { name: "About errors" })).toBeTruthy();
    expect(within(limits).getByText("Upstream rate limit").parentElement!.textContent).toContain("1");
    expect(within(limits).getByText("Upstream HTTP 502").parentElement!.textContent).toContain("2");
    expect(within(limits).getByText("Concurrency cap reached").parentElement!.textContent).toContain("2");
  });

  it("shows Rei's embeddings and page reads sections when returned by /api/usage", async () => {
    setup(
      mockUsageFetch({
        ...response(),
        embeddings: { calls: 8, ok: 8, errors: 0, inputTokens: 12_400, averageMs: 35 },
        reads: { calls: 6, ok: 5, errors: 1, averageMs: 850 },
      }),
    );
    const embeds = await screen.findByRole("region", { name: "Embeddings usage" });
    expect(embeds.textContent).toContain("12.4K");
    expect(embeds.textContent).toContain("35 ms");
    const reads = screen.getByRole("region", { name: "Page reads usage" });
    expect(reads.textContent).toContain("850 ms");
  });

  it("renders the All view with clickable By caller rows that jump to that caller's tab", async () => {
    const callers: UsageCallersResponse = {
      available: true,
      callers: [
        {
          id: "reports",
          note: "nightly summaries",
          scopes: ["models"],
          revokedAt: null,
          lastUsedAt: Date.parse("2026-11-24T08:00:00Z"),
        },
      ],
    };
    const allRes = callerUsageResponse({
      caller: null,
      byCaller: [
        {
          caller: "reports",
          inputTotal: 5000,
          inputCached: 1000,
          outputTotal: 800,
          modelCalls: 4,
          searchCalls: 3,
          embeddingCalls: 2,
          readCalls: 5,
          errors: 3,
          upstreamLimited: 1,
          refusals: 2,
        },
        {
          caller: "rei",
          inputTotal: 1000,
          inputCached: 600,
          outputTotal: 150,
          modelCalls: 1,
          searchCalls: 0,
          embeddingCalls: 0,
          readCalls: 0,
          errors: 0,
          upstreamLimited: 0,
          refusals: 0,
        },
      ],
    });
    const fetchMock = mockUsageFetch(response(), callers, (url) =>
      url.searchParams.get("caller") === "reports" ? json(callerUsageResponse()) : json(allRes),
    );
    setup(fetchMock, "all");
    const table = await screen.findByRole("region", { name: "By caller usage table" });
    const reportsRow = within(table).getByRole("button", { name: "reports" }).closest("tr")!;
    expect(
      within(reportsRow)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["5K", "1K", "800", "4", "10", "3", "3"]);

    // Clicking a caller name jumps straight to that caller's tab.
    await userEvent.click(within(table).getByRole("button", { name: "reports" }));
    await screen.findByText("nightly summaries");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/usage/gateway?period=30d&caller=reports", expect.anything());
  });

  it("uses a NativeSelect caller picker beside Rei and All when there are more than 5 outside callers", async () => {
    const callers: UsageCallersResponse = {
      available: true,
      callers: ["c1", "c2", "c3", "c4", "c5", "c6"].map((id) => ({
        id,
        note: "",
        scopes: ["models"],
        revokedAt: null,
        lastUsedAt: Date.now(),
      })),
    };
    const fetchMock = mockUsageFetch(response(), callers, (url) =>
      json(
        callerUsageResponse({
          caller: {
            id: url.searchParams.get("caller") ?? "c1",
            note: "",
            scopes: ["models"],
            revokedAt: null,
            lastUsedAt: Date.now(),
          },
        }),
      ),
    );
    setup(fetchMock);
    const tablist = await screen.findByRole("tablist", { name: "Usage caller" });
    expect(
      within(tablist)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Rei", "All"]);
    const picker = screen.getByRole("combobox", { name: "Outside caller" });
    fireEvent.change(picker, { target: { value: "c4" } });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith("/api/usage/gateway?period=30d&caller=c4", expect.anything()),
    );
  });
});
