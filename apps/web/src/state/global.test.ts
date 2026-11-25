import type { Agent, Approval, GlobalEvent } from "@rei/protocol";
import { describe, expect, it } from "vitest";
import { approval, session, takeover } from "../test/fixtures.ts";
import type { GlobalState } from "./global.ts";
import {
  globalReducer,
  initialGlobalState,
  selectActiveAgentId,
  selectPendingApprovals,
  selectPendingInSession,
  selectPendingTakeovers,
  selectSessions,
} from "./global.ts";

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "a1",
  name: "Dot",
  avatar: "D",
  model: null,
  thinkingLevel: "off",
  networkMode: "block",
  defaultProfile: "standard",
  homeSessionId: "home1",
  ...over,
});
const ev = (event: GlobalEvent, cursor?: string) => ({ type: "event" as const, event, ...(cursor ? { cursor } : {}) });
const snapshot = (cursor: string, sessions = [session()]): GlobalEvent => ({
  type: "snapshot",
  cursor,
  agents: [agent()],
  defaultAgentId: "a1",
  companion: { agentId: "a1", homeSessionId: "" },
  sessions,
  approvals: [],
  takeovers: [],
});

describe("globalReducer", () => {
  it("keeps the companion from the snapshot and follows companion.changed", () => {
    let s: GlobalState = globalReducer(initialGlobalState, ev(snapshot("5")));
    expect(s.companion).toEqual({ agentId: "a1", homeSessionId: "" });
    s = globalReducer(s, ev({ type: "companion.changed", companion: { agentId: "a2", homeSessionId: "h2" } }, "6"));
    expect(s.companion).toEqual({ agentId: "a2", homeSessionId: "h2" });
    expect(s.cursor).toBe("6");
  });

  it("snapshot replaces the state", () => {
    let s: GlobalState = globalReducer(initialGlobalState, ev(snapshot("5", [session({ id: "x" })])));
    expect(s.ready).toBe(true);
    expect(s.sessions.map((x) => x.id)).toEqual(["x"]);
    s = globalReducer(s, ev(snapshot("9", [session({ id: "y" })])));
    expect(s.sessions.map((x) => x.id)).toEqual(["y"]);
    expect(s.cursor).toBe("9");
  });

  it("applies a replay in order", () => {
    let s = globalReducer(initialGlobalState, ev(snapshot("5")));
    s = globalReducer(s, ev({ type: "session.upserted", session: session({ id: "s2", title: "Two" }) }, "6"));
    s = globalReducer(s, ev({ type: "session.upserted", session: session({ title: "Renamed" }) }, "7"));
    s = globalReducer(s, ev({ type: "session.removed", sessionId: "s2" }, "8"));
    expect(s.cursor).toBe("8");
    expect(s.sessions.map((x) => x.title)).toEqual(["Renamed"]);
  });

  it("ignores a duplicate or older cursor", () => {
    let s = globalReducer(initialGlobalState, ev(snapshot("5")));
    s = globalReducer(s, ev({ type: "session.upserted", session: session({ title: "New" }) }, "7"));
    const same = globalReducer(s, ev({ type: "session.upserted", session: session({ title: "Dup" }) }, "7"));
    const older = globalReducer(s, ev({ type: "session.upserted", session: session({ title: "Old" }) }, "6"));
    expect(same).toBe(s);
    expect(older).toBe(s);
    expect(s.sessions[0]?.title).toBe("New");
  });

  it("compares cursors numerically, not as strings", () => {
    let s = globalReducer(initialGlobalState, ev(snapshot("9")));
    s = globalReducer(s, ev({ type: "session.upserted", session: session({ title: "Ten" }) }, "10"));
    expect(s.cursor).toBe("10");
  });

  it("selectSessions sorts newest first and leaves out home chats", () => {
    const s = globalReducer(
      initialGlobalState,
      ev(
        snapshot("1", [
          session({ id: "old", updatedAt: 1 }),
          session({ id: "new", updatedAt: 9 }),
          session({ id: "home1", origin: "home", updatedAt: 99 }),
        ]),
      ),
    );
    expect(selectSessions(s).map((x) => x.id)).toEqual(["new", "old"]);
  });

  it("session.removed drops the session, and children keep a null parent through their own upserts", () => {
    let s = globalReducer(
      initialGlobalState,
      ev(
        snapshot("1", [session({ id: "p" }), session({ id: "c", origin: "spawned", parentSessionId: "p", depth: 1 })]),
      ),
    );
    s = globalReducer(s, ev({ type: "session.removed", sessionId: "p" }, "2"));
    s = globalReducer(
      s,
      ev(
        { type: "session.upserted", session: session({ id: "c", origin: "spawned", parentSessionId: null, depth: 1 }) },
        "3",
      ),
    );
    expect(s.sessions.map((x) => x.id)).toEqual(["c"]);
    expect(s.sessions[0]?.parentSessionId).toBeNull();
  });

  it("selectSessions keeps spawned sessions and forks in the list", () => {
    const s = globalReducer(
      initialGlobalState,
      ev(
        snapshot("1", [
          session({ id: "p", updatedAt: 1 }),
          session({ id: "c", origin: "spawned", parentSessionId: "p", depth: 1, updatedAt: 2 }),
          session({ id: "f", origin: "fork", forkedFrom: { sessionId: "p", messageId: "m1" }, updatedAt: 3 }),
        ]),
      ),
    );
    expect(selectSessions(s).map((x) => x.id)).toEqual(["f", "c", "p"]);
  });
});

