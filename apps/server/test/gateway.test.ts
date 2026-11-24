import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Message, Run } from "@rei/protocol";
import { STEP_ID_HEADER, UPSTREAM_HEADER } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FolderBlobStore } from "../src/node/blob-store.ts";
import { until } from "./helpers/client.ts";
import { type FakeGateway, startFakeGateway } from "./helpers/fake-gateway.ts";
import { STANDIN, startSignedIn, type TestServer } from "./helpers/server.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
let gateway: FakeGateway | undefined;
afterEach(async () => {
  await server?.destroy();
  await gateway?.close();
  server = undefined;
  gateway = undefined;
});

type Detail = { session: { status: string }; messages: Message[]; runs: Run[] };
const ask = async (s: TestServer, text: string) => {
  const chat = (await s.client.post("/api/sessions", {})).body.session;
  const sent = await s.client.post(`/api/sessions/${chat.id}/messages`, { requestId: crypto.randomUUID(), text });
  const settled = () =>
    until(
      async () => {
        const d = (await s.client.get(`/api/sessions/${chat.id}`)).body as Detail;
        return d.runs.length > 0 && d.runs.every((r) => !["queued", "running"].includes(r.status)) ? d : undefined;
      },
      20_000,
      "run to settle",
    );
  return { chat, sent: sent.body as { runId: string; messageId: string }, settled };
};

const steps = (s: TestServer) =>
  s.host.plane.store.db.all<Record<string, any>>("SELECT * FROM steps ORDER BY started_at");
const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });

describe("model calls through the gateway", () => {
  it("sends the stand-in, the step id and the upstream URL, and records the payload byte for byte", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: () => ({ kind: "text", text: "Pong from the fake gateway." }),
    });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const { settled, sent } = await ask(server, "ping through the gateway");
    const d = await settled();
    expect(d.runs[0]!.status).toBe("completed");
    expect(d.messages.find((m) => m.role === "assistant")?.text).toBe("Pong from the fake gateway.");

    expect(gateway.seen).toHaveLength(1);
    const seen = gateway.seen[0]!;
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/v1/responses");
    expect(seen.headers.authorization).toBe(`Bearer ${STANDIN}`);
    expect(seen.headers[UPSTREAM_HEADER]).toBe("https://api.openai.com/v1/responses");
    const stepId = seen.headers[STEP_ID_HEADER] as string;
    expect(stepId).toMatch(/^stp_/);

    const rows = steps(server).filter((r) => r.type === "llm.call");
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(stepId);
    expect(row.run_id).toBe(sent.runId);
    expect(row.side_effect).toBe(0);
    expect(row.status).toBe("ok");
    expect(row.input_tokens).toBe(11);
    expect(row.output_tokens).toBe(7);
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    expect(row.pi_entry_id).toBeTruthy();

    // The captured payload is exactly the bytes the gateway received.
    const blobs = new FolderBlobStore(join(server.dir, "blobs"));
    const bytes = await blobs.get(row.payload_blob);
    expect(bytes).toBeDefined();
    expect(Buffer.from(bytes!).toString("utf8")).toBe(seen.raw);
  });

  it("re-reads the stand-in file for every call", async () => {
    gateway = await startFakeGateway({ bearer: STANDIN });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const first = await ask(server, "one");
    await first.settled();
    expect(gateway.seen.at(-1)!.bearerOk).toBe(true);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(server.dir, "standin.txt"), "a-different-standin-value-0123456789\n");
    const second = await ask(server, "two");
    const d = await second.settled();
    expect(gateway.seen.at(-1)!.headers.authorization).toBe("Bearer a-different-standin-value-0123456789");
    expect(d.runs[0]!.status).toBe("failed");
    expect(d.runs[0]!.error?.code).toBe("gateway_auth");
  });

  it("maps a gateway 429 and 5xx to readable errors", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: () => ({
        kind: "status",
        status: 429,
        body: JSON.stringify({ error: { code: "usage_limit_reached", message: "Your plan is used up." } }),
      }),
    });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const r = await (await ask(server, "limit?")).settled();
    expect(r.runs[0]!.status).toBe("failed");
    expect(r.runs[0]!.error?.code).toBe("usage_limit");
    expect(JSON.stringify(r)).not.toContain(STANDIN);
  });

  it("fails with gateway_unavailable when nothing listens, and recovers when it comes back", async () => {
    gateway = await startFakeGateway({ bearer: STANDIN });
    const url = gateway.url;
    const port = gateway.port;
    await gateway.close();
    server = await startSignedIn({ gatewayUrl: url });
    const down = await (await ask(server, "anyone there?")).settled();
    expect(down.runs[0]!.status).toBe("failed");
    expect(down.runs[0]!.error?.code).toBe("gateway_unavailable");
    expect(down.messages.find((m) => m.role === "assistant")?.error?.code).toBe("gateway_unavailable");
    const failedStep = steps(server).find((r) => r.type === "llm.call");
    expect(failedStep?.error_code).toBe("gateway_unavailable");

    // Same port again.
    const { createServer } = await import("node:http");
    const revived = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const base = { id: "r", object: "response", model: "m", status: "in_progress", output: [] };
        const w = (e: string, d: unknown) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
        w("response.created", { type: "response.created", response: base });
        w("response.output_item.added", {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "m0", role: "assistant", status: "in_progress", content: [] },
        });
        w("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: "m0",
          output_index: 0,
          content_index: 0,
          delta: "back",
        });
        const item = {
          type: "message",
          id: "m0",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "back", annotations: [] }],
        };
        w("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
        w("response.completed", {
          type: "response.completed",
          response: {
            ...base,
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        });
        res.end();
      });
    });
    await new Promise<void>((r) => revived.listen(port, "127.0.0.1", r));
    try {
      const up = await (await ask(server, "and now?")).settled();
      expect(up.runs[0]!.status).toBe("completed");
    } finally {
      await new Promise<void>((r) => revived.close(() => r()));
    }
  });
});

