import type { EntryRecord } from "@earendil-works/pi-durable";
import type { SessionEvent } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { buildView } from "../src/conversation/view-model.ts";
import { viewSseResponse } from "../src/http/sse.ts";
import { tool } from "./helpers/approvals.ts";
import { SseReader, until, ViewReader } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

describe("the Conversation View over HTTP", () => {
  it("keeps a memory card with its source turn when the latest window moves past it", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const views = server.host.plane.adapter.views;
    await say(server, id, tool("memory_add", { text: "Prefers aisle seats" }));
    const saved = await settled(server, id);
    expect(saved.messages.map((m) => m.role)).toEqual(["user", "assistant", "memory"]);
    const chip = saved.messages[2]!;

    await say(server, id, "Hello [len=8]");
    await settled(server, id, 2);
    const newest = await views.view(id, { limit: 2 });
    expect(newest.before).not.toBeNull();
    expect(newest.items.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(newest.overlays).toEqual([]);

    const older = await server.client.get(`/api/sessions/${id}/transcript?before=${newest.before}`);
    expect(older.status).toBe(200);
    expect(older.body.items.map((m: { id: string }) => m.id)).toEqual(saved.messages.map((m) => m.id));
    expect(older.body.items.at(-1)).toEqual(chip);
  });

  it("resending a requestId returns the same run and starts no second one", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const first = await say(server, id, "Hello", "req-same");
    const again = await say(server, id, "Hello", "req-same");
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.runId).toBe(first.body.runId);
    const d = await settled(server, id);
    expect(d.runs).toHaveLength(1);
    expect(d.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("pages older items through /transcript once a chat is past one window", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    // The stream stays open throughout: its window slides past 100 entries from incremental reads.
    const stream = new ViewReader(
      new SseReader(await server.client.raw("GET", `/api/sessions/${id}/stream`), `/api/sessions/${id}/stream`),
    );
    for (let i = 0; i < 55; i++) {
      await say(server, id, `m${i} [len=8]`);
      // The newest window holds only the runs it shows, so wait for this message's reply rather than a run count.
      await until(async () => {
        const v = await detail(server!, id);
        const last = v.messages.at(-1);
        return last?.role === "assistant" && last.status === "complete" && v.messages.at(-2)?.text === `m${i} [len=8]`
          ? true
          : undefined;
      });
    }
    const d = (await server.client.get(`/api/sessions/${id}`)).body;
    expect(d.messages.length).toBeLessThanOrEqual(100);
    // The stream's window is the one a fresh read gives.
    const streamed = await stream.waitForView(
      (v) => v.items.map((m) => m.id).join() === d.messages.map((m: { id: string }) => m.id).join(),
      5_000,
      "the streamed window to match a fresh read",
    );
    expect(streamed.before).toBe(d.before);
    await stream.sse.close();
    expect(d.before).not.toBeNull();
    const seen = [...d.messages];
    let before: string | null = d.before;
    while (before !== null) {
      const page = await server.client.get(
        `/api/sessions/${id}/transcript?before=${encodeURIComponent(before)}&limit=20`,
      );
      expect(page.status).toBe(200);
      seen.unshift(...page.body.items);
      before = page.body.before;
    }
    const users = seen.filter((m: { role: string }) => m.role === "user").map((m: { text: string }) => m.text);
    expect(users).toEqual(Array.from({ length: 55 }, (_, i) => `m${i} [len=8]`));
    expect(new Set(seen.map((m: { id: string }) => m.id)).size).toBe(seen.length);
    expect((await server.client.get(`/api/sessions/${id}/transcript`)).status).toBe(400);
  }, 60_000);

  it("shows a failed run with Continue, and continuing answers it", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await say(server, id, "break please [error-once]");
    const failed = await until(async () => {
      const v = (await server!.client.get(`/api/sessions/${id}`)).body;
      return v.live?.runFailure ? v : undefined;
    });
    expect(failed.runs[0].status).toBe("failed");
    expect(failed.live.runFailure).toMatchObject({ canContinue: true });
    const res = await server.client.post(`/api/sessions/${id}/continue`, {});
    expect(res.status).toBe(200);
    expect(typeof res.body.runId).toBe("string");
    const d = await settled(server, id, 2);
    expect(d.runs.map((r) => r.status)).toEqual(["failed", "completed"]);
    // The failed run's trace says it was continued, so a client does not present the failure as the outcome.
    const traced = (await server.client.get(`/api/sessions/${id}/trace`)).body.runs;
    expect(traced.map((t: { run: { status: string }; continued?: true }) => [t.run.status, t.continued])).toEqual([
      ["completed", undefined],
      ["failed", true],
    ]);
    const reply = d.messages.find((m) => m.role === "assistant");
    expect(reply?.text).toMatch(/^Echo: break please/);
    expect((await server.client.get(`/api/sessions/${id}`)).body.live.runFailure).toBeUndefined();

    // A tool in Continue records the new run id, while the reply still belongs to the original input.
    const continueRunId = res.body.runId;
    server.host.plane.memory.lines.add(
      { doc: "profile", text: "Prefers aisle seats" },
      { by: "agent", sessionId: id, chip: { sessionId: id, runId: continueRunId } },
    );
    await say(server, id, "Next question");
    const next = await settled(server, id, 3);
    expect(next.messages.map((m) => m.role)).toEqual(["user", "assistant", "memory", "user", "assistant"]);
    expect(next.messages[1]?.id).toBe(reply?.id);
    expect(next.messages[2]?.runId).toBe(continueRunId);
  });

  it("a queued message withdrawn by Stop stays in the chat as cancelled, with no reply", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await say(server, id, "long one [len=20000]");
    await until(async () => ((await detail(server!, id)).runs[0]?.status === "running" ? true : undefined));
    await say(server, id, "queued behind it");
    expect((await server.client.post(`/api/sessions/${id}/cancel`, {})).status).toBe(200);
    const d = await settled(server, id, 2);
    expect(d.runs.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    const queued = d.messages.find((m) => m.role === "user" && m.text === "queued behind it");
    expect(queued).toMatchObject({ status: "aborted" });
    expect(queued?.editable).toBeUndefined();
    expect(d.messages.filter((m) => m.role === "assistant" && m.runId === queued!.runId)).toHaveLength(0);
  });
});

