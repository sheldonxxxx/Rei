import type { Message, ReiConversationViewV2, SessionEvent } from "@rei/protocol";
import { describe, expect, it } from "vitest";
import { message, run, session } from "../test/fixtures.ts";
import type { SessionState } from "./session.ts";
import { continuable, initialSessionState, isRunning, sessionReducer } from "./session.ts";

const ev = (event: SessionEvent) => ({ type: "event" as const, event });
const view = (over: Partial<ReiConversationViewV2> = {}): ReiConversationViewV2 => ({
  version: 2,
  session: session(),
  items: [message({ id: "u:r1", role: "user", runId: "r1", status: "complete", text: "hi", requestId: "q1" })],
  runs: [],
  before: null,
  live: { runId: null },
  overlays: [],
  ...over,
});
const snap = (over: Partial<ReiConversationViewV2> = {}, epoch = "e1"): SessionEvent => ({
  type: "snapshot",
  epoch,
  rev: 0,
  view: view(over),
});
const patch = (
  rev: number,
  body: Omit<Extract<SessionEvent, { type: "patch" }>, "type" | "epoch" | "rev">,
  epoch = "e1",
) => ev({ type: "patch", epoch, rev, ...body });
const reduce = (s: SessionState, ...actions: Parameters<typeof sessionReducer>[1][]) =>
  actions.reduce(sessionReducer, s);
const ids = (s: SessionState) => s.messages.map((m) => m.id);
const items = (n: number, from = 0): Message[] =>
  Array.from({ length: n }, (_, i) =>
    message({ id: `e:${from + i}`, role: "notice", text: `n${from + i}`, status: "complete" }),
  );

describe("sessionReducer: the session stream", () => {
  it("a snapshot replaces the view; messages, runs and session come from it", () => {
    let s = reduce(initialSessionState, ev(snap()));
    expect(s.ready).toBe(true);
    expect(ids(s)).toEqual(["u:r1"]);
    s = reduce(s, ev(snap({ items: [], runs: [run()] }, "e2")));
    expect(s.messages).toEqual([]);
    expect(s.runs).toHaveLength(1);
    expect(s.view?.epoch).toBe("e2");
  });

  it("folds patches in rev order: upserts, the window's order, runs and live", () => {
    let s = reduce(initialSessionState, ev(snap()));
    s = reduce(
      s,
      patch(1, {
        upsert: [message({ id: "a:r1", runId: "r1", text: "Hel", status: "streaming" })],
        runs: [run()],
        live: { runId: "r1" },
      }),
      patch(2, { upsert: [message({ id: "a:r1", runId: "r1", text: "Hello", status: "streaming" })] }),
    );
    expect(ids(s)).toEqual(["u:r1", "a:r1"]);
    expect(s.messages[1]!.text).toBe("Hello");
    expect(isRunning(s)).toBe(true);
    s = reduce(s, patch(3, { remove: ["a:r1"], live: { runId: null }, runs: [run({ status: "completed" })] }));
    expect(ids(s)).toEqual(["u:r1"]);
    expect(isRunning(s)).toBe(false);
  });

  it("asks for a resync on a rev gap, another epoch or resync_required, and a snapshot clears it", () => {
    const base = reduce(initialSessionState, ev(snap()));
    const gap = reduce(base, patch(2, { live: { runId: null } }));
    expect(gap.resync).toBe(true);
    expect(gap.view).toBe(base.view);
    expect(reduce(base, patch(1, { live: { runId: null } }, "other")).resync).toBe(true);
    expect(reduce(base, ev({ type: "resync_required", epoch: "e1", rev: 1 })).resync).toBe(true);
    // A patch before any snapshot cannot be placed either.
    expect(reduce(initialSessionState, patch(1, {})).resync).toBe(true);
    const back = reduce(gap, ev(snap({}, "e9")));
    expect(back.resync).toBe(false);
    expect(back.view?.epoch).toBe("e9");
  });

  it("marks the chat removed on session.removed", () => {
    const s = reduce(initialSessionState, ev(snap()), ev({ type: "session.removed", sessionId: "s1" }));
    expect(s.removed).toBe(true);
  });
});

