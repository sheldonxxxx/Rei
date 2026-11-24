import { afterEach, describe, expect, it } from "vitest";
import { ViewReader } from "./helpers/client.ts";
import { type FakeGateway, startFakeGateway } from "./helpers/fake-gateway.ts";
import { STANDIN, startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, say, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
let gateway: FakeGateway | undefined;
afterEach(async () => {
  await server?.destroy();
  await gateway?.close();
  server = undefined;
  gateway = undefined;
});

describe("context usage snapshot", () => {
  it("reports inclusive input, output and model capacity for the latest call, with unknowns for unreported usage", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: () => ({
        kind: "text",
        text: "ok",
        usage: {
          input_tokens: 1000,
          output_tokens: 150,
          total_tokens: 1150,
          input_tokens_details: { cached_tokens: 600 },
          output_tokens_details: { reasoning_tokens: 50 },
        },
      }),
    });
    server = await startSignedIn({ gatewayUrl: gateway.url, titles: true });
    const id = await chat(server);
    const read = async () => (await server!.client.get(`/api/sessions/${id}/context`)).body;
    expect(await read()).toMatchObject({ inputTokens: null, outputTokens: null });
    await say(server, id, "Hello");
    await settled(server, id);
    const first = await read();
    expect(first).toMatchObject({ inputTokens: 1000, cachedTokens: 600, outputTokens: 150 });
    expect(first.maxTokens).toBeGreaterThan(0);
    expect(first.breakdown.method).toBe("o200k_base");
    expect(first.breakdown.categories.find((c: { id: string }) => c.id === "prompt").estimatedTokens).toBeGreaterThan(
      0,
    );
    expect(first.breakdown.categories.find((c: { id: string }) => c.id === "tools").estimatedTokens).toBeGreaterThan(0);
    expect(JSON.stringify(first.breakdown)).not.toContain("Hello");
    await say(server, id, "Again");
    await settled(server, id, 2);
    const previous = await read();
    expect(await read()).toMatchObject({ inputTokens: 1000, outputTokens: 150 });
    gateway.setBehavior(() => ({ kind: "text", text: "No counts", usage: null }));
    await say(server, id, "Last");
    await settled(server, id, 3);
    expect(await read()).toMatchObject({ inputTokens: null, cachedTokens: null, outputTokens: null });

    const stopReply = async (s: TestServer, sessionId: string, runCount: number) => {
      const stream = new ViewReader(await s.sse(`/api/sessions/${sessionId}/stream`));
      await say(s, sessionId, "Stop this reply");
      await stream.waitForView((view) =>
        view.items.some((item) => item.role === "assistant" && item.text === "Partial reply"),
      );
      expect((await s.client.post(`/api/sessions/${sessionId}/cancel`)).status).toBe(200);
      await settled(s, sessionId, runCount);
    };
    gateway.setBehavior(() => ({ kind: "stall_mid", text: "Partial reply" }));
    await stopReply(server, id, 4);
    expect(await read()).toEqual(previous);

    const fresh = await chat(server);
    await stopReply(server, fresh, 1);
    expect((await server.client.get(`/api/sessions/${fresh}/context`)).body).toMatchObject({
      maxTokens: previous.maxTokens,
      inputTokens: null,
      cachedTokens: null,
      outputTokens: null,
    });
    expect((await server.client.get("/api/sessions/missing/context")).status).toBe(404);
  });
});
