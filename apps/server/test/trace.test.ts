import { join } from "node:path";
import type { RunTrace, SessionTraceResponse, StepDetailResponse, StepSummary } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FolderBlobStore } from "../src/node/blob-store.ts";
import { approve, askApproval, pending, sayAndSettle, setProfile, todo, tool } from "./helpers/approvals.ts";
import { type BrowserServer, el, SCREENSHOT_JPEG, startBrowserServer } from "./helpers/browser.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, filesContaining, say, settled } from "./helpers/sessions.ts";
import { callTool } from "./helpers/web.ts";

let server: (TestServer & { totpSecret: string }) | BrowserServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const s = (): TestServer => server!;
const store = () => s().host.plane.store;

const trace = async (id: string, query = ""): Promise<SessionTraceResponse> =>
  (await s().client.get(`/api/sessions/${id}/trace${query}`)).body;
/** Every step of a session, oldest first. */
const allSteps = async (id: string): Promise<StepSummary[]> =>
  (await trace(id)).runs
    .slice()
    .reverse()
    .flatMap((r) => r.steps);
const tools = async (id: string) => (await allSteps(id)).filter((x) => x.type === "tool.call");
const stepDetail = async (id: string): Promise<StepDetailResponse> => (await s().client.get(`/api/steps/${id}`)).body;

