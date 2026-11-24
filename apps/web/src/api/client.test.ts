import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createApi,
  describeAgentError,
  describeError,
  describeErrorInfo,
  describeMemoryError,
  describeSetupError,
  NETWORK_ERROR,
} from "./client.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const header = (init: RequestInit | undefined, name: string) =>
  (init?.headers as Record<string, string> | undefined)?.[name];

describe("api client", () => {
  it("sends the CSRF header on non-GET requests only, with same-origin credentials", async () => {
    const fetchMock = vi.fn(async () => json(200, {}));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.getAgents();
    await api.createSession({});
    await api.cancel("s1");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(header(calls[0]![1], "x-rei")).toBeUndefined();
    expect(header(calls[1]![1], "x-rei")).toBe("1");
    expect(header(calls[2]![1], "x-rei")).toBe("1");
    expect(calls[0]![1].credentials).toBe("same-origin");
    expect(calls[2]![0]).toBe("/api/sessions/s1/cancel");
  });

  it("forks a session and deletes one, with the CSRF header and the right paths", async () => {
    const fetchMock = vi.fn(async () => json(200, { ok: true }));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.forkSession("s 1", "m1");
    await api.deleteSession("s1");
    await api.deleteSession("s1", { withForks: true });
    await api.deleteSession("h 1", { clearHome: true });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe("/api/sessions/s%201/fork");
    expect(calls[0]![1].method).toBe("POST");
    expect(calls[0]![1].body).toBe(JSON.stringify({ messageId: "m1" }));
    expect(calls[1]![0]).toBe("/api/sessions/s1");
    expect(calls[1]![1].method).toBe("DELETE");
    expect(calls[1]![1].body).toBeUndefined();
    expect(header(calls[1]![1], "x-rei")).toBe("1");
    expect(calls[2]![0]).toBe("/api/sessions/s1?withForks=1");
    expect(header(calls[2]![1], "x-rei")).toBe("1");
    expect(calls[3]![0]).toBe("/api/sessions/h%201?clearHome=1");
  });

  it("describes the fork and delete errors", () => {
    expect(describeError(new ApiError(409, "not_forkable", ""))).toMatch(/can't be branched/);
    expect(describeError(new ApiError(409, "home_chat", ""))).toMatch(/home chat/);
  });

  it("maps error bodies to ApiError codes", async () => {
    const api = createApi({
      fetch: (async () => json(401, { error: { code: "bad_credentials", message: "nope" } })) as typeof fetch,
    });
    const err = await api.login({ password: "x", totpCode: "123456" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("bad_credentials");
    expect(err.status).toBe(401);
    expect(describeError(err)).toBe("Wrong password or code");
    expect(describeError(new ApiError(429, "rate_limited", ""))).toMatch(/wait/i);
  });

  it("falls back to a generic code when the body is not JSON", async () => {
    const api = createApi({
      fetch: (async () => new Response("<html>bad gateway</html>", { status: 500 })) as typeof fetch,
    });
    const err = await api.getSessions().catch((e) => e);
    expect(err.code).toBe("http_500");
  });

  it("calls onUnauthorized for a 401, but not from the login or setup endpoints", async () => {
    const onUnauthorized = vi.fn();
    const api = createApi({
      fetch: (async () => json(401, { error: { code: "unauthenticated", message: "" } })) as typeof fetch,
      onUnauthorized,
    });
    await api.getSessions().catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await api.login({ password: "x", totpCode: "1" }).catch(() => {});
    await api.setupStart({ setupCode: "x", password: "y" }).catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("retries sendMessage with the same requestId after a network error", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(json(200, { messageId: "m1", runId: "r1" }));
    const sleep = vi.fn(async () => {});
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch, sleep });
    const res = await api.sendMessage("s1", "req-123", "hello");
    expect(res).toEqual({ messageId: "m1", runId: "r1" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map((c) => c[1].body);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] as string)).toEqual({
      requestId: "req-123",
      text: "hello",
    });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("sends selected skills as id and version only, and omits the field when none are chosen", async () => {
    const fetchMock = vi.fn(async () => json(200, { messageId: "m1", runId: "r1" }));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
    await api.sendMessage("s1", "r1", "hi", {
      selectedSkills: [
        { id: "k1", version: 2, name: "acme/review" },
        { id: "k2", version: 1, name: "plain" },
      ],
    });
    await api.sendMessage("s1", "r2", "hi", { selectedSkills: [] });
    const bodies = (fetchMock.mock.calls as unknown as [string, RequestInit][]).map((c) =>
      JSON.parse(c[1].body as string),
    );
    expect(bodies[0]).toEqual({
      requestId: "r1",
      text: "hi",
      selectedSkills: [
        { id: "k1", version: 2 },
        { id: "k2", version: 1 },
      ],
    });
    expect(bodies[1]).toEqual({ requestId: "r2", text: "hi" });
  });

  it("lists a session's skills and starts and reads a compaction on the session's own routes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { skills: [] }))
      .mockResolvedValueOnce(json(200, { requestId: "c1", status: "running", taskId: "7" }))
      .mockResolvedValueOnce(json(200, { requestId: "c1", status: "applied", taskId: "7" }));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
    expect(await api.getSessionSkills("s 1")).toEqual({ skills: [] });
    expect(await api.compact("s 1", { requestId: "c1", instructions: "keep" })).toMatchObject({ status: "running" });
    expect(await api.getCompactStatus("s 1", "c1")).toMatchObject({ status: "applied" });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map((c) => c[0])).toEqual([
      "/api/sessions/s%201/skills",
      "/api/sessions/s%201/compact",
      "/api/sessions/s%201/compact/c1",
    ]);
    expect(calls[1]![1].method).toBe("POST");
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ requestId: "c1", instructions: "keep" });
  });

  it("gives up after the retries with a network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch, sleep: async () => {}, sendRetries: 2 });
    const err = await api.sendMessage("s1", "r", "x").catch((e) => e);
    expect(err.code).toBe(NETWORK_ERROR);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 4xx answer", async () => {
    const fetchMock = vi.fn(async () => json(400, { error: { code: "empty_message", message: "" } }));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
    const err = await api.sendMessage("s1", "r", " ").catch((e) => e);
    expect(err.code).toBe("empty_message");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry other POSTs on network errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("x"));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
    await api.createSession().catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("api client: policy", () => {
  it("patches a session, decides an approval, lists approvals and grants, and revokes a grant", async () => {
    const fetchMock = vi.fn(async () => json(200, { ok: true }));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.updateSession("s 1", { profile: "relaxed" });
    await api.listApprovals();
    await api.decideApproval("ap/1", { decision: "approve", length: "hours", hours: 3 });
    await api.listGrants();
    await api.revokeGrant("g1");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe("/api/sessions/s%201");
    expect(calls[0]![1].method).toBe("PATCH");
    expect(calls[0]![1].body).toBe(JSON.stringify({ profile: "relaxed" }));
    expect(header(calls[0]![1], "x-rei")).toBe("1");
    expect(calls[1]![0]).toBe("/api/approvals");
    expect(calls[1]![1].method).toBe("GET");
    expect(header(calls[1]![1], "x-rei")).toBeUndefined();
    expect(calls[2]![0]).toBe("/api/approvals/ap%2F1/decide");
    expect(calls[2]![1].method).toBe("POST");
    expect(calls[2]![1].body).toBe(JSON.stringify({ decision: "approve", length: "hours", hours: 3 }));
    expect(calls[3]![0]).toBe("/api/grants");
    expect(calls[4]![0]).toBe("/api/grants/g1");
    expect(calls[4]![1].method).toBe("DELETE");
    expect(header(calls[4]![1], "x-rei")).toBe("1");
  });

  it("words the policy errors", () => {
    expect(describeError(new ApiError(409, "not_pending", ""))).toBe("Already decided.");
    expect(describeError(new ApiError(400, "bad_length", ""))).toMatch(/isn't available/);
    expect(describeError(new ApiError(400, "bad_hours", ""))).toMatch(/1 to 168/);
    expect(describeError(new ApiError(400, "bad_profile", ""))).toMatch(/doesn't exist/);
    expect(describeError(new ApiError(500, "loop_guard", "x"))).toBe("Stopped: this reply hit its step or time limit.");
    expect(describeErrorInfo({ code: "loop_guard", message: "raw" })).toBe(
      "Stopped: this reply hit its step or time limit.",
    );
    expect(describeErrorInfo({ code: "model_error", message: "The model failed." })).toBe("The model failed.");
  });
});

describe("browser takeover", () => {
  it("starts a takeover and ends one, with the CSRF header and the right paths", async () => {
    const fetchMock = vi.fn(async () => json(200, {}));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.startTakeover("s 1");
    await api.endTakeover("t/1", { action: "done", note: "Signed in" });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe("/api/sessions/s%201/browser/takeover");
    expect(calls[0]![1].method).toBe("POST");
    expect(header(calls[0]![1], "x-rei")).toBe("1");
    expect(calls[1]![0]).toBe("/api/takeovers/t%2F1/end");
    expect(calls[1]![1].body).toBe(JSON.stringify({ action: "done", note: "Signed in" }));
    expect(header(calls[1]![1], "x-rei")).toBe("1");
  });

  it("describes the takeover errors", () => {
    expect(describeError(new ApiError(409, "no_window", ""))).toMatch(/window is closed/);
    expect(describeError(new ApiError(409, "already_active", ""))).toMatch(/already in control/);
    expect(describeError(new ApiError(409, "not_open", ""))).toMatch(/already over/);
  });
});

describe("agent look", () => {
  it("PATCHes the avatar with the CSRF header, and words a refusal", async () => {
    const fetchMock = vi.fn(async () => json(200, {}));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.updateAgent("a/1", { avatar: "bot:cat" });
    const call = (fetchMock.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(call[0]).toBe("/api/agents/a%2F1");
    expect(call[1].method).toBe("PATCH");
    expect(call[1].body).toBe(JSON.stringify({ avatar: "bot:cat" }));
    expect(header(call[1], "x-rei")).toBe("1");
    expect(describeError(new ApiError(400, "bad_avatar", ""))).toMatch(/can't be used/);
  });
});

describe("agent create and delete", () => {
  it("POSTs the chosen identity and DELETEs by id, with the CSRF header", async () => {
    const fetchMock = vi.fn(async () => json(200, {}));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.createAgent({ name: "News Reporter", avatar: "📰" });
    await api.deleteAgent("a/2");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe("/api/agents");
    expect(calls[0]![1].method).toBe("POST");
    expect(calls[0]![1].body).toBe(JSON.stringify({ name: "News Reporter", avatar: "📰" }));
    expect(header(calls[0]![1], "x-rei")).toBe("1");
    expect(calls[1]![0]).toBe("/api/agents/a%2F2");
    expect(calls[1]![1].method).toBe("DELETE");
    expect(header(calls[1]![1], "x-rei")).toBe("1");
  });

  it("words the refusals", () => {
    expect(describeError(new ApiError(409, "default_agent", ""))).toMatch(/default agent can't be deleted/);
    expect(describeAgentError(new ApiError(404, "not_found", ""))).toMatch(/agent no longer exists/);
    expect(describeAgentError(new ApiError(400, "bad_request", "The name must be 1 to 40 characters."))).toMatch(
      /1 to 40/,
    );
    expect(describeAgentError(new ApiError(0, NETWORK_ERROR, ""))).toMatch(/Can't reach the server/);
  });
});

describe("api client: memory", () => {
  it("uses the documented paths and methods, with the CSRF header on writes", async () => {
    const fetchMock = vi.fn(async () => json(200, {}));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.getMemory();
    await api.addMemoryLine({ doc: "agent", agentId: "a 1", text: "Be brief." });
    await api.updateMemoryLine("m1", { text: "x" });
    await api.deleteMemoryLine("m1");
    await api.getMemoryChanges("m1");
    await api.undoMemoryChange("c 1");
    await api.getIndexStatus();
    await api.rebuildIndex();
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      "GET /api/memory",
      "POST /api/memory/lines",
      "PATCH /api/memory/lines/m1",
      "DELETE /api/memory/lines/m1",
      "GET /api/memory/lines/m1/changes",
      "POST /api/memory/changes/c%201/undo",
      "GET /api/memory/index",
      "POST /api/memory/index/rebuild",
    ]);
    expect(calls[1]![1].body).toBe(JSON.stringify({ doc: "agent", agentId: "a 1", text: "Be brief." }));
    expect(calls.filter(([, init]) => init.method !== "GET").every(([, init]) => header(init, "x-rei") === "1")).toBe(
      true,
    );
  });

  it("encodes a history search and leaves out what is not set", async () => {
    const fetchMock = vi.fn(async () => json(200, { hits: [], index: {} }));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.searchHistory({ q: "東京 hotel&more" });
    await api.searchHistory({ q: "x", from: 10, to: 20, limit: 5 });
    await api.searchHistory({ q: "x", agent: "a 1" });
    const urls = (fetchMock.mock.calls as unknown as [string][]).map((c) => c[0]);
    expect(urls[0]).toBe("/api/history/search?q=%E6%9D%B1%E4%BA%AC+hotel%26more");
    expect(urls[1]).toBe("/api/history/search?q=x&from=10&to=20&limit=5");
    expect(urls[2]).toBe("/api/history/search?q=x&agent=a+1");
  });

  it("describes memory errors in memory words, and falls back for the rest", () => {
    expect(describeMemoryError(new ApiError(400, "too_long", ""))).toMatch(/line is too long \(over 500/);
    expect(describeMemoryError(new ApiError(409, "over_budget", ""))).toMatch(/Memory is full/);
    expect(describeMemoryError(new ApiError(409, "not_undoable", ""))).toMatch(/Can't undo/);
    expect(describeMemoryError(new ApiError(404, "not_found", ""))).toBe("That no longer exists.");
    expect(describeMemoryError(new ApiError(0, NETWORK_ERROR, ""))).toMatch(/Can't reach the server/);
    expect(describeError(new ApiError(400, "too_long", ""))).toMatch(/message is too long/); // the chat wording is unchanged
  });
});

describe("api client: surfaces, edits and forks", () => {
  const calls = (m: ReturnType<typeof vi.fn>) => m.mock.calls as unknown as [string, RequestInit][];

  it("sends surface actions, reads surface detail, edits, and forks at a message", async () => {
    const fetchMock = vi.fn(async () => json(200, {}));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    const action = {
      requestId: "q1",
      revision: 2,
      dataModel: { a: 1 },
      action: {
        version: "1.0" as const,
        action: {
          name: "book",
          surfaceId: "srf 1",
          sourceComponentId: "b",
          timestamp: "2026-11-13T00:00:00Z",
          context: {},
        },
      },
    };
    await api.surfaceAction("s 1", "srf 1", action);
    await api.editMessage("s1", { messageId: "u1", text: "again" });
    await api.forkSession("s1", "m2");
    const c = calls(fetchMock);
    expect(c[0]![0]).toBe("/api/sessions/s%201/surfaces/srf%201/actions");
    expect(c[0]![1].method).toBe("POST");
    expect(header(c[0]![1], "x-rei")).toBe("1");
    expect(JSON.parse(c[0]![1].body as string)).toEqual(action);
    expect(c[1]![0]).toBe("/api/sessions/s1/edit");
    expect(JSON.parse(c[1]![1].body as string)).toEqual({ messageId: "u1", text: "again" });
    expect(c[2]![0]).toBe("/api/sessions/s1/fork");
    expect(JSON.parse(c[2]![1].body as string)).toEqual({ messageId: "m2" });
    await api.surfaceDetail("s1", "srf 1");
    expect(calls(fetchMock)[3]![0]).toBe("/api/sessions/s1/surfaces/srf%201");
  });

  it("reads the trace, a step, a fork preview and the edit log", async () => {
    const fetchMock = vi.fn(async () => json(200, {}));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.getTrace("s 1");
    await api.getTrace("s1", "r 9");
    await api.getStep("st 1");
    await api.forkPreview("s1", "m 1");
    await api.getEdits();
    await api.getEdits(10);
    expect(calls(fetchMock).map((c) => c[0])).toEqual([
      "/api/sessions/s%201/trace",
      "/api/sessions/s1/trace?before=r%209",
      "/api/steps/st%201",
      "/api/sessions/s1/fork-preview?messageId=m%201",
      "/api/edits?limit=50",
      "/api/edits?limit=10",
    ]);
    expect(header(calls(fetchMock)[0]![1], "x-rei")).toBeUndefined();
  });

  it("words the new errors for people", () => {
    expect(describeError(new ApiError(409, "not_editable", ""))).toMatch(/can't be edited/i);
    expect(describeError(new ApiError(409, "already_submitted", ""))).toBe("This form was already submitted.");
    expect(describeError(new ApiError(400, "bad_event", ""))).toMatch(/didn't match/);
  });
});

describe("api client: triggers and skills", () => {
  it("uses the right method, path and body for each call", async () => {
    const seen: string[] = [];
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (path: string, init: RequestInit) => {
      seen.push(`${init.method} ${path}`);
      bodies.push(init.body === undefined ? undefined : JSON.parse(init.body as string));
      return json(200, { ok: true });
    });
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    await api.getTriggers();
    await api.getTrigger("t 1");
    await api.getTrigger("t1", "r9");
    await api.updateTrigger("t1", { paused: true });
    await api.runTrigger("t1");
    await api.deleteTrigger("t1");
    await api.deleteTrigger("t1", { withSessions: true });
    await api.getSkills();
    await api.getSkill("k1");
    await api.getSkill("k1", 2);
    await api.importSkill({ zip: "UEs=" });
    await api.updateSkill("k1", { restore: 1 });
    await api.deleteSkill("k1");
    expect(seen).toEqual([
      "GET /api/triggers",
      "GET /api/triggers/t%201",
      "GET /api/triggers/t1?before=r9",
      "PATCH /api/triggers/t1",
      "POST /api/triggers/t1/run",
      "DELETE /api/triggers/t1",
      "DELETE /api/triggers/t1?withSessions=1",
      "GET /api/skills",
      "GET /api/skills/k1",
      "GET /api/skills/k1?version=2",
      "POST /api/skills",
      "PATCH /api/skills/k1",
      "DELETE /api/skills/k1",
    ]);
    expect(bodies[3]).toEqual({ paused: true });
    expect(bodies[10]).toEqual({ zip: "UEs=" });
    expect(bodies[11]).toEqual({ restore: 1 });
  });

  it("describes errors from these endpoints with the server's own sentence for bad_request", () => {
    expect(describeSetupError(new ApiError(404, "not_found", ""))).toBe("That no longer exists.");
    expect(describeSetupError(new ApiError(400, "bad_request", "The schedule's time zone is unknown."))).toBe(
      "The schedule's time zone is unknown.",
    );
  });
});

describe("api client: notifications", () => {
  it("uses the right paths, methods and bodies, with the CSRF header on writes", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const api = createApi({ fetch: fetchMock as unknown as typeof fetch });
    const subscription = { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "p", auth: "a" } };
    await api.registerChannel({ kind: "webpush", subscription });
    await api.removeChannel("ch_1");
    await api.postPresence({ visible: true, idleMs: 5 });
    await api.testNotifications();
    fetchMock.mockImplementationOnce(async () => json(200, { devices: 1, preview: false }));
    await api.updatePreview(false);
    fetchMock.mockImplementationOnce(async () => json(200, { publicKey: "BKey" }));
    expect((await api.getPushKey()).publicKey).toBe("BKey");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      "POST /api/devices/current/channels",
      "DELETE /api/devices/current/channels/ch_1",
      "POST /api/devices/current/presence",
      "POST /api/notifications/test",
      "PUT /api/notifications/preview",
      "GET /api/push/key",
    ]);
    expect(calls[0]![1].body).toBe(JSON.stringify({ kind: "webpush", subscription }));
    expect(calls[2]![1].body).toBe(JSON.stringify({ visible: true, idleMs: 5 }));
    for (const i of [0, 1, 2, 3, 4]) expect(header(calls[i]![1], "x-rei")).toBe("1");
    expect(header(calls[5]![1], "x-rei")).toBeUndefined();
  });

  it("words the notification errors", () => {
    expect(describeError(new ApiError(400, "no_destinations", "x"))).toBe(
      "Turn on notifications on this device first.",
    );
  });
});

it("keeps the current session when authenticator reauthentication fails", async () => {
  const onUnauthorized = vi.fn();
  const api = createApi({
    fetch: (async () =>
      new Response(JSON.stringify({ error: { code: "bad_credentials", message: "Wrong password" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    onUnauthorized,
  });
  await expect(api.startTotp("wrong")).rejects.toBeInstanceOf(ApiError);
  expect(onUnauthorized).not.toHaveBeenCalled();
});
