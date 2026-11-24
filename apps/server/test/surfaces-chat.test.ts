// Surfaces end to end through the faux model: shown in the reply, repaired after a refusal, changed by update_surface,
// acted on once, refused when stale or closed, frozen in a fork, and described for the Inspector.
import type { Message, Surface } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { liveSurface } from "../src/pi/faux-surfaces.ts";
import { sessionStream } from "../src/store/events.ts";
import { decide, tool, waitPending } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, childrenOf, detail, homeChat, say, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const s = (): TestServer => server!;
const talk = async (id: string, text: string) => {
  const before = (await detail(s(), id)).runs.length;
  await say(s(), id, text);
  return settled(s(), id, before + 1);
};
const surfacesOf = (m: Message | undefined): Surface[] =>
  (m?.parts ?? []).flatMap((p) => (p.type === "surface" ? [p.surface] : []));
const lastReply = (d: { messages: Message[] }) => d.messages.filter((m) => m.role === "assistant").at(-1);
const act = (
  id: string,
  surface: Pick<Surface, "surfaceId" | "revision">,
  name: string,
  sourceComponentId: string,
  dataModel: Record<string, unknown>,
  context: Record<string, unknown>,
  requestId: string = crypto.randomUUID(),
) =>
  s().client.post(`/api/sessions/${id}/surfaces/${surface.surfaceId}/actions`, {
    requestId,
    revision: surface.revision,
    dataModel,
    action: {
      version: "1.0",
      action: { name, surfaceId: surface.surfaceId, sourceComponentId, timestamp: new Date().toISOString(), context },
    },
  });

const FORM_DATA = { email: "a@b.co", travellers: "2", date: "2026-11-20", rooms: ["double"], breakfast: true };
const FORM_CONTEXT = { ...FORM_DATA };

