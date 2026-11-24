import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { HomeBudgetCompactionDoc, HomeIdleCompactionDoc } from "../src/pi/home-compaction.ts";
import { DEFAULT_HOME_CONTEXT, selectHomeMessages } from "../src/pi/home-context.ts";
import { until } from "./helpers/client.ts";
import { type FakeGateway, startFakeGateway } from "./helpers/fake-gateway.ts";
import { STANDIN, startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";
import { chat, detail, homeChat, say, settled, stepPayloads, treeOf } from "./helpers/sessions.ts";

let server: TestServer | undefined;
let gateway: FakeGateway | undefined;
afterEach(async () => {
  await server?.destroy();
  await gateway?.close();
  server = undefined;
  gateway = undefined;
});
const msg = (role: string, content: string) => ({ role, content });

describe("home context selection", () => {
  it("defaults to one hour and preserves tool groups and instructions", () => {
    expect(DEFAULT_HOME_CONTEXT.idleGapMs).toBe(3_600_000);
    const messages = [
      msg("system", "instructions"),
      msg("user", "old ".repeat(1000)),
      msg("assistant", "old answer"),
      msg("user", "recent"),
      msg("assistant", "call"),
      msg("toolResult", "result"),
      msg("assistant", "answer"),
      msg("user", "new"),
    ];
    const selected = selectHomeMessages(messages, 150);
    expect(selected).toEqual([messages[0], ...messages.slice(3)]);
  });
  it("budgets complete turns and preserves the current tool chain even over its soft budget", () => {
    const messages = [
      msg("system", "keep"),
      msg("user", "old ".repeat(1000)),
      msg("assistant", "old answer"),
      msg("user", "current"),
      msg("assistant", "call"),
      msg("toolResult", "result"),
    ];
    expect(selectHomeMessages(messages, 1)).toEqual([messages[0], ...messages.slice(3)]);
  });
  it("handles a large repetitive current report without dropping its tool chain", () => {
    const messages = [msg("user", "x".repeat(64_000)), msg("assistant", "call"), msg("toolResult", "result")];
    expect(selectHomeMessages(messages, 1)).toEqual(messages);
  });
  it("never drops the latest human message for a large report or tool result after it", () => {
    const messages = [
      msg("system", "keep"),
      msg("user", "QUESTION"),
      msg("assistant", "started a worker"),
      msg("user", "[Session report] done"),
      msg("assistant", "call read_chat"),
      msg("toolResult", "r ".repeat(5000)),
    ];
    const selected = selectHomeMessages(messages, 100, (t) => t === "QUESTION");
    expect(selected).toEqual(messages);
    // Without protection the report run alone is kept, as before.
    expect(selectHomeMessages(messages, 100)).toEqual([messages[0], ...messages.slice(3)]);
  });
  it("moves the window start in quarter-budget steps, not on every call", () => {
    const turn = (n: number) => [
      msg("user", `q${n} ${"w ".repeat(300)}`),
      msg("assistant", `a${n} ${"w ".repeat(300)}`),
    ];
    const starts: string[] = [];
    let messages: { role: string; content: string }[] = [msg("system", "keep")];
    for (let n = 0; n < 40; n++) {
      messages = [...messages, ...turn(n)];
      const selected = selectHomeMessages(messages, 6_000);
      starts.push(selected[1]!.content.split(" ")[0]!);
    }
    const moves = starts.filter((s, i) => i > 0 && s !== starts[i - 1]!).length;
    expect(starts.at(-1)).not.toBe("q0");
    // ~600 tokens per turn against a 1,500-token step: the start moves at most every other turn.
    expect(moves).toBeLessThanOrEqual(Math.ceil(starts.length / 2));
  });
  it("keeps human follow-ups in context after an overnight gap", async () => {
    server = await startSignedIn();
    const home = homeChat(server);
    for (let n = 0; n < 8; n++) {
      if (n) server.clock.advance(10 * 60_000);
      await say(server, home, `context-marker-${n} [len=40]`);
      await settled(server, home, n + 1);
    }
    expect(stepPayloads(server, home).at(-1)).toContain("context-marker-0");
    server.clock.advance(24 * 60 * 60_000);
    await say(server, home, "fresh-cluster [len=40]");
    await settled(server, home, 9);
    const after = stepPayloads(server, home).at(-1)!;
    expect(after).toContain("context-marker-0");
    expect(after).toContain("fresh-cluster");
    expect((await detail(server, home)).messages.filter((m) => m.role === "user")).toHaveLength(9);
    server.clock.advance(5 * 60_000);
    await say(server, home, "still-active [len=40]");
    await settled(server, home, 10);
    expect(stepPayloads(server, home).at(-1)).toContain("fresh-cluster");
    expect(stepPayloads(server, home).at(-1)).toContain("context-marker-0");
  });
  it("preserves human history in the actual provider request after the idle threshold", async () => {
    gateway = await startFakeGateway({ bearer: STANDIN, behavior: () => ({ kind: "text", text: "A helpful reply." }) });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const home = homeChat(server);
    await say(server, home, "old-provider-marker");
    await settled(server, home);
    await say(server, home, "recent-provider-marker");
    await settled(server, home, 2);
    server.clock.advance(60 * 60_000);
    const beforeIdleCheck = gateway.seen.length;
    const trees = server.host.plane.adapter.trees;
    await trees.compactIdleHomes();
    const { conv } = trees.get(treeOf(server, home))!.session(home)!;
    const quietCheck = await conv.commit(
      async (tx) => (await tx.doc(HomeIdleCompactionDoc, conv.id)).checkedRun,
      BACKGROUND_CONTEXT,
    );
    expect(quietCheck).toBeDefined();
    expect(gateway.seen.length).toBe(beforeIdleCheck);
    await say(server, home, "fresh-provider-marker");
    await settled(server, home, 3);
    const actual = JSON.stringify(gateway.seen.at(-1)!.json.input);
    expect(actual).toContain("old-provider-marker");
    expect(actual).toContain("recent-provider-marker");
    expect(actual).toContain("fresh-provider-marker");
  });

  it("uses the same working context for background runs and human follow-ups after an idle gap", async () => {
    server = await startSignedIn();
    const home = homeChat(server);
    await say(server, home, "old-human-marker [len=40]");
    await settled(server, home);
    await say(server, home, "last-human-marker [len=40]");
    await settled(server, home, 2);
    server.clock.advance(60 * 60_000);
    await server.host.plane.adapter.commands.admit({
      sessionId: home,
      requestId: "background-check",
      role: "trigger",
      text: "No major changes",
      trigger: {
        kind: "report",
        triggerId: "test-trigger",
        triggerName: "Background check",
        triggerRunId: "test-trigger-run",
        sessionId: null,
        text: "No major changes",
      },
    });
    await settled(server, home, 3);
    expect(stepPayloads(server, home).at(-1)).toContain("old-human-marker");
    server.clock.advance(10 * 60_000);
    await say(server, home, "back-again [len=40]");
    await settled(server, home, 4);
    expect(stepPayloads(server, home).at(-1)).toContain("old-human-marker");
  });

  it("budgets only the effective system prompt and saves the previous tool exchange after a short pause", () => {
    const old = [msg("user", "old"), msg("assistant", "words ".repeat(740))];
    const previous = [
      msg("user", "previous question"),
      msg("assistant", "previous call"),
      msg("toolResult", "output ".repeat(830)),
      msg("assistant", "previous answer"),
    ];
    const updates = Array.from({ length: 5 }, (_, timestamp) => ({
      ...msg("system", ""),
      timestamp,
      sections: { pointer: "obsolete ".repeat(1000) },
    }));
    const currentUpdate = { ...msg("system", ""), timestamp: 8, sections: { pointer: "current" } };
    const current = msg("user", "five-minute follow-up");
    const messages = [...old, ...updates, ...previous, currentUpdate, current];
    const select = (midConversationSystem: boolean) =>
      selectHomeMessages(messages, 1000, undefined, undefined, {
        midConversationSystem,
      });
    expect(select(true)).not.toContain(previous[0]);
    expect(select(false)).toEqual([...updates, ...previous, currentUpdate, current]);
  });

  it("keeps Pi's summary when the old complete groups must be trimmed", () => {
    const summary = msg(
      "user",
      "The conversation history before this point was compacted into the following summary:\n\n<summary>\nKeep launch on Friday.\n</summary>",
    );
    const current = msg("user", "when are we launching?");
    const messages = [summary, msg("user", "old"), msg("assistant", "words ".repeat(1000)), current];
    expect(selectHomeMessages(messages, 120)).toEqual([summary, current]);
  });

  it("defers Home budget compaction until the run ends and carries the summary into a follow-up", async () => {
    const reply = Promise.withResolvers<void>();
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: async (request) => {
        if (request.raw.includes("structured context checkpoint summary"))
          return { kind: "text", text: "Keep the agreed launch date." };
        if (request.raw.includes("current-plan")) await reply.promise;
        return { kind: "text", text: "Reply." };
      },
    });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const s = server;
    const home = homeChat(s);
    await s.client.call("PUT", "/api/settings/context", {
      body: { compaction: { keepRecentTokens: 100 }, home: { maxTokens: 5_000 } },
    });
    expect((await say(s, home, `planned-for-friday ${" a".repeat(1_400)}`)).status).toBe(200);
    await settled(s, home);
    try {
      expect((await say(s, home, `current-plan ${" b".repeat(1_400)}`)).status).toBe(200);
      const tree = await s.host.plane.adapter.trees.open(treeOf(s, home));
      const conv = tree.session(home)!.conv;
      await until(
        async () => {
          expect(gateway!.seen.some((r) => r.raw.includes("Keep a concise working summary"))).toBe(false);
          return conv.commit(async (tx) => {
            const budget = await tx.doc(HomeBudgetCompactionDoc, conv.id);
            const live = await tx.doc(LiveDoc, conv.id);
            expect(live.compactions ?? []).toEqual([]);
            return budget.pending;
          }, BACKGROUND_CONTEXT);
        },
        5_000,
        "the Home budget crossing to be recorded during the active run",
      );
      expect((await detail(s, home)).runs.at(-1)?.status).toBe("running");
    } finally {
      reply.resolve();
    }
    await settled(s, home, 2);
    const compacted = await until(
      async () => {
        const view = await detail(s, home);
        return view.messages.some((m) => m.role === "compaction") ? view : undefined;
      },
      8_000,
      "the Home budget compaction to be applied",
    );
    expect(compacted.messages.filter((m) => m.role === "user")).toHaveLength(2);
    const summaryRequest = gateway.seen.find((r) => r.raw.includes("Keep a concise working summary"))!;
    expect(summaryRequest.raw.includes("planned-for-friday")).toBe(true);
    // Leave ample room for the recent exchange plus the already-placed summary on the next request.
    await s.client.call("PUT", "/api/settings/context", { body: { home: { maxTokens: 15_000 } } });
    s.clock.advance(24 * 60 * 60_000);
    await say(s, home, "overnight-follow-up");
    await settled(s, home, 3);
    const followup = gateway.seen.findLast((r) => r.raw.includes("overnight-follow-up"))!.raw;
    expect(followup.includes("Keep the agreed launch date.")).toBe(true);
    expect(followup.includes("current-plan")).toBe(true);
    expect(followup.includes("planned-for-friday")).toBe(false);
  });

  it("still compacts on a model overflow before the run ends", async () => {
    let overflowed = false;
    const summary = Promise.withResolvers<void>();
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: async (request) => {
        if (request.raw.includes("structured context checkpoint summary")) {
          await summary.promise;
          return { kind: "text", text: "Earlier history." };
        }
        if (request.raw.includes("overflow-turn") && !overflowed) {
          overflowed = true;
          return {
            kind: "status",
            status: 400,
            body: JSON.stringify({
              error: { code: "context_length_exceeded", message: "This model's maximum context length was exceeded." },
            }),
          };
        }
        return { kind: "text", text: "Reply." };
      },
    });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const s = server;
    const home = homeChat(s);
    await s.client.call("PUT", "/api/settings/context", { body: { compaction: { keepRecentTokens: 100 } } });
    await say(s, home, `older context ${" a".repeat(1_400)}`);
    await settled(s, home);
    await say(s, home, "overflow-turn");
    try {
      await until(
        () => gateway!.seen.some((r) => r.raw.includes("structured context checkpoint summary")),
        5_000,
        "the overflow compaction request",
      );
      expect((await detail(s, home)).runs.at(-1)?.status).toBe("running");
    } finally {
      summary.resolve();
    }
    const done = await settled(s, home, 2);
    expect(done.runs.at(-1)?.status).toBe("completed");
    expect(done.messages.filter((m) => m.role === "compaction")).toHaveLength(1);
  });

  it("compacts an idle Home chat without a new message, keeps two recent exchanges, and attempts once", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: (request) => ({
        kind: "text",
        text: request.raw.includes("structured context checkpoint summary")
          ? "Idle checkpoint: agreed launch Friday."
          : "Reply.",
      }),
    });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const s = server;
    const home = homeChat(s);
    const trees = s.host.plane.adapter.trees;
    const tree = treeOf(s, home);
    await s.client.call("PUT", "/api/settings/context", { body: { compaction: { keepRecentTokens: 500 } } });
    const inputs = [`original-decision ${" x".repeat(2_200)}`, "recent-question-one", "recent-question-two"];
    for (const [i, input] of inputs.entries()) {
      expect((await say(s, home, input)).status).toBe(200);
      await settled(s, home, i + 1);
    }

    s.clock.advance(50 * 60_000);
    await s.host.plane.adapter.commands.admit({
      sessionId: home,
      requestId: "idle-background-check",
      role: "trigger",
      text: "Background check completed",
    });
    await settled(s, home, 4);
    await trees.compactIdleHomes();
    expect(gateway.seen.some((request) => request.raw.includes("Preserve the wording of recent human decisions"))).toBe(
      false,
    );
    await until(() => !s.host.plane.store.hasWork(tree), 2_000, "the background run to settle");
    expect(await trees.close(tree)).toBe(true);
    expect(trees.get(tree)).toBeUndefined();

    // The real tick opens the closed tree and runs compaction at the human deadline, 10 minutes after the report.
    s.clock.advance(10 * 60_000);
    const summaries = () =>
      gateway!.seen.filter((request) => request.raw.includes("Preserve the wording of recent human decisions"));
    await until(() => summaries().length === 1, 5_000, "the idle summarization call");
    await until(
      async () => (await detail(s, home)).messages.some((m) => m.role === "compaction"),
      5_000,
      "the idle summary",
    );
    expect(summaries()[0]!.raw.includes("original-decision")).toBe(true);
    expect(summaries()[0]!.raw.includes("recent-question-one")).toBe(false);
    const cookie = s.client.cookie;
    await s.stop();
    s.clock.advance(24 * 60 * 60_000);
    server = await startTestServer({ dir: s.dir, clock: s.clock, gatewayUrl: gateway.url });
    server.client.cookie = cookie;
    await server.host.plane.adapter.trees.compactIdleHomes();
    expect(summaries()).toHaveLength(1);

    await say(server, home, "return-after-idle");
    await settled(server, home, 5);
    const followup = gateway.seen.findLast((r) => r.raw.includes("return-after-idle"))!.raw;
    expect(followup.includes("Idle checkpoint: agreed launch Friday.")).toBe(true);
    expect(followup.includes("recent-question-one")).toBe(true);
    expect(followup.includes("recent-question-two")).toBe(true);
    expect(followup.includes("original-decision")).toBe(false);
    expect((await detail(server, home)).messages.some((m) => m.text.startsWith("original-decision"))).toBe(true);
  });

  it("can compact an idle chat whose latest exchanges exceed the verbatim token target", async () => {
    gateway = await startFakeGateway({
      bearer: STANDIN,
      behavior: (request) => ({
        kind: "text",
        text: request.raw.includes("Preserve the wording of recent human decisions") ? "Idle checkpoint." : "Reply.",
      }),
    });
    server = await startSignedIn({ gatewayUrl: gateway.url });
    const s = server;
    const home = homeChat(s);
    await s.client.call("PUT", "/api/settings/context", { body: { compaction: { keepRecentTokens: 500 } } });
    for (const [i, label] of ["old question", "previous question", "latest question"].entries()) {
      expect((await say(s, home, `${label} ${" details".repeat(380)}`)).status).toBe(200);
      await settled(s, home, i + 1);
    }
    s.clock.advance(60 * 60_000);
    await until(
      async () => (await detail(s, home)).messages.some((m) => m.role === "compaction"),
      5_000,
      "a summary of the long recent exchanges",
    );
    const request = gateway.seen.find((item) => item.raw.includes("Preserve the wording of recent human decisions"))!;
    expect(request.raw.includes("previous question")).toBe(true);
    expect(request.raw.includes("latest question")).toBe(false);
  });

  it("leaves normal work sessions intact across an idle gap", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    for (let n = 0; n < 3; n++) {
      if (n) server.clock.advance(2 * 60 * 60_000);
      await say(server, id, `normal-session-${n} [len=40]`);
      await settled(server, id, n + 1);
    }
    expect(stepPayloads(server, id).at(-1)).toContain("normal-session-0");
  });
});
