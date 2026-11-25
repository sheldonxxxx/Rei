import type { Trigger } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { TriggerFields } from "../src/triggers/spec.ts";
import { approve, pending, tool, waitPending } from "./helpers/approvals.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, say, settled } from "./helpers/sessions.ts";
import { toolResults } from "./helpers/web.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const plane = () => server!.host.plane;
const T = () => plane().triggers;
const agent = () => plane().store.defaultAgentId()!;
const start = async () => {
  server = await startSignedIn();
  await plane().events!.sources.add("my-service", "My service");
  return server;
};
const make = (over: Partial<TriggerFields> = {}): Trigger =>
  T().store.create({
    agentId: agent(),
    createdBySessionId: null,
    fields: {
      name: "Watcher",
      start: { kind: "event", source: "my-service", types: ["items.new"] },
      action: { kind: "prompt", prompt: "Look at the new item." },
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
const patch = (id: string, body: object) => server!.client.call("PATCH", `/api/triggers/${id}`, { body });

describe("event triggers: the rules", () => {
  it("an event trigger has no next run, says what it waits for and is never done", async () => {
    await start();
    const t = make({ start: { kind: "event", source: "my-service", types: ["items.new", "items.changed"] } });
    expect(t).toMatchObject({
      status: "active",
      nextRunAt: null,
      startText: "When items.new or items.changed arrives from source my-service",
    });
    expect(
      plane().store.db.get<{ next_fire_at: number | null }>("SELECT next_fire_at FROM triggers")!.next_fire_at,
    ).toBeNull();
    expect(make({ start: { kind: "event", source: "my-service", types: ["*"] } }).startText).toBe(
      "When any event arrives from source my-service",
    );
  });

  it("the page edits both kinds: schedule to event and back, pausing and resuming without a fire time", async () => {
    await start();
    const t = make({ start: { kind: "schedule", schedule: { kind: "daily", times: ["09:00"], timeZone: "UTC" } } });
    expect(T().store.get(t.id)!.nextRunAt).not.toBeNull();
    const toEvent = await patch(t.id, { start: { kind: "event", source: "my-service", types: ["a.b", "*"] } });
    expect(toEvent.status).toBe(400);
    const ok = await patch(t.id, { start: { kind: "event", source: "my-service", types: ["a.b"] } });
    expect(ok.status).toBe(200);
    expect(ok.body.trigger).toMatchObject({
      start: { kind: "event", types: ["a.b"] },
      nextRunAt: null,
      status: "active",
    });
    expect((await patch(t.id, { paused: true })).body.trigger.status).toBe("paused");
    const resumed = await patch(t.id, { paused: false });
    expect(resumed.body.trigger).toMatchObject({ status: "active", nextRunAt: null });
    const back = await patch(t.id, {
      start: { kind: "schedule", schedule: { kind: "daily", times: ["10:00"], timeZone: "UTC" } },
    });
    expect(back.body.trigger.nextRunAt).not.toBeNull();
    expect(back.body.trigger.start.kind).toBe("schedule");
  });

  it("refuses an unknown source, bad or too many types, and settings that only mean something for a schedule", async () => {
    await start();
    const t = make();
    const bad: [object, RegExp][] = [
      [{ start: { kind: "event", source: "nobody", types: ["a.b"] } }, /no event source "nobody".*my-service/],
      [{ start: { kind: "event", source: "my-service", types: [] } }, /1 to 10/],
      [
        { start: { kind: "event", source: "my-service", types: Array.from({ length: 11 }, (_, i) => `t.n${i}`) } },
        /1 to 10/,
      ],
      [{ start: { kind: "event", source: "my-service", types: ["Bad Type"] } }, /lowercase/],
      [{ start: { kind: "event", source: "my-service", types: ["*", "a.b"] } }, /alone/],
      [{ start: { kind: "weekly" } }, /start\/kind/],
      [{ overlap: "queue" }, /schedules only/],
      [{ latenessMinutes: 5 }, /schedules only/],
    ];
    for (const [body, message] of bad) {
      const res = await patch(t.id, body);
      expect([JSON.stringify(body), res.status, res.body.error?.message]).toEqual([
        JSON.stringify(body),
        400,
        expect.stringMatching(message),
      ]);
    }
    expect(T().store.get(t.id)!.startText).toBe("When items.new arrives from source my-service");
  });

  it("removing a source with --force pauses the triggers that listened to it", async () => {
    await start();
    const t = make();
    expect(() => plane().events!.sources.remove("my-service", false)).toThrow(/Watcher/);
    plane().events!.sources.remove("my-service", true);
    expect(T().store.get(t.id)).toMatchObject({ status: "paused" });
  });

  it("deduplicates types and keeps their order", async () => {
    await start();
    const res = await patch(make().id, {
      start: { kind: "event", source: "my-service", types: ["b.x", "a.y", "b.x"] },
    });
    expect(res.body.trigger.start.types).toEqual(["b.x", "a.y"]);
  });
});

describe("event triggers: the agent's tools", () => {
  const draft = {
    name: "On new items",
    start: { kind: "event", source: "my-service", types: ["items.new"] },
    action: { kind: "prompt", prompt: "Look up the item and tell me if it matters." },
  };

  it("create_trigger shows a card with the start in words and no run times, and creates it when approved", async () => {
    await start();
    const id = await chat(server!);
    await say(server!, id, tool("create_trigger", draft));
    const [a] = await waitPending(server!, id, 1);
    expect(a!.preview).toMatchObject({
      kind: "trigger",
      op: "create",
      startText: "When items.new arrives from source my-service",
      nextRuns: [],
    });
    await approve(server!, id);
    expect(T().store.list()).toMatchObject([{ name: "On new items", start: { kind: "event", source: "my-service" } }]);
  });

  it("refuses a source that does not exist, naming the ones that do, with no card", async () => {
    await start();
    const id = await chat(server!);
    await say(
      server!,
      id,
      tool("create_trigger", { ...draft, start: { kind: "event", source: "ghost", types: ["a.b"] } }),
    );
    await settled(server!, id);
    expect(await pending(server!)).toEqual([]);
    expect(toolResults(server!, id).at(-1)!.text).toMatch(/Not done: .*ghost.*my-service/);
  });

  it("list_triggers shows the start and the sources with the types each has sent", async () => {
    await start();
    make();
    plane().store.db.run(
      "INSERT INTO events (id, source, webhook_id, type, ref, received_at) VALUES ('e1', 'my-service', 'w1', 'items.new', 'r', ?)",
      server!.clock.now(),
    );
    const id = await chat(server!);
    await say(server!, id, tool("list_triggers"));
    await settled(server!, id);
    const text = toolResults(server!, id).at(-1)!.text;
    expect(text).toContain("When items.new arrives from source my-service");
    expect(text).toContain("It starts when a matching event arrives.");
    expect(text).toMatch(/my-service: types seen lately: items\.new/);
  });

  it("update_trigger can move a trigger to events", async () => {
    await start();
    const t = make({ start: { kind: "schedule", schedule: { kind: "daily", times: ["09:00"], timeZone: "UTC" } } });
    const id = await chat(server!);
    await say(
      server!,
      id,
      tool("update_trigger", { id: t.id, start: { kind: "event", source: "my-service", types: ["*"] } }),
    );
    const [a] = await waitPending(server!, id, 1);
    expect(a!.preview).toMatchObject({
      startText: "When any event arrives from source my-service",
      before: { startText: "Every day at 09:00 (UTC)" },
    });
    await approve(server!, id);
    expect(T().store.get(t.id)).toMatchObject({ start: { kind: "event" }, nextRunAt: null });
  });
});
