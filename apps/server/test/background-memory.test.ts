import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { until } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, say, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

it("uses one global threshold with independent session windows, native no-change reviews and erased private data", async () => {
  server = await startSignedIn();
  const plane = server.host.plane;
  await server.client.call("PUT", "/api/settings/memory-extraction", { body: { enabled: true, everyNTurns: 2 } });
  const a = await chat(server),
    b = plane.store.createAgent({ name: "Other", avatar: "O", instructions: "" }).session.id;
  for (const id of [a, b]) {
    await say(server, id, "One passing question");
    await settled(server, id);
  }
  plane.background.tick();
  expect(plane.store.db.all("SELECT * FROM background_jobs")).toHaveLength(0);
  await say(server, a, "Another passing question");
  await settled(server, a, 2);
  plane.background.tick();
  await until(
    () => plane.store.db.get("SELECT 1 FROM background_jobs WHERE status='no_changes'"),
    10000,
    "no-change review",
  );
  await plane.memoryMaintenance.settle();
  const jobs = plane.store.db.all<{ session_id: string; status: string }>(
    "SELECT session_id,status FROM background_jobs",
  );
  expect(jobs).toEqual([{ session_id: a, status: "no_changes" }]);
  expect(plane.memory.lines.lines("profile", null)).toHaveLength(0);
  expect(plane.store.db.all("SELECT * FROM steps WHERE usage_purpose='memory'")).toHaveLength(0);
  expect(readdirSync(join(server.dir, "background-private"))).toEqual([]);
  const activity = await server.client.get("/api/background");
  expect(activity.status).toBe(200);
  const detail = await server.client.get(`/api/background/${activity.body.jobs[0].id}`);
  expect(detail.status).toBe(200);
  expect(detail.body.sources).toHaveLength(2);
  expect(detail.body.attempts[0].model).toBeTruthy();
  expect(detail.body.changes).toEqual([]);
  expect(plane.store.listSessions().some((s) => s.id.startsWith("bg_"))).toBe(false);
});

it("reconsiders each remainder when global N changes and starts fresh after disable", async () => {
  server = await startSignedIn();
  const plane = server.host.plane;
  const a = await chat(server);
  await say(server, a, "Before enable");
  await settled(server, a);
  await server.client.call("PUT", "/api/settings/memory-extraction", { body: { enabled: true } });
  for (let i = 0; i < 2; i++) {
    await say(server, a, `New question ${i}`);
    await settled(server, a, i + 2);
  }
  plane.background.tick();
  expect(plane.store.db.all("SELECT * FROM memory_review_sources")).toHaveLength(2);
  expect(plane.store.db.all("SELECT * FROM background_jobs")).toHaveLength(0);
  await server.client.call("PUT", "/api/settings/memory-extraction", { body: { everyNTurns: 2 } });
  expect(plane.store.db.all("SELECT * FROM background_jobs")).toHaveLength(1);
  await server.client.call("PUT", "/api/settings/memory-extraction", { body: { enabled: false } });
  expect(plane.store.db.get<{ status: string }>("SELECT status FROM background_jobs")!.status).toBe("cancelled");
  await server.client.call("PUT", "/api/settings/memory-extraction", { body: { enabled: true } });
  plane.background.tick();
  expect(plane.store.db.all("SELECT * FROM background_jobs")).toHaveLength(1);
});
