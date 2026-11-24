import { COMPACT_INSTRUCTIONS_MAX } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { approve, setProfile, todo, waitPending } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";

let server: { destroy(): Promise<void> } | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const start = async (): Promise<TestServer> => {
  const s = await startSignedIn();
  server = s;
  return s;
};
const compact = (s: TestServer, id: string, body: Record<string, unknown> = {}) =>
  s.client.post(`/api/sessions/${id}/compact`, { requestId: crypto.randomUUID(), ...body });
const status = async (s: TestServer, id: string, requestId: string) =>
  (await s.client.get(`/api/sessions/${id}/compact/${requestId}`)).body;
const ended = (s: TestServer, id: string, requestId: string) =>
  until(
    async () => {
      const r = await status(s, id, requestId);
      return ["accepted", "running", "pending_placement"].includes(r.status) ? undefined : r;
    },
    20_000,
    "the compaction to end",
  );
/** A chat of three exchanges, with automatic compaction off and a tiny keep window, so a summary has something to cut. */
async function longChat(s: TestServer): Promise<string> {
  await s.client.call("PUT", "/api/settings/context", {
    body: { compaction: { enabled: false, keepRecentTokens: 1 } },
  });
  const id = await chat(s);
  let runs = 0;
  for (const text of ["first question about apples", "second question about pears", "third question about plums"]) {
    await say(s, id, text);
    await settled(s, id, ++runs);
  }
  return id;
}
const roles = async (s: TestServer, id: string) => (await detail(s, id)).messages.map((m) => m.role);
const insertRow = (s: TestServer, id: string, requestId: string, status: string, taskId: string | null = null) =>
  s.host.plane.store.db.run(
    "INSERT INTO manual_compactions (session_id, request_id, instructions_digest, task_id, status, created_at, updated_at) VALUES (?, ?, '', ?, ?, 1, 1)",
    id,
    requestId,
    taskId,
    status,
  );