describe("surfaces in chat", () => {
  it("/demo ui shows one surface before the reply text, with an A2UI message and a fallback", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const d = await talk(id, "/demo ui");
    const reply = lastReply(d)!;
    expect(reply.parts!.map((p) => p.type)).toEqual(["surface", "text"]);
    const [surface] = surfacesOf(reply);
    expect(surface).toMatchObject({ title: "Kyoto trip", revision: 1, state: "idle", protocolVersion: "1.0" });
    expect(surface!.message!.createSurface.catalogId).toBe("rei/catalog/1");
    expect(surface!.fallback).toContain("Gion Inn");
    // The reply text stays the model's words; the fallback carries the surface for search and copy.
    expect(reply.text).not.toContain("Gion Inn");
  });

  it("/demo ui bad: the refused call is recorded, the repaired call is shown", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const d = await talk(id, "/demo ui bad");
    const shown = surfacesOf(lastReply(d));
    expect(shown).toHaveLength(1);
    expect(shown[0]!.fallback).toContain("Osaka | 3");
    const info = await s().client.get(`/api/sessions/${id}/surfaces/${shown[0]!.surfaceId}`);
    expect(info.status).toBe(200);
    expect(info.body.failures).toHaveLength(1);
    expect(info.body.failures[0].errors.join()).toContain('"price"');
  });

  it("update_surface changes data and records a revision; the Inspector sees both", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const [first] = surfacesOf(lastReply(await talk(id, "/demo ui")));
    const args = JSON.stringify({ surfaceId: first!.surfaceId, data: [{ path: "/city", value: "Osaka" }] });
    await talk(id, `[tool: update_surface ${args}]`);
    const d = await detail(s(), id);
    const now = d.messages.flatMap(surfacesOf).find((x) => x.surfaceId === first!.surfaceId)!;
    expect(now.revision).toBe(2);
    expect(now.message!.createSurface.dataModel).toMatchObject({ city: "Osaka" });
    const info = await s().client.get(`/api/sessions/${id}/surfaces/${first!.surfaceId}`);
    expect(info.body.revisions.map((r: { revision: number }) => r.revision)).toEqual([1, 2]);
    expect(info.body.revisions[1].summary).toBe("Data /city changed");
    expect(info.body.revisions[0].dataModel.city).toBe("Kyoto");
  });

  it("a form is submitted once: the action becomes the next input, and a repeat has no second effect", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const [form] = surfacesOf(lastReply(await talk(id, "/demo form")));
    const res = await act(id, form!, "submit_trip", "root", FORM_DATA, FORM_CONTEXT, "req-1");
    expect(res.status).toBe(200);
    const d = await settled(s(), id, 2);
    const input = d.messages.find((m) => m.id === res.body.messageId)!;
    expect(input.text).toBe(
      'Submitted "Trip details": email: a@b.co; travellers: 2; date: 2026-11-20; rooms: double; breakfast: true',
    );
    expect(input.surfaceAction).toEqual({
      surfaceId: form!.surfaceId,
      revision: 1,
      componentId: "root",
      name: "submit_trip",
    });
    // The same request id returns the same ids; a new one is refused as already submitted.
    const again = await act(id, form!, "submit_trip", "root", FORM_DATA, FORM_CONTEXT, "req-1");
    expect(again.body).toEqual(res.body);
    const second = await act(id, form!, "submit_trip", "root", FORM_DATA, FORM_CONTEXT, "req-2");
    expect(second.status).toBe(409);
    expect((await detail(s(), id)).runs).toHaveLength(2);
    const info = await s().client.get(`/api/sessions/${id}/surfaces/${form!.surfaceId}`);
    expect(info.body.actions.map((a: { decision: string }) => a.decision)).toEqual([
      "accepted",
      "duplicate",
      "duplicate",
    ]);
  });

  it("refuses failing checks, mismatched values, unknown actions and stale revisions", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const [form] = surfacesOf(lastReply(await talk(id, "/demo form")));
    const bad = { ...FORM_DATA, email: "nope" };
    let res = await act(id, form!, "submit_trip", "root", bad, { ...FORM_CONTEXT, email: "nope" });
    expect([res.status, res.body.error.code]).toEqual([400, "bad_action"]);
    expect(res.body.error.message).toContain("Enter a valid email.");
    res = await act(id, form!, "submit_trip", "root", FORM_DATA, { ...FORM_CONTEXT, email: "x@y.z" });
    expect([res.status, res.body.error.code]).toEqual([400, "bad_action"]);
    res = await act(id, form!, "other", "root", FORM_DATA, FORM_CONTEXT);
    expect([res.status, res.body.error.code]).toEqual([400, "bad_action"]);
    // The agent changes the components: the drawn revision is stale.
    const args = JSON.stringify({
      surfaceId: form!.surfaceId,
      components: [
        { id: "breakfast", component: "CheckBox", label: "Breakfast included", value: { "@path": "/breakfast" } },
      ],
    });
    await talk(id, `[tool: update_surface ${args}]`);
    res = await act(id, form!, "submit_trip", "root", FORM_DATA, FORM_CONTEXT);
    expect([res.status, res.body.error.code]).toEqual([409, "stale_surface"]);
    res = await act(id, { ...form!, revision: 2 }, "submit_trip", "root", FORM_DATA, FORM_CONTEXT);
    expect(res.status).toBe(200);
  });

  it("a removed surface is closed; a fork's copy is frozen and refuses actions and updates", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const d = await talk(id, "/demo ui");
    const reply = lastReply(d)!;
    const [shown] = surfacesOf(reply);

    const forked = await s().client.post(`/api/sessions/${id}/fork`, { messageId: reply.id });
    expect(forked.status).toBe(200);
    const fid = forked.body.session.id as string;
    const copy = surfacesOf(lastReply(await detail(s(), fid)))[0]!;
    expect(copy).toMatchObject({ surfaceId: shown!.surfaceId, state: "frozen" });
    let res = await act(fid, copy, "looks_good", "ok", { city: "Kyoto" }, { city: "Kyoto" });
    expect([res.status, res.body.error.code]).toEqual([409, "surface_closed"]);
    await talk(fid, `[tool: update_surface ${JSON.stringify({ surfaceId: copy.surfaceId, remove: true })}]`);
    expect(lastReply(await detail(s(), fid))!.text).toContain("branched from");

    await talk(id, `[tool: update_surface ${JSON.stringify({ surfaceId: shown!.surfaceId, remove: true })}]`);
    const after = (await detail(s(), id)).messages.flatMap(surfacesOf).find((x) => x.surfaceId === shown!.surfaceId)!;
    expect(after.state).toBe("removed");
    expect(after.message).toBeUndefined();
    res = await act(id, shown!, "looks_good", "ok", { city: "Kyoto" }, { city: "Kyoto" });
    expect([res.status, res.body.error.code]).toEqual([409, "surface_closed"]);
  });

  it("a surface fed by a worker is live while it runs, gets its progress, and goes idle when it ends", async () => {
    // The feed timer would write the first revision at an arbitrary moment after show_surface, possibly before this
    // test subscribes (under load it does, and the refresh never comes). Raise its period so each write below is one
    // the test asks for with tick().
    server = await startSignedIn({ config: { surfaceFeedMs: 3_600_000 } });
    const id = homeChat(s());
    // A send needs approval in Standard, giving the test control over when the worker finishes.
    await say(s(), id, `[spawn: ${tool("demo_send_message", { to: "ana@example.test", text: "hi" })}]`);
    const worker = await until(async () => (await childrenOf(s(), id))[0], 20_000, "the worker");
    const [approval] = await waitPending(s(), worker.id, 1);
    await settled(s(), id, 1);
    await talk(id, `[tool: show_surface ${JSON.stringify(liveSurface(worker.id))}]`);
    const surfaceOf = async () =>
      (await detail(s(), id)).messages.flatMap(surfacesOf).find((x) => x.title === "Research progress")!;
    const live = await surfaceOf();
    expect(live).toMatchObject({ state: "live", feed: { kind: "worker", sessionId: worker.id } });

    // Each feed write tells an open chat to refresh: it happens outside any run, so nothing else would.
    let refreshes = 0;
    const stop = s().host.plane.store.events.subscribe(sessionStream(id), (e) => {
      if (e.type === "view.changed") refreshes++;
    });
    await s().host.plane.adapter.surfaceFeeds.tick();
    await until(async () => refreshes > 0 || undefined, 2_000, "the view to refresh");
    stop();
    const fed = await surfaceOf();
    expect(fed.message!.createSurface.dataModel).toMatchObject({ status: "waiting", steps: [{ status: "pending" }] });
    expect(fed.revision).toBe(2);

    await decide(s(), approval!.id, { decision: "approve" });
    await until(async () => (await detail(s(), worker.id)).session.status === "completed", 20_000, "the worker to end");
    await s().host.plane.adapter.surfaceFeeds.tick();
    const done = await surfaceOf();
    expect(done.state).toBe("idle");
    expect(done.feed).toBeUndefined();
    expect(done.message!.createSurface.dataModel).toMatchObject({ status: "done", percent: 100 });
    const info = await s().client.get(`/api/sessions/${id}/surfaces/${done.surfaceId}`);
    expect(info.body.revisions.at(-1).author).toEqual({ kind: "feed", feed: "worker", sessionId: worker.id });
    // Nothing more is written once the feed is detached.
    await s().host.plane.adapter.surfaceFeeds.tick();
    expect((await surfaceOf()).revision).toBe(done.revision);
  });

  it("a feed on a worker that already ended attaches nothing; a session that is not a worker is refused", async () => {
    server = await startSignedIn();
    const id = homeChat(s());
    await say(s(), id, "[spawn: small job]");
    const worker = await until(async () => (await childrenOf(s(), id))[0], 20_000, "the worker");
    await until(async () => (await detail(s(), worker.id)).session.status === "completed", 20_000, "the worker to end");
    await settled(s(), id, 2);
    await talk(id, `[tool: show_surface ${JSON.stringify(liveSurface(worker.id))}]`);
    const shown = (await detail(s(), id)).messages.flatMap(surfacesOf).find((x) => x.title === "Research progress")!;
    expect(shown.state).toBe("idle");
    const other = await chat(s());
    const d = await talk(id, `[tool: show_surface ${JSON.stringify(liveSurface(other))}]`);
    expect(lastReply(d)!.text).toContain("is not a worker session this chat started");
  });

  it("the surface detail is 404 for an unknown surface", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    const res = await s().client.get(`/api/sessions/${id}/surfaces/srf_ghost`);
    expect(res.status).toBe(404);
  });
});