describe("approvals in the global state", () => {
  const ap = (id: string, over: Partial<Approval> = {}) => approval({ id, ...over });

  it("takes only pending approvals from the snapshot, and copes with a snapshot that has none", () => {
    let s = globalReducer(
      initialGlobalState,
      ev({ ...snapshot("1"), approvals: [ap("a"), ap("b", { status: "approved" })] } as GlobalEvent),
    );
    expect(s.approvals.map((a) => a.id)).toEqual(["a"]);
    const { approvals: _gone, ...old } = snapshot("2") as GlobalEvent & { approvals: Approval[] };
    s = globalReducer(s, ev(old as GlobalEvent));
    expect(s.approvals).toEqual([]);
  });

  it("approval.upserted adds a pending approval, updates it in place, and drops it once decided", () => {
    let s = globalReducer(initialGlobalState, ev(snapshot("1")));
    s = globalReducer(s, ev({ type: "approval.upserted", approval: ap("a", { sessionId: "s1" }) }, "2"));
    s = globalReducer(s, ev({ type: "approval.upserted", approval: ap("b", { sessionId: "s2" }) }, "3"));
    s = globalReducer(
      s,
      ev({ type: "approval.upserted", approval: ap("a", { sessionId: "s1", summary: "changed" }) }, "4"),
    );
    expect(s.approvals.map((a) => [a.id, a.summary === "changed"])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(selectPendingInSession(s, "s2").map((a) => a.id)).toEqual(["b"]);
    expect(selectPendingApprovals(s)).toHaveLength(2);
    s = globalReducer(s, ev({ type: "approval.upserted", approval: ap("a", { status: "approved" }) }, "5"));
    expect(s.approvals.map((a) => a.id)).toEqual(["b"]);
    s = globalReducer(s, ev({ type: "approval.upserted", approval: ap("b", { status: "expired" }) }, "6"));
    expect(s.approvals).toEqual([]);
    expect(s.cursor).toBe("6");
  });

  it("ignores a stale approval event, and drops a removed session's approvals", () => {
    let s = globalReducer(initialGlobalState, ev(snapshot("5")));
    s = globalReducer(s, ev({ type: "approval.upserted", approval: ap("a", { sessionId: "s1" }) }, "6"));
    expect(globalReducer(s, ev({ type: "approval.upserted", approval: ap("z") }, "6"))).toBe(s);
    s = globalReducer(s, ev({ type: "session.removed", sessionId: "s1" }, "7"));
    expect(s.approvals).toEqual([]);
  });

  describe("takeovers", () => {
    it("keeps pending and active ones from the snapshot, and drops finished ones", () => {
      const s = globalReducer(
        initialGlobalState,
        ev({
          ...(snapshot("1") as object),
          takeovers: [takeover(), takeover({ id: "t2", status: "active" }), takeover({ id: "t3", status: "done" })],
        } as GlobalEvent),
      );
      expect(s.takeovers.map((t) => t.id)).toEqual(["t1", "t2"]);
      expect(selectPendingTakeovers(s).map((t) => t.id)).toEqual(["t1"]);
    });

    it("upserts an open takeover and removes it once it is done or cancelled", () => {
      let s = globalReducer(initialGlobalState, ev(snapshot("1")));
      s = globalReducer(s, ev({ type: "takeover.upserted", takeover: takeover() }, "2"));
      s = globalReducer(s, ev({ type: "takeover.upserted", takeover: takeover({ status: "active" }) }, "3"));
      expect(s.takeovers.map((t) => t.status)).toEqual(["active"]);
      s = globalReducer(s, ev({ type: "takeover.upserted", takeover: takeover({ status: "cancelled" }) }, "4"));
      expect(s.takeovers).toEqual([]);
    });

    it("drops a removed session's takeovers", () => {
      let s = globalReducer(initialGlobalState, ev(snapshot("1")));
      s = globalReducer(s, ev({ type: "takeover.upserted", takeover: takeover() }, "2"));
      s = globalReducer(s, ev({ type: "session.removed", sessionId: "s1" }, "3"));
      expect(s.takeovers).toEqual([]);
    });
  });

  it("agent.upserted replaces an agent's look, and adds a new agent", () => {
    let s = globalReducer(initialGlobalState, ev(snapshot("5")));
    s = globalReducer(s, ev({ type: "agent.upserted", agent: agent({ avatar: "bot:cat" }) }, "6"));
    expect(s.agents).toHaveLength(1);
    expect(s.agents[0]?.avatar).toBe("bot:cat");
    s = globalReducer(s, ev({ type: "agent.upserted", agent: agent({ id: "a2", name: "Rex" }) }, "7"));
    expect(s.agents.map((a) => a.id)).toEqual(["a1", "a2"]);
  });
});

describe("selectSessions: trigger runs", () => {
  const base: GlobalState = { ...initialGlobalState, ready: true, agents: [agent()] };
  it("shows user-facing trigger sessions and keeps hidden ones out unless they need you or failed", () => {
    const sessions = [
      session({ id: "daily", origin: "trigger", status: "completed" }),
      session({ id: "ok", origin: "trigger", status: "completed", hideInList: true }),
      session({ id: "run", origin: "trigger", status: "running", hideInList: true }),
      session({ id: "wait", origin: "trigger", status: "waiting_for_user", hideInList: true }),
      session({ id: "ask", origin: "trigger", status: "running", pendingApprovals: 1, hideInList: true }),
      session({ id: "bad", origin: "trigger", status: "failed", hideInList: true }),
      session({ id: "plain", origin: "user" }),
    ];
    expect(
      selectSessions({ ...base, sessions })
        .map((x) => x.id)
        .sort(),
    ).toEqual(["ask", "bad", "daily", "plain", "wait"]);
    expect(
      selectSessions({ ...base, sessions }, undefined, undefined, true)
        .map((x) => x.id)
        .sort(),
    ).toEqual(["ask", "bad", "daily", "ok", "plain", "run", "wait"]);
  });
});

describe("agent.removed", () => {
  it("drops the agent with its sessions, approvals and takeovers, and leaves the others", () => {
    let s = globalReducer(
      initialGlobalState,
      ev({
        type: "snapshot",
        cursor: "1",
        agents: [agent(), agent({ id: "a2", homeSessionId: "h2" })],
        defaultAgentId: "a1",
        companion: { agentId: "a1", homeSessionId: "" },
        sessions: [
          session({ id: "s1" }),
          session({ id: "h2", agentId: "a2", origin: "home" }),
          session({ id: "s2", agentId: "a2" }),
        ],
        approvals: [approval({ sessionId: "s2", agentId: "a2" })],
        takeovers: [takeover({ sessionId: "s2" })],
      }),
    );
    s = globalReducer(s, ev({ type: "agent.removed", agentId: "a2" }, "2"));
    expect(s.agents.map((a) => a.id)).toEqual(["a1"]);
    expect(s.sessions.map((x) => x.id)).toEqual(["s1"]);
    expect(s.approvals).toEqual([]);
    expect(s.takeovers).toEqual([]);
    expect(s.cursor).toBe("2");
  });

  it("ignores a stale one", () => {
    let s = globalReducer(
      initialGlobalState,
      ev({
        type: "snapshot",
        cursor: "5",
        agents: [agent()],
        defaultAgentId: "a1",
        companion: { agentId: "a1", homeSessionId: "" },
        sessions: [],
        approvals: [],
        takeovers: [],
      }),
    );
    s = globalReducer(s, ev({ type: "agent.removed", agentId: "a1" }, "4"));
    expect(s.agents).toHaveLength(1);
  });
});

describe("selectSessions: one agent", () => {
  const base: GlobalState = {
    ...initialGlobalState,
    ready: true,
    agents: [agent(), agent({ id: "a2", homeSessionId: "h2" })],
    defaultAgentId: "a1",
  };
  const sessions = [
    session({ id: "s1", updatedAt: 1 }),
    session({ id: "s2", agentId: "a2", updatedAt: 2 }),
    session({ id: "home1", origin: "home" }),
    session({ id: "t1", agentId: "a2", origin: "trigger", status: "completed", hideInList: true }),
  ];
  it("filters by agent, keeping the home and trigger exclusions, and no agent means all", () => {
    expect(selectSessions({ ...base, sessions }, "a2").map((x) => x.id)).toEqual(["s2"]);
    expect(selectSessions({ ...base, sessions }, "a1").map((x) => x.id)).toEqual(["s1"]);
    expect(selectSessions({ ...base, sessions }).map((x) => x.id)).toEqual(["s2", "s1"]);
  });
});

describe("selectActiveAgentId", () => {
  const base: GlobalState = {
    ...initialGlobalState,
    ready: true,
    agents: [agent(), agent({ id: "a2", homeSessionId: "h2" })],
    defaultAgentId: "a2",
    sessions: [session({ id: "s1" })],
  };
  it("is the open chat's agent, else the default agent, else the first", () => {
    expect(selectActiveAgentId(base, "s1")).toBe("a1");
    expect(selectActiveAgentId(base, null)).toBe("a2");
    expect(selectActiveAgentId(base, "gone")).toBe("a2");
    expect(selectActiveAgentId({ ...base, defaultAgentId: null }, null)).toBe("a1");
    expect(selectActiveAgentId(initialGlobalState, null)).toBeNull();
  });
});

describe("paged session hydration", () => {
  it("does not resurrect deleted chats or overwrite newer live updates", () => {
    let state = globalReducer(initialGlobalState, ev(snapshot("1")));
    const version = state.snapshotVersion;
    state = globalReducer(state, ev({ type: "session.removed", sessionId: "gone" }, "2"));
    state = globalReducer(
      state,
      ev({ type: "session.upserted", session: session({ id: "live", updatedAt: 10, title: "Live title" }) }, "3"),
    );
    state = globalReducer(state, {
      type: "hydrate",
      snapshotVersion: version,
      sessions: [
        session({ id: "gone" }),
        session({ id: "live", updatedAt: 1, title: "Old title" }),
        session({ id: "older" }),
      ],
    });
    expect(state.sessions.find((s) => s.id === "gone")).toBeUndefined();
    expect(state.sessions.find((s) => s.id === "live")?.title).toBe("Live title");
    expect(state.sessions.find((s) => s.id === "older")).toBeDefined();
    state = globalReducer(state, ev(snapshot("4")));
    state = globalReducer(state, { type: "hydrate", snapshotVersion: version, sessions: [session({ id: "stale" })] });
    expect(state.sessions.find((s) => s.id === "stale")).toBeUndefined();
  });
});
