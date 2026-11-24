import { afterEach, describe, expect, it } from "vitest";
import { tool } from "./helpers/approvals.ts";
import { ViewReader } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { childrenOf, detail, homeChat, say, settled } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

describe("main assistant event decisions", () => {
  it("can dismiss a worker completion without publishing text, preview, or notification", async () => {
    server = await startSignedIn();
    const home = homeChat(server);
    await say(server, home, "[spawn: No changes [dismiss-event] [len=300]]");
    const result = await settled(server, home, 2);
    const event = result.messages.find((m) => m.role === "report")!;
    const reply = result.messages.find((m) => m.role === "assistant" && m.runId === event.runId)!;
    expect(reply.text).toBe("This final text must stay internal.");
    expect(reply.internal).toBe(true);
    expect(server.host.plane.store.getRun(event.runId!)!.silent).toBe(1);
    expect(result.session.preview).not.toContain("This final text");
    expect(server.host.plane.store.db.all("SELECT id FROM outbox WHERE kind = 'notify'")).toHaveLength(0);
  });
  it("can dismiss a trigger result without exposing streamed text or notifying", async () => {
    server = await startSignedIn();
    const home = homeChat(server);
    const stream = new ViewReader(await server.sse(`/api/sessions/${home}/stream`));
    try {
      await server.host.plane.adapter.commands.admit({
        sessionId: home,
        requestId: "quiet-trigger",
        role: "trigger",
        text: "Nothing useful changed [dismiss-event]",
        modelText: '[Trigger result] "Quiet check" (report)\n\nNothing useful changed [dismiss-event]',
        trigger: {
          kind: "report",
          triggerId: "trg_quiet",
          triggerName: "Quiet check",
          triggerRunId: "trr_quiet",
          sessionId: null,
          text: "Nothing useful changed [dismiss-event]",
        },
      });
      const result = await settled(server, home);
      const reply = result.messages.find((m) => m.role === "assistant")!;
      await stream.waitForView((v) => v.runs.some((r) => r.status === "completed"));
      expect(reply.internal).toBe(true);
      // Every state of the reply the stream showed was internal: its streamed text never reached the chat.
      const shown = stream.views.flatMap((v) => v.items.filter((i) => i.role === "assistant"));
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.every((m) => m.internal)).toBe(true);
      expect(server.host.plane.store.db.all("SELECT id FROM outbox WHERE kind = 'notify'")).toHaveLength(0);
      await server.host.plane.memory.history.settle();
      expect(
        server.host.plane.store.db.all(
          "SELECT id FROM history_entries WHERE message_id = ? AND kind = 'assistant'",
          reply.id,
        ),
      ).toHaveLength(0);
    } finally {
      await stream.close();
    }
  });

  it("cannot use event dismissal to suppress a direct user turn", async () => {
    server = await startSignedIn();
    const home = homeChat(server);
    await say(server, home, tool("dismiss_event", {}));
    const result = await settled(server, home);
    expect(result.messages.find((m) => m.role === "assistant")?.internal).toBeUndefined();
    expect(server.host.plane.store.getRun(result.runs[0]!.id)!.silent).toBe(0);
  });
  it("carries the worker answer up to 6000 characters as the completion preview", async () => {
    server = await startSignedIn();
    const home = homeChat(server);
    await say(server, home, "[spawn: Analyze this repository [len=6500]]");
    const result = await settled(server, home, 2);
    const [child] = await childrenOf(server, home);
    const source = await detail(server, child!.id);
    const answer = source.messages.filter((m) => m.role === "assistant").at(-1)!.text;
    expect(answer).toHaveLength(6500);
    const report = result.messages.find((m) => m.role === "report")!.report!;
    expect(report.summary).toBe(answer.slice(0, 6000));
    expect(report.resultChars).toBe(6500);
    const reply = result.messages.filter((m) => m.role === "assistant").at(-1)!;
    expect(reply.internal).toBeUndefined();
    const notify = server.host.plane.store.db.all<{ payload: string }>(
      "SELECT payload FROM outbox WHERE kind = 'notify'",
    );
    expect(notify).toHaveLength(1);
    expect(JSON.parse(notify[0]!.payload).body).toBe(reply.text.replace(/\s+/g, " ").trim().slice(0, 200));
  });
});