describe("manual compaction", () => {
  it("summarizes a long idle chat through a native task, with automatic compaction off, and adds no chat message or run", async () => {
    const s = await start();
    const id = await longChat(s);
    const before = await detail(s, id);
    const requestId = crypto.randomUUID();
    const started = await compact(s, id, { requestId, instructions: "keep the fruit" });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ requestId, taskId: expect.any(String) });
    expect(["running", "pending_placement", "applied"]).toContain(started.body.status);
    expect(await ended(s, id, requestId)).toMatchObject({ status: "applied" });
    const after = await detail(s, id);
    expect(after.runs).toHaveLength(before.runs.length);
    // Only the compaction marker is new: the transcript keeps every message.
    expect(await roles(s, id)).toEqual([...before.messages.map((m) => m.role), "compaction"]);
    expect(after.messages.filter((m) => m.role === "user").map((m) => m.text)).toEqual(
      before.messages.filter((m) => m.role === "user").map((m) => m.text),
    );
  });

  it("says plainly that a short chat has nothing to compact, in the transcript, without a marker", async () => {
    const s = await start();
    const id = await chat(s);
    await say(s, id, "hello there");
    await settled(s, id);
    const requestId = crypto.randomUUID();
    expect((await compact(s, id, { requestId })).status).toBe(200);
    expect(await ended(s, id, requestId)).toMatchObject({ status: "no_change" });
    const messages = (await detail(s, id)).messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "notice"]);
    expect(messages.at(-1)!.text).toMatch(/Nothing to compact/);
  });

  it("is idempotent by request id and one row per request", async () => {
    const s = await start();
    const id = await longChat(s);
    const requestId = crypto.randomUUID();
    const first = await compact(s, id, { requestId });
    const again = await compact(s, id, { requestId });
    expect(again.status).toBe(200);
    expect(again.body.taskId).toBe(first.body.taskId);
    await ended(s, id, requestId);
    const repeat = await compact(s, id, { requestId });
    expect(repeat.body).toMatchObject({ requestId, status: "applied", taskId: first.body.taskId });
    expect(s.host.plane.store.db.all("SELECT 1 FROM manual_compactions WHERE session_id = ?", id)).toHaveLength(1);
  });

  it("refuses with 409 busy while a run is active, then works when it is over", async () => {
    const s = await start();
    const id = await longChat(s);
    await setProfile(s, id, "strict");
    await say(s, id, todo("hold the run"));
    await waitPending(s, id, 1);
    const refused = await compact(s, id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("busy");
    expect(s.host.plane.store.db.all("SELECT 1 FROM manual_compactions")).toHaveLength(0);
    await approve(s, id);
    const requestId = crypto.randomUUID();
    expect((await compact(s, id, { requestId })).status).toBe(200);
    // The faux model answers a summary prompt that quotes the held tool directive with a tool call, so only the start is checked.
    expect((await ended(s, id, requestId)).status).toMatch(/applied|failed/);
  });

  it("refuses another request while one is open, and your own send, but answers the first one's retry", async () => {
    const s = await start();
    const id = await longChat(s);
    const open = crypto.randomUUID();
    insertRow(s, id, open, "running", "999");
    const other = await compact(s, id);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("busy");
    expect((await compact(s, id, { requestId: open })).body).toMatchObject({ requestId: open, status: "running" });
    // Direct sends are refused with the draft kept; the barrier is on the server.
    const sent = await say(s, id, "hello during compaction");
    expect(sent.status).toBe(409);
    expect(sent.body.error.code).toBe("compacting");
    expect(await roles(s, id)).not.toContain("compacting");
    expect((await detail(s, id)).runs).toHaveLength(3);
  });

  it("answers a retry of an admitted send even while compacting", async () => {
    const s = await start();
    const id = await chat(s);
    const requestId = crypto.randomUUID();
    const first = await say(s, id, "admitted before", requestId);
    await settled(s, id);
    insertRow(s, id, crypto.randomUUID(), "running", "999");
    const again = await say(s, id, "admitted before", requestId);
    expect(again.status).toBe(200);
    expect(again.body.runId).toBe(first.body.runId);
  });

  it("holds a report for the session until the compaction ends, and delivers it then", async () => {
    const s = await start();
    const id = await chat(s);
    await say(s, id, "hi");
    await settled(s, id);
    const open = crypto.randomUUID();
    insertRow(s, id, open, "running", "999");
    const { adapter } = s.host.plane;
    await expect(
      adapter.commands.admit({ sessionId: id, requestId: "rep-1", role: "report", text: "report line" }),
    ).rejects.toMatchObject({ name: "AdmissionDeferred" });
    expect((await detail(s, id)).runs).toHaveLength(1);
    s.host.plane.store.db.run("UPDATE manual_compactions SET status = 'applied' WHERE request_id = ?", open);
    await adapter.commands.admit({ sessionId: id, requestId: "rep-1", role: "report", text: "report line" });
    await settled(s, id, 2);
  });

  it("validates the request", async () => {
    const s = await start();
    const id = await chat(s);
    expect((await s.client.post(`/api/sessions/${id}/compact`, {})).status).toBe(400);
    expect((await s.client.post(`/api/sessions/${id}/compact`, { requestId: "r", extra: 1 })).status).toBe(400);
    expect((await s.client.post(`/api/sessions/${id}/compact`, { requestId: "r", instructions: 5 })).status).toBe(400);
    const long = await compact(s, id, { instructions: "é".repeat(COMPACT_INSTRUCTIONS_MAX + 1) });
    expect(long.status).toBe(413);
    expect(long.body.error.code).toBe("too_long");
    expect((await s.client.post("/api/sessions/nope/compact", { requestId: "r" })).status).toBe(404);
    expect((await s.client.get(`/api/sessions/${id}/compact/unknown`)).status).toBe(404);
    // Exactly the limit, counted in code points, is allowed.
    const ok = await compact(s, id, { instructions: "😀".repeat(COMPACT_INSTRUCTIONS_MAX) });
    expect(ok.status).toBe(200);
  });

  it("reports a request that may have started as unknown after a restart, and never repeats it", async () => {
    const s = await start();
    const id = await chat(s);
    await say(s, id, "hi");
    await settled(s, id);
    const lost = crypto.randomUUID();
    insertRow(s, id, lost, "accepted", null);
    expect(s.host.plane.adapter.compactions.active(id)).toBe(true);
    await s.host.plane.adapter.compactions.recover();
    expect(await status(s, id, lost)).toMatchObject({ status: "unknown_after_restart" });
    expect(s.host.plane.adapter.compactions.active(id)).toBe(false);
    const messages = (await detail(s, id)).messages;
    expect(messages.at(-1)!.role).toBe("notice");
    expect(messages.at(-1)!.text).toMatch(/Run \/compact again/);
    // The user asks again with a new id; the old one stays as it was.
    const fresh = crypto.randomUUID();
    expect((await compact(s, id, { requestId: fresh })).status).toBe(200);
    expect((await status(s, id, lost)).status).toBe("unknown_after_restart");
    expect(s.host.plane.store.db.all("SELECT task_id FROM manual_compactions WHERE request_id = ?", lost)).toEqual([
      { task_id: null },
    ]);
  });

  it("ends a request whose task is gone as failed, with a sanitized line and a way to try again", async () => {
    const s = await start();
    const id = await chat(s);
    await say(s, id, "hi");
    await settled(s, id);
    const lost = crypto.randomUUID();
    insertRow(s, id, lost, "running", "424242");
    await s.host.plane.adapter.compactions.recover();
    const end = await ended(s, id, lost);
    expect(end).toMatchObject({ status: "failed", error: { code: "compaction_failed" } });
    expect((await detail(s, id)).messages.at(-1)!.text).toMatch(/^Compaction failed:/);
    expect((await compact(s, id)).status).toBe(200);
  });

  it("shows an open request in the session view and clears it when it ends", async () => {
    const s = await start();
    const id = await chat(s);
    await say(s, id, "hi");
    await settled(s, id);
    const open = crypto.randomUUID();
    insertRow(s, id, open, "pending_placement", "999");
    const view = await s.host.plane.adapter.views.snapshot(id);
    expect(view.live.manualCompaction).toEqual({ requestId: open, status: "pending_placement" });
    s.host.plane.store.db.run("UPDATE manual_compactions SET status = 'no_change' WHERE request_id = ?", open);
    expect((await s.host.plane.adapter.views.snapshot(id)).live.manualCompaction).toBeUndefined();
  });

  it("compacts only the session asked, not a fork that shares its tree", async () => {
    const s = await start();
    const id = await longChat(s);
    const detailed = await detail(s, id);
    const reply = detailed.messages.filter((m) => m.role === "assistant").at(-1)!;
    const fork = (await s.client.post(`/api/sessions/${id}/fork`, { messageId: reply.id })).body.session.id as string;
    const requestId = crypto.randomUUID();
    await compact(s, id, { requestId });
    await ended(s, id, requestId);
    expect(await roles(s, id)).toContain("compaction");
    expect(await roles(s, fork)).not.toContain("compaction");
    // The fork is free to compact on its own.
    expect(s.host.plane.adapter.compactions.active(fork)).toBe(false);
  });

  it("removes a deleted session's requests", async () => {
    const s = await start();
    const id = await chat(s);
    insertRow(s, id, "gone", "applied", "1");
    expect((await s.client.call("DELETE", `/api/sessions/${id}`)).status).toBe(200);
    await until(
      async () =>
        s.host.plane.store.db.all("SELECT 1 FROM manual_compactions WHERE session_id = ?", id).length === 0 ||
        undefined,
      10_000,
      "the rows to go",
    );
  });
});