describe("deadlines", () => {
  const models = (extra: Record<string, number>) => ({
    fast: { model: "gpt-6-luna", ...extra },
    standard: { model: "gpt-6.1-sol", ...extra },
    deep: { model: "gpt-6.1-sol", ...extra },
  });

  it("fails with deadline_exceeded when the first event never comes", async () => {
    gateway = await startFakeGateway({ bearer: STANDIN, behavior: () => ({ kind: "stall_first" }) });
    server = await startSignedIn({
      gatewayUrl: gateway.url,
      modelsJson: models({ firstEventMs: 700, idleMs: 5_000, totalMs: 20_000 }),
    });
    const started = Date.now();
    const d = await (await ask(server, "hello?")).settled();
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(d.runs[0]!.status).toBe("failed");
    expect(d.runs[0]!.error?.code).toBe("deadline_exceeded");
    expect(d.messages.find((m) => m.role === "assistant")?.error?.code).toBe("deadline_exceeded");
    expect(steps(server).find((r) => r.type === "llm.call")?.error_code).toBe("deadline_exceeded");
  });

  it("fails with deadline_exceeded when the response headers never come", async () => {
    gateway = await startFakeGateway({ bearer: STANDIN, behavior: () => ({ kind: "hang_headers" }) });
    server = await startSignedIn({
      gatewayUrl: gateway.url,
      modelsJson: models({ firstEventMs: 700, idleMs: 5_000, totalMs: 20_000 }),
    });
    const d = await (await ask(server, "hello?")).settled();
    expect(d.runs[0]!.error?.code).toBe("deadline_exceeded");
  });

  it("fails with deadline_exceeded when the stream stalls mid-reply, keeping the partial text", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: () => ({ kind: "stall_mid", text: "Half an answer" }),
    });
    server = await startSignedIn({
      gatewayUrl: gateway.url,
      modelsJson: models({ firstEventMs: 5_000, idleMs: 700, totalMs: 20_000 }),
    });
    const d = await (await ask(server, "tell me")).settled();
    expect(d.runs[0]!.status).toBe("failed");
    expect(d.runs[0]!.error?.code).toBe("deadline_exceeded");
    const reply = d.messages.find((m) => m.role === "assistant")!;
    expect(reply.status).toBe("error");
    expect(reply.text).toBe("Half an answer");
  });

  it("applies the per-call cap", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: () => ({ kind: "text", text: "x".repeat(400), chunkDelayMs: 150 }),
    });
    server = await startSignedIn({
      gatewayUrl: gateway.url,
      modelsJson: models({ firstEventMs: 5_000, idleMs: 5_000, totalMs: 800 }),
    });
    const d = await (await ask(server, "slow")).settled();
    expect(d.runs[0]!.error?.code).toBe("deadline_exceeded");
  });

  it("does not retry a deadline or an outage inside Pi", async () => {
    gateway = await startFakeGateway({ bearer: STANDIN, behavior: () => ({ kind: "stall_first" }) });
    server = await startSignedIn({
      gatewayUrl: gateway.url,
      modelsJson: models({ firstEventMs: 400, idleMs: 5_000, totalMs: 20_000 }),
      config: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 50, maxAgentDelayMs: 100 } },
    });
    const d = await (await ask(server, "hello?")).settled();
    expect(d.runs[0]!.error?.code).toBe("deadline_exceeded");
    expect(gateway.seen).toHaveLength(1);
  });
});

describe("secrets", () => {
  it("never writes the stand-in anywhere but its own file, even when an upstream error echoes it", async () => {
    let echo = false;
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: (seen) =>
        echo
          ? {
              kind: "status",
              status: 500,
              body: JSON.stringify({ error: { message: `upstream saw ${seen.headers.authorization} and ${STANDIN}` } }),
            }
          : { kind: "text", text: "fine" },
    });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const ok = await (await ask(server, "hello")).settled();
    expect(ok.runs[0]!.status).toBe("completed");
    echo = true;
    const bad = await (await ask(server, "and again")).settled();
    expect(bad.runs[0]!.status).toBe("failed");
    expect(JSON.stringify(bad)).not.toContain(STANDIN);
    await server.stop();
    const hits: string[] = [];
    for (const file of filesUnder(server.dir)) {
      if (file.endsWith("standin.txt")) continue;
      if (readFileSync(file).toString("latin1").includes(STANDIN)) hits.push(file);
    }
    for (const line of server.logs) if (line.includes(STANDIN)) hits.push(`log: ${line.slice(0, 80)}`);
    expect(hits).toEqual([]);
  });
});
