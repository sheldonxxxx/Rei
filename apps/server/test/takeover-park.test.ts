// Browser calls park on the takeover signal while the user controls the window: a parked call holds no Pi invocation,
// runs once when the takeover ends (however long that takes), and ends with Stop or the session. Every rerun of the
// gates reads the takeover row, so it parks the same way and registers once.

import type { LiveTool } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { callTasks, TakeoverEnded } from "../src/pi/signals.ts";
import { context } from "../src/pi/trees.ts";
import { runWaitTime } from "../src/store/run-waits.ts";
import { decide, tool as directive, waitPending } from "./helpers/approvals.ts";
import { type BrowserServer, startBrowserServer } from "./helpers/browser.ts";
import { until } from "./helpers/client.ts";
import { startTestServer } from "./helpers/server.ts";
import { chat, detail, say, settled } from "./helpers/sessions.ts";
import { callTool, toolResults } from "./helpers/web.ts";

let server: BrowserServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const SHOP = "https://shop.example/";
const start = async (): Promise<BrowserServer> => {
  server = await startBrowserServer({ config: { browser: { mode: "cdp", cdpUrl: "http://fake:9223" } } });
  server.fake.page(SHOP, { title: "Shop", snapshot: "heading Shop" });
  return server;
};
const tk = (s: BrowserServer) => s.host.plane.browser!.takeovers;
const treeOf = (s: BrowserServer, id: string) =>
  s.host.plane.adapter.trees.get(s.host.plane.store.getSessionRow(id)!.tree_id)!;
const inactive = (s: BrowserServer, id: string) =>
  until(async () => (treeOf(s, id).harness.wake().active ? undefined : true), 10_000, "the tree to go inactive");
const liveTools = async (s: BrowserServer, id: string): Promise<LiveTool[]> =>
  ((await s.client.get(`/api/sessions/${id}`)).body.live?.tools ?? []) as LiveTool[];
const snapshots = (s: BrowserServer): number => s.fake.calls.filter((c) => c.startsWith("snapshot ")).length;
const takeoverRow = (s: BrowserServer, id: string) =>
  s.host.plane.store.db.get<{ id: string; status: string }>(
    "SELECT id, status FROM takeovers WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
    id,
  )!;

/** A session with a window the user is controlling, and one snapshot call made meanwhile and parked. */
async function parked(s: BrowserServer, call = directive("browser_snapshot")) {
  const id = await chat(s);
  await callTool(s, id, "browser_open", { url: SHOP });
  expect((await s.client.post(`/api/sessions/${id}/browser/takeover`, {})).status).toBe(200);
  const takeover = takeoverRow(s, id);
  expect(takeover.status).toBe("active");
  const before = snapshots(s);
  await say(s, id, call);
  await until(
    async () => ((await liveTools(s, id)).some((t) => t.status === "sleeping") ? true : undefined),
    10_000,
    "parked",
  );
  await inactive(s, id);
  return { id, takeover, before };
}
const end = (s: BrowserServer, takeoverId: string, action: "done" | "cancel") =>
  s.client.post(`/api/takeovers/${takeoverId}/end`, { action });

