import { expect, it } from "vitest";
import { formatResults, SNIPPET_SHOWN, searchWeb } from "../src/web/search.ts";

const answer = {
  text: "Read Vite today.",
  model: "account-model",
  searchCalls: 1,
  freshness: "research_preference",
  citations: [{ title: "Vite", url: "https://vite.dev/", start: 5, end: 9 }],
  sources: [{ title: "Vite", url: "https://vite.dev/" }],
};
it("carries a cited answer to every chat model with visible inline links and distinct source semantics", async () => {
  const response = await searchWeb(
    { query: "Vite" },
    {
      gatewayUrl: "http://gateway",
      token: "standin",
      fetchImpl: async () => Response.json({ provider: "codex-subscription", results: [], answer }),
    },
  );
  const text = formatResults("Vite", response);
  expect(text).toContain("Read [Vite](https://vite.dev/) today.");
  expect(text).toContain("Sources consulted:");
  expect(text).toContain("not a strict date filter");
  expect(text).not.toContain("No results");
});
it.each([
  { ...answer, citations: [{ ...answer.citations[0], url: "javascript:alert(1)" }] },
  { ...answer, citations: [{ ...answer.citations[0], end: 900 }] },
  { ...answer, searchCalls: 0 },
])("rejects malformed cited answers", async (value) => {
  await expect(
    searchWeb(
      { query: "Vite" },
      {
        gatewayUrl: "http://gateway",
        token: "standin",
        fetchImpl: async () => Response.json({ provider: "codex-subscription", results: [], answer: value }),
      },
    ),
  ).rejects.toThrow("invalid cited answer");
});

it("exposes ordered fallback provenance in tool results and all-provider failures", async () => {
  const attempts = [
    { provider: "codex-subscription", status: "failed", reason: "subscription_denied", totalMs: 12 },
    { provider: "exa", status: "succeeded", totalMs: 40 },
  ];
  const response = await searchWeb(
    { query: "Vite" },
    {
      gatewayUrl: "http://gateway",
      token: "standin",
      fetchImpl: async () =>
        Response.json({
          provider: "exa",
          results: [{ title: "Vite", url: "https://vite.dev", snippet: "Official website" }],
          attempts,
        }),
    },
  );
  expect(formatResults("Vite", response)).toContain("codex-subscription: failed (subscription_denied), 12 ms");
  await expect(
    searchWeb(
      { query: "Vite" },
      {
        gatewayUrl: "http://gateway",
        token: "standin",
        fetchImpl: async () =>
          Response.json(
            { error: { code: "search_unavailable", message: "No provider answered." }, attempts: attempts.slice(0, 1) },
            { status: 503 },
          ),
      },
    ),
  ).rejects.toThrow("subscription_denied");
});
it("shows the model a short snippet per result instead of the provider's page dump", () => {
  const long = `${"start ".repeat(20)}${"x".repeat(900)}`;
  const text = formatResults("q", {
    provider: "exa",
    results: [{ title: "T", url: "https://t.example", snippet: long }],
  } as Parameters<typeof formatResults>[1]);
  const shown = text.split("\n")[1]!.trim();
  expect(shown.length).toBe(SNIPPET_SHOWN);
  expect(shown.endsWith("…")).toBe(true);
  expect(text).toContain("start start");
});
