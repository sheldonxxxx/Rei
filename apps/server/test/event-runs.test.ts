import type { Trigger } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { briefOf } from "../src/triggers/runner.ts";
import type { TriggerFields } from "../src/triggers/spec.ts";
import { tool } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { eventBody, eventSender } from "./helpers/events.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { detail } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const plane = () => server!.host.plane;
const T = () => plane().triggers;
const agent = () => plane().store.defaultAgentId()!;
let n = 0;
const make = (over: Partial<TriggerFields> = {}): Trigger =>
  T().store.create({
    agentId: agent(),
    createdBySessionId: null,
    fields: {
      name: `Watcher ${++n}`,
      start: { kind: "event", source: "my-service", types: ["items.new"] },
      action: { kind: "notify", message: "Something new" },
      landing: "new",
      report: "on_change",
      hideInList: true,
      latenessMinutes: 120,
      catchUp: "once",
      overlap: "skip",
      profile: "standard",
      allow: [],
      ...over,
    },
  });
const runsOf = (id: string) => T().store.runsOfTrigger(id);
/** An action that stays running: a send asks at Standard, and nobody answers. */
const BLOCKING: TriggerFields["action"] = {
  kind: "prompt",
  prompt: tool("demo_send_message", { to: "sam", text: "x" }),
};
const start = async () => {
  server = await startSignedIn();
  return eventSender(server);
};
const homeTexts = async (): Promise<string[]> => {
  await T().runner.idle();
  await plane().adapter.writesSettled();
  const home = plane().store.getAgent(agent())!.homeSessionId!;
  return (await detail(server!, home)).messages.flatMap((m) =>
    m.role === "trigger" && m.trigger ? [m.trigger.text] : [],
  );
};