describe("sessionReducer: older history", () => {
  it("pages back past the window and keeps the pages joined as the window slides", () => {
    // A chat of 150 items: the window holds the newest 100.
    let s = reduce(initialSessionState, ev(snap({ items: items(100, 50), before: "e:49" })));
    expect(s.before).toBe("e:49");
    s = reduce(s, { type: "earlier.loaded", from: "e:49", items: items(30, 20), before: "e:19" });
    s = reduce(s, { type: "earlier.loaded", from: "e:19", items: items(20, 0), before: null });
    expect(ids(s)).toEqual(items(150).map((m) => m.id));
    expect(s.before).toBeNull();
    // A late answer to a request already made is dropped.
    expect(reduce(s, { type: "earlier.loaded", from: "e:49", items: items(30, 20), before: "e:19" })).toBe(s);
    // A new item pushes the oldest out of the window; it moves to the loaded pages, so nothing goes missing.
    const next = items(1, 150)[0]!;
    s = reduce(s, patch(1, { upsert: [next], order: [...items(99, 51).map((m) => m.id), next.id], before: "e:50" }));
    expect(ids(s)).toEqual(items(151).map((m) => m.id));
  });

  it("drops loaded pages that no longer join a fresh snapshot, and keeps those that do", () => {
    let s = reduce(initialSessionState, ev(snap({ items: items(100, 50), before: "e:49" })));
    s = reduce(s, { type: "earlier.loaded", from: "e:49", items: items(50, 0), before: null });
    const joined = reduce(s, ev(snap({ items: items(100, 50), before: "e:49" }, "e2")));
    expect(joined.messages).toHaveLength(150);
    const far = reduce(s, ev(snap({ items: items(100, 400), before: "e:399" }, "e3")));
    expect(far.messages).toHaveLength(100);
    expect(far.before).toBe("e:399");
  });

  it("a rewound chat's snapshot keeps only the loaded items still before its window, never the replaced tail", () => {
    // 200 items: 0-99 loaded as pages, 100-199 in the window.
    let s = reduce(initialSessionState, ev(snap({ items: items(100, 100), before: "e:99" })));
    s = reduce(s, { type: "earlier.loaded", from: "e:99", items: items(100, 0), before: null });
    // Rewound at item 60: the chat is items 0-59 and the new message; its window is the newest 50 of them.
    const rewound = [...items(50, 10), message({ id: "u:new", role: "user", text: "again", status: "complete" })];
    const deep = reduce(s, ev(snap({ items: rewound, before: "e:9" }, "e2")));
    expect(ids(deep)).toEqual([...items(60).map((m) => m.id), "u:new"]);
    // Rewound near the start: the window holds the whole chat, so nothing loaded stays.
    const short = reduce(
      s,
      ev(
        snap(
          {
            items: [...items(5), message({ id: "u:new", role: "user", text: "again", status: "complete" })],
            before: null,
          },
          "e3",
        ),
      ),
    );
    expect(ids(short)).toEqual([...items(5).map((m) => m.id), "u:new"]);
    expect(short.before).toBeNull();
  });
});

describe("sessionReducer: markers and failures", () => {
  it("shows compaction and reset markers as items", () => {
    const s = reduce(
      initialSessionState,
      ev(
        snap({
          items: [
            message({ id: "e:4", role: "compaction", text: "Earlier messages were summarized", status: "complete" }),
            message({ id: "e:9", role: "reset", text: "A new context started here.", status: "complete" }),
          ],
        }),
      ),
    );
    expect(s.messages.map((m) => m.role)).toEqual(["compaction", "reset"]);
  });

  it.each(["model_error", "max_turns", "provider_overloaded", "context_overflow", "tool_error"])(
    "offers Continue after a %s failure when the server allows it",
    (reason) => {
      const failure = { runId: "r1", reason, error: { code: reason, message: "It stopped." }, canContinue: true };
      const s = reduce(initialSessionState, ev(snap({ live: { runId: null, runFailure: failure } })));
      expect(continuable(s)).toEqual(failure);
    },
  );

  it("offers no Continue after an aborted or reset run, or while a run is going", () => {
    for (const reason of ["aborted", "reset"]) {
      const failure = { runId: "r1", reason, error: { code: reason, message: "x" }, canContinue: false };
      expect(
        continuable(reduce(initialSessionState, ev(snap({ live: { runId: null, runFailure: failure } })))),
      ).toBeUndefined();
    }
    const failure = {
      runId: "r1",
      reason: "model_error",
      error: { code: "model_error", message: "x" },
      canContinue: true,
    };
    expect(
      continuable(reduce(initialSessionState, ev(snap({ live: { runId: "r2", runFailure: failure } })))),
    ).toBeUndefined();
  });
});