describe("a browser call made during a takeover", () => {
  it("parks holding no invocation and runs exactly once after the takeover ends, even after 15+ minutes", async () => {
    const s = await start();
    const { id, takeover, before } = await parked(s);
    expect(treeOf(s, id).harness.wake()).toMatchObject({ active: false });
    expect((await liveTools(s, id)).map((t) => t.status)).toEqual(["sleeping"]);
    expect(snapshots(s)).toBe(before);
    // The step is recorded before the park, so the web has a running step to show as waiting beside its sleeping slot.
    expect(
      s.host.plane.store.db.get<{ status: string }>(
        "SELECT status FROM steps WHERE session_id = ? AND tool_name = 'browser_snapshot'",
        id,
      ),
    ).toMatchObject({ status: "running" });

    // Past the 15 minutes the driver's own wait gave up after (and short of the run's own time limit).
    s.clock.advance(20 * 60_000);
    await new Promise((r) => setTimeout(r, 1_200));
    expect(snapshots(s)).toBe(before);
    expect(treeOf(s, id).harness.wake().active).toBe(false);

    expect((await end(s, takeover.id, "done")).status).toBe(200);
    const done = await settled(s, id, 2);
    expect(done.runs.at(-1)!.status).toBe("completed");
    expect(snapshots(s)).toBe(before + 1);
    expect(toolResults(s, id).at(-1)!.isError).toBe(false);
  });

  it("is released when the takeover is cancelled", async () => {
    const s = await start();
    const { id, takeover, before } = await parked(s);
    expect((await end(s, takeover.id, "cancel")).status).toBe(200);
    const done = await settled(s, id, 2);
    expect(done.runs.at(-1)!.status).toBe("completed");
    expect(snapshots(s)).toBe(before + 1);
  });

  it("is released when the takeover times out for lack of input", async () => {
    server = await startBrowserServer({
      config: { browser: { mode: "cdp", cdpUrl: "http://fake:9223", takeoverIdleMs: 1_500 } },
    });
    const s = server;
    s.fake.page(SHOP, { title: "Shop", snapshot: "heading Shop" });
    const { id, before } = await parked(s);
    const done = await settled(s, id, 2);
    expect(done.runs.at(-1)!.status).toBe("completed");
    expect(snapshots(s)).toBe(before + 1);
  });

  it("ends with Stop and never runs, even when the takeover ends later", async () => {
    const s = await start();
    const { id, takeover, before } = await parked(s);
    expect((await s.client.post(`/api/sessions/${id}/cancel`, {})).status).toBe(200);
    const done = await settled(s, id, 2);
    expect(done.runs.at(-1)!.status).toBe("cancelled");
    expect(await liveTools(s, id)).toEqual([]);
    expect((await end(s, takeover.id, "done")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(snapshots(s)).toBe(before);
  });

  it("ends with its session when the session is deleted", async () => {
    const s = await start();
    const { id, before } = await parked(s);
    expect((await s.client.call("DELETE", `/api/sessions/${id}`)).status).toBe(200);
    await until(
      () => (s.host.plane.store.nonTerminalRuns(id).length === 0 ? true : undefined),
      10_000,
      "the run to end",
    );
    expect(snapshots(s)).toBe(before);
  });

  it("stays parked across the gates running again, registers once, and asks for no approval first", async () => {
    const s = await start();
    const { id, takeover, before } = await parked(s);
    const session = s.host.plane.store.getSessionRow(id)!;
    const calls = new Set((await liveTools(s, id)).map((t) => t.callId));
    const [task] = await callTasks(s.host.plane.adapter.trees, session.tree_id, id, calls, context);
    expect(task).toBeDefined();
    // Every pass reads the same row and answers the same, and the task is remembered once.
    for (let i = 0; i < 3; i++) expect(tk(s).park(id, session.tree_id, task!)).toBe(takeover.id);
    expect(tk(s).park("ses_other", session.tree_id, task!)).toBeUndefined();
    expect(tk(s).park(id, session.tree_id, task!)).toBe(takeover.id);
    expect((await liveTools(s, id)).map((t) => t.status)).toEqual(["sleeping"]);
    expect((await end(s, takeover.id, "done")).status).toBe(200);
    await settled(s, id, 2);
    expect(snapshots(s)).toBe(before + 1);
  });

  it("asks its approval only after the takeover ends: the park comes before the policy gate", async () => {
    const s = await start();
    const id = await chat(s);
    await callTool(s, id, "browser_open", { url: SHOP });
    s.host.plane.store.addTaint(id, ["external", "private"]);
    s.fake.page(SHOP, {
      title: "Shop",
      snapshot: "textbox Code",
      elements: { e1: { role: "textbox", name: "Code", type: null, autocomplete: null, editable: true } },
    });
    expect((await s.client.post(`/api/sessions/${id}/browser/takeover`, {})).status).toBe(200);
    const takeover = takeoverRow(s, id);
    await say(s, id, directive("browser_type", { ref: "p1e1", text: "SAVE10" }));
    await until(
      async () => ((await liveTools(s, id)).some((t) => t.status === "sleeping") ? true : undefined),
      10_000,
      "parked",
    );
    await inactive(s, id);
    await new Promise((r) => setTimeout(r, 300));
    const rows = () => s.host.plane.store.db.all<{ id: string }>("SELECT id FROM approvals WHERE session_id = ?", id);
    expect(rows()).toEqual([]);
    expect((await end(s, takeover.id, "done")).status).toBe(200);
    const [approval] = await waitPending(s, id, 1);
    expect(approval).toMatchObject({ tool: "browser_type", status: "pending" });
    expect(s.fake.count("type")).toBe(0);
    await inactive(s, id);
    expect(rows()).toHaveLength(1);
  });

  it("is released when the server restarts: the takeover ended with its window, and the call runs once", async () => {
    const s = await start();
    const { id } = await parked(s, directive("browser_open", { url: SHOP }));
    const opened = () => s.fake.calls.filter((c) => c.startsWith("goto ")).length;
    const before = opened();
    const { dir, clock, fake } = s;
    const cookie = s.client.cookie;
    await s.stop();
    const reopened = Object.assign(await startTestServer({ dir, clock, browserDriver: fake }), {
      fake,
      totpSecret: "",
    });
    server = reopened;
    reopened.client.cookie = cookie;
    const done = await settled(reopened, id, 2);
    expect(done.runs.at(-1)!.status).toBe("completed");
    expect(takeoverRow(reopened, id).status).toBe("cancelled");
    expect(opened()).toBe(before + 1);
    expect((await detail(reopened, id)).runs.filter((r) => r.status === "running")).toEqual([]);
  });
});

describe("with several trees open", () => {
  it("wakes a call parked in an earlier tree: the tool catalog is shared, so the gate names its own tree", async () => {
    const s = await start();
    const first = await chat(s);
    await callTool(s, first, "browser_open", { url: SHOP });
    // A second tree opens afterwards and installs the browser tools again: the catalog entries are the last tree's.
    const second = await chat(s);
    await callTool(s, second, "browser_open", { url: SHOP });
    const trees = [first, second].map((id) => s.host.plane.store.getSessionRow(id)!.tree_id);
    expect(new Set(trees).size).toBe(2);
    expect((await s.client.post(`/api/sessions/${first}/browser/takeover`, {})).status).toBe(200);
    const takeover = takeoverRow(s, first);
    const before = snapshots(s);
    await say(s, first, directive("browser_snapshot"));
    await until(
      async () => ((await liveTools(s, first)).some((t) => t.status === "sleeping") ? true : undefined),
      10_000,
      "parked",
    );
    expect((await end(s, takeover.id, "done")).status).toBe(200);
    const done = await settled(s, first, 2);
    expect(done.runs.at(-1)!.status).toBe("completed");
    expect(snapshots(s)).toBe(before + 1);
  });
});

describe("when idle trees are closed", () => {
  it("keeps the tree open while a call is parked, so the wake finds it", async () => {
    // Closing needs no unfinished run and an inactive harness: a parked call's run is unfinished, though it holds no invocation.
    server = await startBrowserServer({
      config: { idleCloseMs: 50, browser: { mode: "cdp", cdpUrl: "http://fake:9223" } },
    });
    const s = server;
    s.fake.page(SHOP, { title: "Shop", snapshot: "heading Shop" });
    const { id, takeover, before } = await parked(s);
    const treeId = s.host.plane.store.getSessionRow(id)!.tree_id;
    await new Promise((r) => setTimeout(r, 1_500));
    expect(s.host.plane.adapter.trees.get(treeId)).toBeDefined();
    expect(treeOf(s, id).harness.wake().active).toBe(false);
    expect((await end(s, takeover.id, "done")).status).toBe(200);
    const done = await settled(s, id, 2);
    expect(done.runs.at(-1)!.status).toBe("completed");
    expect(snapshots(s)).toBe(before + 1);
  });
});

describe("the run time limit", () => {
  const LIMIT = 10 * 60_000;
  /** The test clock also moves with real time, a few milliseconds here. */
  const DRIFT = 5_000;
  const limited = async (): Promise<BrowserServer> => {
    server = await startBrowserServer({
      config: { maxRunMs: LIMIT, browser: { mode: "cdp", cdpUrl: "http://fake:9223" } },
    });
    server.fake.page(SHOP, { title: "Shop", snapshot: "heading Shop" });
    return server;
  };
  const lastRun = (s: BrowserServer, id: string) => s.host.plane.store.nonTerminalRuns(id).at(-1)?.id;

  it("does not count a takeover wait longer than the limit: the next model call is made after it ends", async () => {
    const s = await limited();
    const { id, takeover, before } = await parked(s);
    const runId = lastRun(s, id)!;
    s.clock.advance(3 * LIMIT);
    expect((await end(s, takeover.id, "done")).status).toBe(200);
    const done = await settled(s, id, 2);
    expect(done.runs.at(-1)).toMatchObject({ id: runId, status: "completed" });
    expect(snapshots(s)).toBe(before + 1);
    expect(Math.abs(runWaitTime(s.host.plane.store.db, runId) - 3 * LIMIT)).toBeLessThan(DRIFT);
    const calls = s.host.plane.store.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM steps WHERE run_id = ? AND type = 'llm.call'",
      runId,
    )!.n;
    expect(calls).toBe(2);
  });

  it("still stops a run whose time was not spent waiting", async () => {
    const s = await limited();
    const id = await chat(s);
    await callTool(s, id, "browser_open", { url: SHOP });
    s.clock.advance(2 * LIMIT);
    await say(s, id, directive("browser_snapshot"));
    const done = await settled(s, id, 2);
    expect(done.runs.at(-1)).toMatchObject({ status: "completed" });
    // A run that began before the clock moved and is asked for another model call after: over the limit, nothing waited.
    const runId = done.runs.at(-1)!.id;
    expect(runWaitTime(s.host.plane.store.db, runId)).toBe(0);
    expect(s.host.plane.adapter.trees.loopGuard(runId)).toBeUndefined();
    s.clock.advance(2 * LIMIT);
    expect(s.host.plane.adapter.trees.loopGuard(runId)).toMatch(/time limit/);
  });

  it("counts a takeover that overlaps an approval wait once", async () => {
    const s = await limited();
    const id = await chat(s);
    await callTool(s, id, "browser_open", { url: SHOP });
    s.host.plane.store.addTaint(id, ["external", "private"]);
    s.fake.page(SHOP, {
      title: "Shop",
      snapshot: "textbox Code",
      elements: { e1: { role: "textbox", name: "Code", type: null, autocomplete: null, editable: true } },
    });
    // The call asks for approval at t1, the user takes over at t2, approves at t3, and finishes at t4.
    await say(s, id, directive("browser_type", { ref: "p1e1", text: "SAVE10" }));
    const [approval] = await waitPending(s, id, 1);
    const asked = s.clock.now();
    s.clock.advance(LIMIT);
    expect((await s.client.post(`/api/sessions/${id}/browser/takeover`, {})).status).toBe(200);
    const takeover = takeoverRow(s, id);
    s.clock.advance(LIMIT);
    expect((await decide(s, approval!.id, { decision: "approve" })).status).toBe(200);
    await until(
      async () => ((await liveTools(s, id)).some((t) => t.status === "sleeping") ? true : undefined),
      10_000,
      "parked",
    );
    await inactive(s, id);
    s.clock.advance(LIMIT);
    expect((await end(s, takeover.id, "done")).status).toBe(200);
    const done = await settled(s, id, 2);
    expect(done.runs.at(-1)!.status).toBe("completed");
    const runId = done.runs.at(-1)!.id;
    // 3 x LIMIT from the ask to the end, not the 4 x LIMIT the two waits add up to.
    expect(Math.abs(s.clock.now() - asked - 3 * LIMIT)).toBeLessThan(DRIFT);
    expect(Math.abs(runWaitTime(s.host.plane.store.db, runId) - 3 * LIMIT)).toBeLessThan(DRIFT);
    expect(s.fake.count("type")).toBe(1);
  });
});

describe("a takeover that starts after a call passed the gate", () => {
  it("is waited out in the driver, which gives up after its own limit", async () => {
    const s = await start();
    const id = await chat(s);
    await callTool(s, id, "browser_open", { url: SHOP });
    expect((await s.client.post(`/api/sessions/${id}/browser/takeover`, {})).status).toBe(200);
    const browser = s.host.plane.browser!.service;
    // The same limit as the 15 minutes, shortened.
    (browser.config as { takeoverWaitMs: number }).takeoverWaitMs = 300;
    await expect(browser.waitForControl(id)).rejects.toThrow("The user is still in control of the browser");
    (browser.config as { takeoverWaitMs: number }).takeoverWaitMs = 60_000;
    const waiting = browser.waitForControl(id);
    expect((await end(s, takeoverRow(s, id).id, "done")).status).toBe(200);
    await expect(waiting).resolves.toBeUndefined();
  });
});

describe("the takeover signal", () => {
  it("only wakes: it carries nothing", () => {
    expect(TakeoverEnded.name).toBe("rei.takeover");
    expect(TakeoverEnded.key("tko_1")).toBeDefined();
  });
});