describe("event runs", () => {
  it("an event starts a run with that event, and counts the runs it made", async () => {
    const { send } = await start();
    const t = make();
    const res = await send({ id: "e1", body: eventBody("items.new", "item_42") });
    expect(res.status).toBe(202);
    const runs = runsOf(t.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", manual: 0 });
    expect(T().store.runEvents(runs[0]!.id)).toMatchObject([{ type: "items.new", ref: "item_42" }]);
    expect(plane().store.db.get<{ runs: number }>("SELECT runs FROM events WHERE webhook_id = 'e1'")!.runs).toBe(1);
    expect(await homeTexts()).toEqual(["Something new"]);
    expect(T().store.get(t.id)!.lastRun).toMatchObject({ events: [{ ref: "item_42" }], droppedEvents: 0 });
  });

  it("ignores other types, other sources, paused triggers and duplicates; * takes every type", async () => {
    const { send } = await start();
    const some = make();
    const all = make({ start: { kind: "event", source: "my-service", types: ["*"] } });
    const paused = make();
    T().store.setPaused(paused.id, true, "user", { log: false });
    const other = make({ start: { kind: "event", source: "my-service", types: ["items.changed"] } });
    await send({ id: "a", body: eventBody("items.new", "x") });
    await send({ id: "a", body: eventBody("items.new", "x") });
    await send({ id: "b", body: eventBody("items.gone", "y") });
    expect(runsOf(some.id)).toHaveLength(1);
    expect(runsOf(all.id)).toHaveLength(2);
    expect(runsOf(paused.id)).toHaveLength(0);
    expect(runsOf(other.id)).toHaveLength(0);
    expect(
      plane()
        .store.db.all<{ runs: number }>("SELECT runs FROM events ORDER BY received_at, id")
        .map((r) => r.runs),
    ).toEqual([2, 1]);
  });

  it("a burst while a run is going makes exactly one waiting run holding every event", async () => {
    const { send } = await start();
    const t = make({ action: BLOCKING });
    await send({ id: "first", body: eventBody("items.new", "first") });
    await until(() => T().store.get(t.id)!.lastRun?.status === "waiting", 20_000, "the first run to wait");
    for (let i = 0; i < 5; i++) await send({ id: `b${i}`, body: eventBody("items.new", `item_${i}`) });
    const runs = runsOf(t.id);
    expect(runs.map((r) => r.status)).toEqual(["running", "queued"]);
    expect(
      T()
        .store.runEvents(runs[1]!.id)
        .map((e) => e.ref),
    ).toEqual(["item_0", "item_1", "item_2", "item_3", "item_4"]);
    expect(
      T()
        .store.runEvents(runs[0]!.id)
        .map((e) => e.ref),
    ).toEqual(["first"]);
  });

  it("a run keeps at most 20 events: the oldest are dropped and counted", async () => {
    const { send } = await start();
    const t = make({ action: BLOCKING });
    await send({ id: "first", body: eventBody("items.new", "first") });
    await until(() => T().store.get(t.id)!.lastRun?.status === "waiting", 20_000, "the first run to wait");
    for (let i = 0; i < 25; i++) await send({ id: `m${i}`, body: eventBody("items.new", `item_${i}`) });
    const queued = runsOf(t.id).find((r) => r.status === "queued")!;
    const events = T().store.runEvents(queued.id);
    expect(events).toHaveLength(20);
    expect(events[0]!.ref).toBe("item_5");
    expect(events.at(-1)!.ref).toBe("item_24");
    expect(T().store.runRow(queued.id)!.dropped_events).toBe(5);
    expect(T().store.toRunSummary(T().store.runRow(queued.id)!)).toMatchObject({ droppedEvents: 5 });
  });

  it("a retry carries the same events and the dropped count", async () => {
    const { send } = await start();
    const t = make({ action: { kind: "prompt", prompt: "[error]" } });
    await send({ id: "r1", body: eventBody("items.new", "item_retry") });
    await until(() => runsOf(t.id).length === 2, 20_000, "a retry to be made");
    const [first, retry] = runsOf(t.id);
    expect(retry).toMatchObject({ attempt: 1, scheduled_at: first!.scheduled_at });
    expect(T().store.runEvents(retry!.id)).toEqual(T().store.runEvents(first!.id));
    expect(
      T()
        .store.runEvents(retry!.id)
        .map((e) => e.ref),
    ).toEqual(["item_retry"]);
  });

  it("Run now on an event trigger starts a run with no events; while one is going it waits", async () => {
    await start();
    const t = make({ action: BLOCKING });
    const a = await server!.client.post(`/api/triggers/${t.id}/run`, {});
    expect(a.body.run).toMatchObject({ manual: true, status: "running", events: [], droppedEvents: 0 });
    await until(() => T().store.get(t.id)!.lastRun?.status === "waiting", 20_000, "the run to wait");
    const b = await server!.client.post(`/api/triggers/${t.id}/run`, {});
    expect(b.body.run).toMatchObject({ manual: true, status: "queued", events: [] });
  });

  it("deleting the trigger removes its run events", async () => {
    const { send } = await start();
    const t = make();
    await send({ body: eventBody("items.new", "gone") });
    T().store.remove(t.id);
    expect(plane().store.db.get("SELECT 1 AS x FROM trigger_run_events")).toBeUndefined();
  });
});

describe("the brief", () => {
  const prompt = { kind: "prompt", prompt: "Look at it." } as const;
  const ev = (ref: string, type = "items.new") => ({ id: ref, type, ref, receivedAt: 1_700_000_000_000 });
  it("is unchanged for a schedule", () => {
    expect(briefOf(prompt)).toBe("Look at it.");
  });
  it("lists the events, tells of dropped ones, and says when there were none", () => {
    expect(briefOf(prompt, { source: "my-service", events: [ev("a"), ev("b")], dropped: 3 })).toMatch(
      /Look at it\.\n\nStarted by 2 events from "my-service"[^\n]*\n- items\.new: a \(2023-11-14T22:13:20\.000Z\)\n- items\.new: b[^\n]*\n3 earlier events were dropped/,
    );
    expect(briefOf(prompt, { source: "my-service", events: [], dropped: 0 })).toBe(
      "Look at it.\n\nStarted by hand; no event.",
    );
    expect(briefOf(prompt, { source: "my-service", events: [ev("a")], dropped: 0 })).toMatch(
      /Started by an event from/,
    );
  });
});

describe("the read-only views", () => {
  it("GET /api/event-sources lists sources with last event and types, and never a secret", async () => {
    const { send, secret } = await start();
    await send({ body: eventBody("items.new", "a") });
    await send({ body: eventBody("items.changed", "b") });
    const res = await server!.client.get("/api/event-sources");
    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual([
      expect.objectContaining({
        id: "my-service",
        status: "active",
        types: ["items.changed", "items.new"],
        lastEventAt: expect.any(Number),
      }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(Object.keys(res.body.sources[0]).sort()).toEqual(["id", "lastEventAt", "name", "status", "types"]);
  });

  it("a trigger carries the time of its newest event", async () => {
    const { send } = await start();
    const t = make();
    expect(T().store.get(t.id)!.lastEventAt).toBeNull();
    await send({ body: eventBody("items.new", "a") });
    expect(T().store.get(t.id)!.lastEventAt).toBe(
      plane().store.db.get<{ at: number }>("SELECT MAX(received_at) AS at FROM events")!.at,
    );
  });
});
