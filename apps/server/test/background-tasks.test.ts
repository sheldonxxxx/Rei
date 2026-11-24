import { afterEach, expect, it } from "vitest";
import { until } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, say, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

it("acknowledges each subscriber with its durable enqueue transaction and deduplicates settlement replay", async () => {
  server = await startSignedIn();
  const { store, background } = server.host.plane;
  let fail = true;
  background.subscribe("probe", (event) => {
    background.enqueue({
      kind: "probe",
      dedupe: `probe:${event.id}`,
      sessionId: event.session_id,
      agentId: event.agent_id,
      payload: { runId: event.run_id },
    });
    if (fail) throw new Error("ROLLBACK");
  });
  const id = await chat(server);
  await say(server, id, "First source");
  await settled(server, id);
  background.tick();
  expect(store.db.all("SELECT * FROM background_jobs")).toHaveLength(0);
  expect(store.db.all("SELECT * FROM lifecycle_deliveries WHERE handler='probe'")).toHaveLength(0);
  fail = false;
  background.tick();
  background.tick();
  expect(store.db.all("SELECT * FROM background_jobs")).toHaveLength(1);
  const run = store.runs.forSession(id)[0];
  expect(run).toBeDefined();
  store.settleRun(run!, { role: "user", text: "First source" }, { text: "A reply" });
  background.tick();
  expect(store.db.all("SELECT * FROM lifecycle_outbox")).toHaveLength(1);
  expect(store.db.all("SELECT * FROM background_jobs")).toHaveLength(1);
});

it("keeps queue pressure durable and serializes jobs within a source session", async () => {
  server = await startSignedIn();
  const { store, background } = server.host.plane;
  const id = await chat(server);
  const agentId = store.getSessionRow(id)!.agent_id;
  let active = 0,
    maxActive = 0;
  background.register("probe", async (_job, task) => {
    active++;
    maxActive = Math.max(active, maxActive);
    await Promise.resolve();
    store.tx(() => {
      task.assertLive();
      store.metaSet("probe_commits", String(Number(store.metaGet("probe_commits") ?? 0) + 1));
      task.complete({ status: "succeeded" });
    });
    active--;
    return { status: "succeeded" };
  });
  store.tx(() => {
    for (let i = 0; i < 20; i++)
      background.enqueue({ kind: "probe", dedupe: `probe:${i}`, sessionId: id, agentId, payload: {} });
  });
  for (let i = 0; i < 25; i++) {
    background.tick();
    await Promise.allSettled([...background.active.values()].map((a) => a.promise));
  }
  expect(store.metaGet("probe_commits")).toBe("20");
  expect(maxActive).toBe(1);
  expect(store.db.all("SELECT * FROM background_jobs WHERE status<>'succeeded'")).toHaveLength(0);
});

it("fences a late side effect when the source is deleted and redacts the activity record", async () => {
  server = await startSignedIn();
  const { store, background } = server.host.plane;
  const id = await chat(server),
    agentId = store.getSessionRow(id)!.agent_id;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  background.register("probe", async (_job, task) => {
    await gate;
    store.tx(() => {
      task.assertLive();
      store.metaSet("late_effect", "bad");
    });
    return { status: "succeeded" };
  });
  let jobId = "";
  store.tx(() => {
    jobId = background.enqueue({ kind: "probe", dedupe: "late", sessionId: id, agentId, payload: { source: id } });
  });
  background.tick();
  await server.client.call("DELETE", `/api/sessions/${id}`);
  release();
  await Promise.allSettled([...background.active.values()].map((a) => a.promise));
  expect(store.metaGet("late_effect")).toBeUndefined();
  const detail = await server.client.get(`/api/background/${jobId}`);
  expect(detail.body.job).toMatchObject({ status: "cancelled", session_id: null, payload: "{}", result: null });
  expect(detail.body.sources).toEqual([]);
});

it("retries failed work without advancing or duplicating its guarded commit", async () => {
  server = await startSignedIn();
  const { store, background } = server.host.plane;
  const id = await chat(server),
    agentId = store.getSessionRow(id)!.agent_id;
  let succeed = false;
  background.register("probe", async (_job, task) => {
    if (!succeed) throw new Error("MODEL_UNAVAILABLE");
    store.tx(() => {
      task.assertLive();
      store.metaSet("committed", "once");
      task.complete({ status: "succeeded" });
    });
    return { status: "succeeded" };
  });
  let jobId = "";
  store.tx(() => {
    jobId = background.enqueue({ kind: "probe", dedupe: "retry", sessionId: id, agentId, payload: {} });
  });
  for (let i = 0; i < 3; i++) {
    store.db.run("UPDATE background_jobs SET retry_at=0 WHERE id=?", jobId);
    background.tick();
    await Promise.allSettled([...background.active.values()].map((a) => a.promise));
  }
  expect(store.db.get<{ status: string }>("SELECT status FROM background_jobs WHERE id=?", jobId)!.status).toBe(
    "failed",
  );
  succeed = true;
  expect(background.retry(jobId)).toBe(true);
  background.tick();
  await until(
    () => store.db.get("SELECT 1 FROM background_jobs WHERE id=? AND status='succeeded'", jobId),
    1000,
    "retry commit",
  );
  expect(store.metaGet("committed")).toBe("once");
  expect(store.db.all("SELECT * FROM background_jobs")).toHaveLength(1);
});
