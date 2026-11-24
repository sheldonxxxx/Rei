// Exercise the actual installed Pi OpenAI Responses tool parser, using only a local fake gateway.
import { afterEach, expect, it } from "vitest";
import { until } from "./helpers/client.ts";
import { type FakeGateway, startFakeGateway } from "./helpers/fake-gateway.ts";
import { STANDIN, startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";

let gateway: FakeGateway | undefined;
let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  await gateway?.close();
  server = undefined;
  gateway = undefined;
});

it("automatically completes a private native Pi tool-call repair after five chats, while titles and daily Usage remain intact", async () => {
  const reviews: any[] = [];
  gateway = await startFakeGateway({
    bearer: STANDIN,
    behavior: (seen) => ({
      kind: "text",
      text: seen.raw.includes("You write titles for chats") ? "Tea preferences" : "Understood.",
    }),
  });
  const fakeFetch: typeof fetch = async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const tools = [
      ...(body?.tools ?? []),
      ...(body?.input ?? []).filter((m: any) => m.type === "additional_tools").flatMap((m: any) => m.tools ?? []),
    ];
    if (!tools.some((t: any) => t.name === "update_memory")) {
      expect(JSON.stringify(tools)).not.toContain("update_memory");
      return fetch(url, init);
    }
    reviews.push(body);
    expect(
      tools
        .map((t: { name?: string }) => t.name)
        .filter(Boolean)
        .sort(),
    ).toEqual(["finish_review", "update_memory"]);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + STANDIN);
    const initial = body.input
      .flatMap((m: { content?: { text?: string }[] }) => (Array.isArray(m.content) ? m.content : []))
      .find((c: { text?: string }) => c.text?.startsWith('{"purpose":"memory.review"'));
    const data = JSON.parse(initial.text);
    expect(data.sources).toHaveLength(5);
    expect(data.sources.every((s: any) => s.text.includes("jasmine tea"))).toBe(true);
    expect(JSON.stringify(data)).not.toContain("Understood."); // assistant output is never preference evidence
    const sourceMessageId = data.sources[4].sourceMessageId;
    const changes =
      reviews.length === 1
        ? ["漢", "字"].map((c) => ({ op: "add", doc: "agent", text: c.repeat(490), sourceMessageId }))
        : [{ op: "add", doc: "profile", text: "Prefers jasmine tea.", sourceMessageId }];
    if (reviews.length === 2) expect(JSON.stringify(body.input)).toContain("OVER_BUDGET");
    const args = JSON.stringify({ changes });
    const item = {
      type: "function_call",
      id: "fc-review",
      call_id: "call-review",
      name: "update_memory",
      arguments: args,
      status: "completed",
    };
    const base = {
      id: "response-review-" + reviews.length,
      object: "response",
      model: body.model,
      status: "in_progress",
      output: [],
    };
    const events = [
      { type: "response.created", response: base },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: args },
      { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: args },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          ...base,
          status: "completed",
          output: [item],
          usage: {
            input_tokens: 30,
            output_tokens: 12,
            total_tokens: 42,
            input_tokens_details: { cached_tokens: 6 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ];
    return new Response(events.map((e) => "event: " + e.type + "\ndata: " + JSON.stringify(e) + "\n\n").join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  };
  server = await startSignedIn({ gatewayUrl: gateway.url, fetchImpl: fakeFetch, titles: true });
  // Memory extraction is optional (off by default): this test is about the review, so it turns the setting on.
  await server.client.call("PUT", "/api/settings/memory-extraction", { body: { enabled: true } });
  const id = await chat(server);
  for (let i = 0; i < 5; i++) {
    await say(server, id, "I prefer jasmine tea, reminder " + i);
    await settled(server, id, i + 1);
    if (i < 4) expect(reviews).toHaveLength(0);
  }
  const store = server.host.plane.store;
  await until(
    () => store.db.get("SELECT 1 FROM background_jobs WHERE kind='memory.review'"),
    10000,
    "private review scheduled",
  );
  await server.host.plane.memoryMaintenance.settle();
  expect(
    store.db.all("SELECT status, diagnostic FROM background_jobs WHERE kind='memory.review'"),
    JSON.stringify({
      reviews: reviews.length,
      calls: gateway.seen.map((c) => ({ model: c.json.model, tools: c.json.tools?.map((t: any) => t.name ?? t.type) })),
      steps: store.db.all("SELECT status, error_code FROM steps WHERE usage_purpose = 'memory'"),
    }),
  ).toEqual([{ status: "succeeded", diagnostic: null }]);
  expect(reviews).toHaveLength(2);
  const origin = store.db.get<{ model: string; provider: string }>(
    "SELECT model, provider FROM steps WHERE run_id = json_extract((SELECT payload FROM background_jobs WHERE kind='memory.review'),'$.sourceRunId') AND type = 'llm.call' ORDER BY started_at DESC, rowid DESC LIMIT 1",
  )!;
  expect(reviews.map((r) => r.model)).toEqual([origin.model, origin.model]);
  expect(server.host.plane.memory.lines.lines("profile", null).map((l) => l.text)).toEqual(["Prefers jasmine tea."]);
  const d = await detail(server, id);
  expect(d.messages.filter((m) => m.role === "memory")).toHaveLength(1);
  expect(d.messages.filter((m) => m.role === "assistant")).toHaveLength(5);
  await until(
    async () => ((await detail(server!, id)).session.title === "Tea preferences" ? true : undefined),
    10000,
    "title completion",
  );
  expect(gateway.seen.some((c) => c.raw.includes("You write titles for chats"))).toBe(true);
  const usage = store.db.get<{ calls: number; cached: number; input: number }>(
    "SELECT SUM(calls_reported) AS calls, SUM(input_cached) AS cached, SUM(input_total) AS input FROM usage_daily WHERE purpose = 'memory'",
  )!;
  expect(usage).toEqual({ calls: 2, cached: 12, input: 60 });
  expect(store.db.all("SELECT session_id, run_id FROM steps WHERE usage_purpose = 'memory'")).toEqual([]);
  const review = store.db.get<{ result: string }>(
    "SELECT result FROM background_jobs WHERE kind='memory.review' AND status='succeeded'",
  )!;
  const changeId = (JSON.parse(review.result) as { changeIds: string[] }).changeIds[0]!;
  expect((await server.client.post(`/api/memory/changes/${changeId}/undo`, {})).status).toBe(200);
  const undone = await detail(server, id);
  expect(undone.messages.find((m) => m.role === "memory")?.memory?.review?.undoneCount).toBe(1);
});