describe("the view model", () => {
  it("shows Pi's compaction and reset entries as their own items", () => {
    const entries = [
      { id: 1, conversationId: "c", kind: "pi.compaction", data: { summary: "x" } },
      { id: 2, conversationId: "c", kind: "pi.reset", data: {} },
    ] as unknown as EntryRecord[];
    const view = buildView({
      sessionId: "ses_1",
      origin: "user",
      entries,
      before: undefined,
      live: undefined,
      inbox: undefined,
      runs: new Map(),
      order: [],
      queued: new Map(),
      files: new Map(),
      overlays: [],
      newest: true,
    });
    expect(view.items.map((i) => [i.id, i.role])).toEqual([
      ["e:1", "compaction"],
      ["e:2", "reset"],
    ]);
  });
});

describe("the session stream", () => {
  it("replaces patches with resync_required when the client falls behind", async () => {
    let push: ((event: SessionEvent) => void) | undefined;
    const res = viewSseResponse({
      subscribe: async (send) => {
        push = send;
        return () => {};
      },
      pingMs: 60_000,
    });
    const reader = res.body!.getReader();
    await until(() => push);
    // Nothing reads while far more than a socket buffer's worth of patches is queued.
    for (let rev = 1; rev <= 2_500; rev++) push!({ type: "patch", epoch: "e", rev, ops: [] } as never);
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes("resync_required")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain("event: resync_required");
    await reader.cancel();
  });
});
