import { afterEach, describe, expect, it } from "vitest";
import { requestItemHashes } from "../src/pi/steps.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, say, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

describe("prompt prefix reuse", () => {
  it("hashes what is outside the item list first, then each item", async () => {
    const a = (await requestItemHashes({ model: "m", tools: [1], input: [{ x: 1 }, { y: 2 }] }))!;
    const b = (await requestItemHashes({ model: "m", tools: [1], input: [{ x: 1 }, { y: 3 }, { z: 4 }] }))!;
    expect(a).toHaveLength(3);
    expect(b[0]).toBe(a[0]);
    expect(b[1]).toBe(a[1]);
    expect(b[2]).not.toBe(a[2]);
    expect((await requestItemHashes({ model: "m", tools: [2], input: [{ x: 1 }] }))![0]).not.toBe(a[0]);
    expect(requestItemHashes("nope")).toBeUndefined();
  });

  it("records, per model call, how many leading items match the session's previous call", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await say(server, id, "first");
    await settled(server, id, 1);
    await say(server, id, "second");
    await settled(server, id, 2);
    const rows = server.host.plane.store.db.all<{ prefix_items: number | null; input_items: number }>(
      "SELECT prefix_items, input_items FROM steps WHERE session_id = ? AND type = 'llm.call' ORDER BY started_at, id",
      id,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.prefix_items).toBeNull();
    // A second turn only appends: everything the first call sent is reused.
    expect(rows[1]!.prefix_items).toBe(rows[0]!.input_items);
    expect(rows[1]!.input_items).toBeGreaterThan(rows[0]!.input_items);
    type Step = { type: string; startedAt: number; prefix?: { matched: number | null; items: number } };
    const trace = (await server.client.get(`/api/sessions/${id}/trace`)).body as { runs: { steps: Step[] }[] };
    const calls = trace.runs
      .flatMap((r) => r.steps)
      .filter((s) => s.type === "llm.call")
      .sort((a, b) => a.startedAt - b.startedAt);
    expect(calls.map((s) => s.prefix?.matched)).toEqual([null, rows[0]!.input_items]);
  });
});