describe("tool steps", () => {
  it("keeps the model's activity label separate from approval summaries and execution arguments", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await setProfile(s(), id, "strict");
    await askApproval(s(), id, tool("demo_add_todo", { text: "milk", _activity: "  Prepare\n the shopping list  " }));
    const [blocked] = await tools(id);
    expect(blocked).toMatchObject({
      activity: "Prepare the shopping list",
      summary: "Add a to-do: milk",
      status: "running",
      decision: "ask",
    });
    const [approval] = await pending(s());
    expect(approval!.summary).toBe("Add a to-do: milk");
    expect(approval!.argsPreview).not.toContain("_activity");
    await approve(s(), id, { length: "once" });
    const steps = await tools(id);
    expect(steps.at(-1)).toMatchObject({ status: "ok", decision: "granted" });
    expect((await stepDetail(blocked!.id)).tool!.input).toEqual({ text: "milk" });
    await setProfile(s(), id, "standard");
    await sayAndSettle(s(), id, tool("demo_read_web", { url: "https://a.test", _activity: "x".repeat(200) }));
    expect((await tools(id)).at(-1)!.activity).toHaveLength(120);
  });

  it("records allow, granted, ask and deny with the policy's words, the Pi entry of the result and whether it acted outside", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await sayAndSettle(s(), id, tool("demo_read_web", { url: "https://a.test" })); // allow (read_external in Standard)
    await setProfile(s(), id, "strict");
    await askApproval(s(), id, todo("milk"));
    const [approval] = await pending(s());
    await approve(s(), id, { length: "session" }); // resumes the same step
    await sayAndSettle(s(), id, todo("bread")); // granted by the session grant
    await sayAndSettle(s(), id, tool("demo_login", { site: "bank.test" })); // deny: credentials

    const steps = await tools(id);
    expect(steps.map((x) => [x.toolName, x.actionClass, x.decision, x.status, x.sideEffect])).toEqual([
      ["demo_read_web", "read_external", "allow", "ok", false],
      ["demo_add_todo", "write_external", "granted", "ok", true],
      ["demo_add_todo", "write_external", "granted", "ok", true],
      ["demo_login", "credentials", "deny", "blocked", false],
    ]);
    expect(steps.map((x) => x.summary)).toEqual([
      "Read the web page https://a.test",
      "Add a to-do: milk",
      "Add a to-do: bread",
      "Sign in to bank.test",
    ]);
    expect(steps[1]!.approvalId).toBe(approval!.id);
    for (const other of steps.filter((_, i) => i !== 1)) expect(other.approvalId).toBeNull();
    // Each is linked to the entry Pi wrote for its result, in order.
    const entries = steps.map((x) => Number(x.piEntryId));
    expect(entries.every((e) => Number.isInteger(e) && e > 0)).toBe(true);
    expect([...entries].sort((a, b) => a - b)).toEqual(entries);
    expect(new Set(entries).size).toBe(entries.length);
    // Only what ran counts as a side effect.
    expect(steps.filter((x) => x.sideEffect)).toHaveLength(2);
    expect(
      store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM steps WHERE type = 'tool.call' AND side_effect = 1")!.n,
    ).toBe(2);
  });

  it("a send that ran and an irreversible call that ran are side effects; a read is not", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await setProfile(s(), id, "yolo");
    await sayAndSettle(s(), id, tool("demo_send_message", { to: "ana@example.com", text: "hi" }));
    await sayAndSettle(s(), id, tool("demo_read_inbox", {}));
    await sayAndSettle(s(), id, tool("demo_buy", { item: "lamp", price: 5 }));
    const steps = await tools(id);
    expect(steps.map((x) => [x.toolName, x.sideEffect])).toEqual([
      ["demo_send_message", true],
      ["demo_read_inbox", false],
      ["demo_buy", true],
    ]);
  });

  it("a call with bad arguments and a call to an unknown tool are not-executed steps with Pi's code and their entry", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await sayAndSettle(s(), id, tool("demo_add_todo", {})); // missing text
    await sayAndSettle(s(), id, '[call: no_such_tool {"a":1}]');
    const steps = await tools(id);
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.status).toBe("not_executed");
      expect(step.sideEffect).toBe(false);
      expect(step.piEntryId).not.toBeNull();
    }
    expect(steps.map((x) => x.toolName)).toEqual(["demo_add_todo", "no_such_tool"]);
    expect(steps.map((x) => x.errorCode)).toEqual(["invalid_arguments", "tool_unavailable"]);
    const d = await stepDetail(steps[1]!.id);
    expect(d.tool!.isError).toBe(true);
  });

  it("an expired approval, a deferred tool called before it is loaded and a bad call stay in the Trace as calls that did not run", async () => {
    server = await startSignedIn({ config: { approvalTtlMs: 600 } });
    const id = await chat(s());
    await setProfile(s(), id, "strict");
    await askApproval(s(), id, todo("milk"));
    const [ap] = await pending(s());
    await new Promise((r) => setTimeout(r, 900));
    expect(await pending(s())).toEqual([]);
    // A deferred tool called before it is loaded, then loaded and called with arguments that do not match its schema.
    await sayAndSettle(s(), id, "[call: list_triggers {}]");
    await sayAndSettle(s(), id, tool("update_trigger", {}));
    const steps = await tools(id);
    expect(steps.map((x) => [x.toolName, x.status, x.sideEffect, x.errorCode])).toEqual([
      ["demo_add_todo", "blocked", false, undefined],
      ["list_triggers", "not_executed", false, "tool_unavailable"],
      ["search_capabilities", "ok", false, undefined],
      ["update_trigger", "not_executed", false, "invalid_arguments"],
    ]);
    expect(steps[0]!.approvalId).toBe(ap!.id);
    expect(store().db.get<{ n: number }>("SELECT COUNT(*) AS n FROM steps WHERE side_effect = 1")!.n).toBe(0);
  });

  it("each run lists its model and tool calls in the order they started, with totals", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await sayAndSettle(s(), id, tool("demo_read_web", { url: "https://a.test" }));
    const t = await trace(id);
    expect(t.runs).toHaveLength(1);
    const run = t.runs[0]!;
    expect(run.steps.map((x) => x.type)).toEqual(["llm.call", "tool.call", "llm.call"]);
    expect(run.totals.modelCalls).toBe(2);
    expect(run.totals.toolCalls).toBe(1);
    expect(run.totals.tokens).toBeGreaterThan(0);
    expect(run.totals.durationMs).not.toBeNull();
    expect(run.triggerMessageId).toBe((await detail(s(), id)).messages.find((m) => m.role === "user")!.id);
    expect(run.run.status).toBe("completed");
    const [first, , last] = run.steps;
    expect(first).toMatchObject({
      status: "ok",
      provider: expect.any(String),
      model: expect.any(String),
      tokens: { total: expect.any(Number) },
    });
    // The model call that issued the tool call and the one that answered each have their own entry.
    expect(first!.piEntryId).not.toBeNull();
    expect(last!.piEntryId).not.toBeNull();
    expect(first!.piEntryId).not.toBe(last!.piEntryId);
  });

  it("a tool step still running when its run ends is closed as cancelled", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await sayAndSettle(s(), id, "hello");
    const run = (await detail(s(), id)).runs[0]!;
    const now = Date.now();
    store().db.run(
      "INSERT INTO steps (id, run_id, session_id, type, tool_name, status, started_at, side_effect) VALUES ('stp_stuck', ?, ?, 'tool.call', 'demo_add_todo', 'running', ?, 0)",
      run.id,
      id,
      now,
    );
    store().settleRun(
      { ...store().runs.get(run.id)!, status: "cancelled" },
      { role: "user", text: "hello" },
      undefined,
    );
    expect(store().db.get<{ status: string }>("SELECT status FROM steps WHERE id = 'stp_stuck'")!.status).toBe(
      "cancelled",
    );
  });
});

