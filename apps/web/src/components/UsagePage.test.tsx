import {
  type ImageUsageResponse,
  type SearchUsageResponse,
  USAGE_METRICS,
  USAGE_PURPOSES,
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
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function setup(fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(response()))) {
  const api = createApi({ fetch: fetchMock });
  const view = render(<UsagePage api={api} />);
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

describe("UsagePage", () => {
  it("shows loading until the authenticated API request resolves, then renders inclusive metrics and real category/model rows", async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn<typeof fetch>().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    setup(fetchMock);
    expect(screen.getByRole("status", { name: "Loading usage" })).toBeTruthy();
    expect(screen.queryByText("Total input")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/usage?period=30d",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
    await act(async () => resolve(json(response())));
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
    setup(vi.fn<typeof fetch>().mockResolvedValue(json(response(totals(0)))));
    await screen.findByText("No usage recorded since tracking began");
    expect(card("Total input")).toBe("0");
    expect(card("Model calls")).toBe("0");
    expect(card("Cache hit")).toBe("Unavailable");
    expect(screen.queryByRole("region", { name: "By model usage table" })).toBeNull();
  });

  it("distinguishes a quiet selected period from all-time empty tracking", async () => {
    setup(
      vi.fn<typeof fetch>().mockResolvedValue(json({ ...response(totals(0)), from: "2026-12-01", to: "2026-12-07" })),
    );
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
    setup(vi.fn<typeof fetch>().mockResolvedValue(json(response(partial))));
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
    setup(vi.fn<typeof fetch>().mockResolvedValue(json(response(unknown))));
    await screen.findByText(/2 calls with missing/);
    for (const name of ["Total input", "Cached input", "Uncached input", "Output", "Total processed", "Cache hit"])
      expect(card(name)).toBe("Unavailable");
    expect(screen.queryByText(/No usage recorded/)).toBeNull();
  });

  it("refetches each period through the API and ignores an older response that resolves late", async () => {
    let resolveOld!: (r: Response) => void;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(
        new Promise((r) => {
          resolveOld = r;
        }),
      )
      .mockImplementation(async (url) =>
        json({
          ...response(totals(2)),
          period: new URL(String(url), "https://test.invalid").searchParams.get("period"),
        }),
      );
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
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => json(response(totals(4))));
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
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: { code: "unavailable", message: "test failure" } }, 503))
      .mockResolvedValue(json(response()));
    setup(fetchMock);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load usage");
    expect(screen.queryByText("Total input")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(card("Total input")).toBe("1K"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    setup(vi.fn<typeof fetch>().mockResolvedValue(json({ ...response(), search })));
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
    setup(vi.fn<typeof fetch>().mockResolvedValue(json({ ...response(), images })));
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
});