describe("sessionReducer: local sends", () => {
  it("keeps a send pending until the view shows its request id", () => {
    let s = reduce(initialSessionState, ev(snap({ items: [] })));
    s = reduce(s, { type: "local.add", requestId: "q1", text: "hi", now: 1 });
    expect(s.pending).toHaveLength(1);
    s = reduce(
      s,
      patch(1, { upsert: [message({ id: "u:r1", role: "user", text: "hi", requestId: "q1", status: "complete" })] }),
    );
    expect(s.pending).toHaveLength(0);
  });

  it("matches by the message id the POST returned when the item carries no request id", () => {
    let s = reduce(initialSessionState, ev(snap({ items: [] })));
    s = reduce(s, { type: "local.add", requestId: "q1", text: "hi", now: 1 });
    s = reduce(s, { type: "local.sent", requestId: "q1", messageId: "u:r1" });
    expect(s.pending[0]).toMatchObject({ sending: false, messageId: "u:r1" });
    s = reduce(s, patch(1, { upsert: [message({ id: "u:r1", role: "user", text: "hi", status: "complete" })] }));
    expect(s.pending).toHaveLength(0);
  });

  it("does not take another message with the same text for a pending send", () => {
    let s = reduce(initialSessionState, ev(snap({ items: [] })));
    s = reduce(s, { type: "local.add", requestId: "q2", text: "hi", now: 1 });
    s = reduce(
      s,
      patch(1, { upsert: [message({ id: "u:r9", role: "user", text: "hi", requestId: "other", status: "complete" })] }),
    );
    expect(s.pending).toHaveLength(1);
  });

  it("marks a failed send and retries it", () => {
    let s = reduce(initialSessionState, { type: "local.add", requestId: "q1", text: "hi", now: 1 });
    s = reduce(s, { type: "local.failed", requestId: "q1", error: "offline" });
    expect(s.pending[0]).toMatchObject({ error: "offline", sending: false });
    s = reduce(s, { type: "local.retry", requestId: "q1" });
    expect(s.pending[0]!.error).toBeUndefined();
    expect(s.pending[0]!.sending).toBe(true);
  });

  it("trusts the session status for running until runs are known", () => {
    const s = reduce(initialSessionState, ev(snap({ session: session({ status: "running" }), items: [] })));
    expect(isRunning(s)).toBe(true);
  });
});

describe("sessionReducer: sends with skills", () => {
  it("a pending message carries its skills until the conversation shows it", () => {
    const skills = [{ id: "k1", version: 2, name: "acme/review" }];
    let s = reduce(initialSessionState, ev(snap({ items: [] })));
    s = reduce(s, { type: "local.add", requestId: "q9", text: "Review", now: 1, selectedSkills: skills });
    expect(s.pending[0]?.selectedSkills).toEqual(skills);
    s = reduce(s, { type: "local.sent", requestId: "q9", messageId: "u:r9" });
    expect(s.pending[0]?.selectedSkills).toEqual(skills);
    s = reduce(
      s,
      patch(1, {
        upsert: [message({ id: "u:r9", role: "user", status: "complete", text: "Review", requestId: "q9" })],
        order: ["u:r9"],
      }),
    );
    expect(s.pending).toEqual([]);
  });
});