describe("a tool's pictures", () => {
  it("are kept as blobs, listed in the output and served by index with the right type", async () => {
    const b = await startBrowserServer();
    server = b;
    b.fake.page("https://shop.example/cart", {
      title: "Cart",
      snapshot: '- button "Pay" [ref=e1]',
      elements: { e1: el("button", "Pay") },
    });
    const id = await chat(b);
    await callTool(b, id, "browser_open", { url: "https://shop.example/cart" });
    await callTool(b, id, "browser_screenshot", {});
    const shot = (await tools(id)).find((x) => x.toolName === "browser_screenshot")!;
    const d = await stepDetail(shot.id);
    expect(d.tool!.output.map((p) => p.type)).toEqual(["image", "text"]);
    expect(d.tool!.output[0]).toEqual({ type: "image", index: 0, mimeType: "image/jpeg" });
    // The image bytes are not in the JSON of the detail.
    expect(JSON.stringify(d)).not.toContain("/9j/");
    const res = await b.client.raw("GET", `/api/steps/${shot.id}/images/0`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...Buffer.from(SCREENSHOT_JPEG, "base64")]);
    expect((await b.client.get(`/api/steps/${shot.id}/images/1`)).status).toBe(404);
    expect((await b.client.get(`/api/steps/${shot.id}/images/x`)).status).toBe(404);
    expect((await b.client.get(`/api/steps/stp_ghost/images/0`)).status).toBe(404);
    // Only raster types keep their type: a picture recorded as anything else (an SVG could carry script) is served as opaque bytes.
    b.host.plane.store.db.run("UPDATE step_images SET mime = 'image/svg+xml' WHERE step_id = ?", shot.id);
    const odd = await b.client.raw("GET", `/api/steps/${shot.id}/images/0`);
    expect(odd.headers.get("content-type")).toBe("application/octet-stream");
    expect(odd.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("the trace API", () => {
  it("pages runs newest first, 30 at a time, with a cursor", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    for (let i = 1; i <= 32; i++) {
      await say(s(), id, `message ${i}`);
      await settled(s(), id, i);
    }
    const first = await trace(id);
    expect(first.runs).toHaveLength(30);
    expect(first.session.id).toBe(id);
    const texts = (r: RunTrace) => (r.steps.length > 0 ? r.steps[0]!.runId : null);
    expect(first.runs[0]!.run.id).toBe((await detail(s(), id)).runs.at(-1)!.id);
    expect(first.next).toBe(first.runs.at(-1)!.run.id);
    const second = await trace(id, `?before=${first.next}`);
    expect(second.runs).toHaveLength(2);
    expect(second.next).toBeNull();
    const ids = [...first.runs, ...second.runs].map((r) => r.run.id);
    expect(new Set(ids).size).toBe(32);
    expect(first.runs.every((r) => r.steps.length >= 1 && texts(r) === r.run.id)).toBe(true);
    expect((await s().client.get(`/api/sessions/${id}/trace?before=run_ghost`)).status).toBe(400);
    expect((await s().client.get(`/api/sessions/ses_ghost/trace`)).status).toBe(404);
  });

  it("shows a model call's request and response, and a tool call's input and output", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await sayAndSettle(s(), id, tool("demo_read_web", { url: "https://a.test" }));
    const steps = await allSteps(id);
    const llm = await stepDetail(steps[0]!.id);
    expect(llm.truncated).toBe(false);
    expect(llm.payloadBytes).toBeGreaterThan(0);
    expect(JSON.stringify(llm.llm!.request)).toContain("demo_read_web");
    expect(llm.llm!.response).toMatchObject({ role: "assistant" });
    expect(llm.tool).toBeUndefined();
    const call = await stepDetail(steps[1]!.id);
    expect(call.tool).toMatchObject({ input: { url: "https://a.test" }, isError: false });
    expect(call.tool!.output[0]!.type).toBe("text");
    expect(call.llm).toBeUndefined();
    expect(call.step).toMatchObject({ id: steps[1]!.id, toolName: "demo_read_web", decision: "allow" });
    expect((await s().client.get("/api/steps/stp_ghost")).status).toBe(404);
  });

  it("cuts a string over 200,000 characters and says so", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await sayAndSettle(s(), id, tool("demo_read_web", { url: "https://a.test" }));
    const call = (await tools(id))[0]!;
    const blobs = new FolderBlobStore(join(s().dir, "blobs"));
    const big = await blobs.put(
      new TextEncoder().encode(
        JSON.stringify({
          input: { url: "https://a.test" },
          output: [{ type: "text", text: "x".repeat(260_000) }],
          isError: false,
        }),
      ),
    );
    store().db.run("UPDATE steps SET payload_blob = ? WHERE id = ?", big, call.id);
    const d = await stepDetail(call.id);
    expect(d.truncated).toBe(true);
    const out = d.tool!.output[0]! as { text: string };
    expect(out.text.length).toBeGreaterThanOrEqual(200_000);
    expect(out.text.length).toBeLessThan(210_000);
    expect(d.payloadBytes).toBeGreaterThan(260_000);
    // A normal one is not marked.
    expect((await stepDetail((await allSteps(id))[0]!.id)).truncated).toBe(false);
  });

  it("needs a signed-in user", async () => {
    server = await startSignedIn();
    const id = await chat(s());
    expect((await s().client.raw("GET", `/api/sessions/${id}/trace`, { cookie: false })).status).toBe(401);
    expect((await s().client.raw("GET", `/api/steps/stp_x`, { cookie: false })).status).toBe(401);
    expect((await s().client.raw("GET", `/api/steps/stp_x/images/0`, { cookie: false })).status).toBe(401);
  });
});

describe("fork only at a finished reply", () => {
  const seed = async () => {
    server = await startSignedIn();
    const id = await chat(s());
    await sayAndSettle(s(), id, "first hello");
    await setProfile(s(), id, "strict");
    await askApproval(s(), id, todo("milk"));
    await approve(s(), id, { length: "session" });
    await sayAndSettle(s(), id, todo("bread"));
    await sayAndSettle(s(), id, "last words");
    return id;
  };
  const fork = (id: string, body: object) => s().client.post(`/api/sessions/${id}/fork`, body);

  it("refuses a step, and forks at the reply instead", async () => {
    const id = await seed();
    const steps = await allSteps(id);
    // A tool call or a trace step is not output: the step id is not accepted.
    const res = await fork(id, { stepId: steps[0]!.id });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");

    const msgs = (await detail(s(), id)).messages.filter((m) => m.role === "assistant");
    const lastReply = msgs.at(-1)!;
    const ok = await fork(id, { messageId: lastReply.id });
    expect(ok.status).toBe(200);
    expect(ok.body.session.forkedFrom).toEqual({ sessionId: id, messageId: lastReply.id });
    const forked = await detail(s(), ok.body.session.id);
    expect(forked.messages.at(-1)!.text).toBe(lastReply.text);
    // The fork is its own chat: it keeps working after the cut.
    await say(s(), ok.body.session.id, "carry on from there");
    const after = await settled(s(), ok.body.session.id, 1);
    expect(after.runs[0]!.status).toBe("completed");
  });

  it("the preview lists the later steps that acted outside, and nothing for a fork that leaves none", async () => {
    const id = await seed();
    const msgs = (await detail(s(), id)).messages.filter((m) => m.role === "assistant");
    const early = (await s().client.get(`/api/sessions/${id}/fork-preview?messageId=${msgs[0]!.id}`)).body;
    expect(early.laterEffects.map((x: StepSummary) => x.summary)).toEqual(["Add a to-do: milk", "Add a to-do: bread"]);
    expect(early.laterEffects.every((x: StepSummary) => x.sideEffect && x.type === "tool.call")).toBe(true);
    expect(
      (await s().client.get(`/api/sessions/${id}/fork-preview?messageId=${msgs.at(-1)!.id}`)).body.laterEffects,
    ).toEqual([]);
  });

  it("the preview refuses what a fork would", async () => {
    const id = await seed();
    const get = (q: string) => s().client.get(`/api/sessions/${id}/fork-preview${q}`);
    expect((await get("")).status).toBe(400);
    expect((await get("?stepId=stp_ghost")).status).toBe(400);
    expect((await get("?messageId=msg_ghost")).status).toBe(404);
    const notice = (await detail(s(), id)).messages.find((m) => m.role === "approval")!;
    const res = await get(`?messageId=${notice.id}`);
    expect([res.status, res.body.error.code]).toEqual([409, "not_forkable"]);
    expect((await s().client.get(`/api/sessions/ses_ghost/fork-preview?messageId=x`)).status).toBe(404);
  });
});

describe("delete reaches the trace", () => {
  it("deleting a chat removes its tool steps, their pictures and every blob they held", async () => {
    const b = await startBrowserServer();
    server = b;
    b.fake.page("https://shop.example/cart", {
      title: "Cart",
      snapshot: '- button "Pay" [ref=e1]',
      elements: { e1: el("button", "Pay") },
    });
    const id = await chat(b);
    const marker = "quincebasket";
    await setProfile(b, id, "strict");
    await askApproval(b, id, tool("demo_add_todo", { text: marker }));
    await approve(b, id, { length: "once" });
    await setProfile(b, id, "standard");
    await callTool(b, id, "browser_open", { url: "https://shop.example/cart" });
    await callTool(b, id, "browser_screenshot", {});
    const db = store().db;
    const refs = db
      .all<{ r: string }>(
        "SELECT payload_blob AS r FROM steps WHERE payload_blob IS NOT NULL UNION SELECT response_blob FROM steps WHERE response_blob IS NOT NULL UNION SELECT blob FROM step_images",
      )
      .map((x) => x.r);
    expect(refs.length).toBeGreaterThan(4);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM step_images")!.n).toBe(1);
    const res = await b.client.call("DELETE", `/api/sessions/${id}`);
    expect(res.status).toBe(200);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM steps WHERE tool_name IS NOT NULL")!.n).toBe(0);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM steps")!.n).toBe(0);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM step_images")!.n).toBe(0);
    const blobs = new FolderBlobStore(join(b.dir, "blobs"));
    for (const ref of refs) expect(await blobs.has(ref), ref).toBe(false);
    expect(filesContaining(join(b.dir, "blobs"), marker)).toEqual([]);
  });
});
