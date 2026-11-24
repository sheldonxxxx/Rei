import type { Message } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { decide, setProfile, tool, waitPending } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, childrenOf, detail, homeChat, say, settled, stepPayloads } from "./helpers/sessions.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const memory = () => server!.host.plane.memory;
const store = () => server!.host.plane.store;
const lines = async () =>
  (await server!.client.get("/api/memory")).body as {
    profile: { id: string; text: string; source: { sessionId: string } | null; confirmedAt: number }[];
    agents: { agentId: string; lines: { id: string; text: string }[] }[];
    usedTokens: number;
  };
const texts = async () => (await lines()).profile.map((l) => l.text);
const talk = async (id: string, text: string) => {
  const before = (await detail(server!, id)).runs.length;
  await say(server!, id, text);
  return settled(server!, id, before + 1);
};
const chips = (d: { messages: Message[] }) => d.messages.filter((m) => m.role === "memory");
const add = (text: string, doc?: string) => tool("memory_add", { text, ...(doc ? { doc } : {}) });
/** What the model saw in its last call: the prompt and every tool result so far. */
const lastPayload = (id: string): string => stepPayloads(server!, id).at(-1)!;
/** The text of the last tool result the model saw in its last call. */
const lastResult = (id: string): string => {
  const messages = (JSON.parse(lastPayload(id)) as { messages: { role: string; content: unknown }[] }).messages;
  const result = messages.filter((m) => m.role === "toolResult").at(-1);
  return JSON.stringify(result?.content ?? "");
};
const toolOutputs = (d: { messages: Message[] }) => d.messages.filter((m) => m.role === "assistant").map((m) => m.text);

describe("the memory tools in a chat you are in", () => {
  it("add, replace, confirm and remove write at once and leave a chip with Undo in the chat", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    let d = await talk(id, add("Prefers aisle seats"));
    expect(await texts()).toEqual(["Prefers aisle seats"]);
    expect(toolOutputs(d).join()).toContain("Saved [m1]");
    expect(chips(d)).toHaveLength(1);
    expect(chips(d)[0]!.memory!.change).toMatchObject({
      lineId: "m1",
      op: "add",
      after: "Prefers aisle seats",
      by: "agent",
      sessionId: id,
      undoable: true,
      undoneAt: null,
    });
    const line = (await lines()).profile[0]!;
    const userMessage = d.messages.find((m) => m.role === "user")!;
    expect(line.source).toMatchObject({ sessionId: id, messageId: userMessage.id });

    d = await talk(id, tool("memory_replace", { id: "m1", text: "Prefers window seats" }));
    expect(await texts()).toEqual(["Prefers window seats"]);
    expect(chips(d)).toHaveLength(2);

    // A confirm only moves a date: silent, no chip, no approval.
    server.clock.advance(3 * 86_400_000);
    const before = (await lines()).profile[0]!.confirmedAt;
    d = await talk(id, tool("memory_confirm", { id: "m1" }));
    expect((await lines()).profile[0]!.confirmedAt).toBeGreaterThan(before);
    expect(chips(d)).toHaveLength(2);

    d = await talk(id, tool("memory_remove", { id: "m1" }));
    expect(await texts()).toEqual([]);
    expect(chips(d)).toHaveLength(3);
    expect(store().db.all("SELECT 1 FROM approvals")).toEqual([]);
  });

  it("puts the saved lines, with ids and dates, into the next prompt, and marks the stale ones", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await talk(id, add("Lives in Osaka"));
    await talk(id, add("Likes tea", "agent"));
    await talk(id, "what do you know");
    const prompt = stepPayloads(server, id).at(-1)!;
    expect(prompt).toContain("About the user (profile.md):");
    expect(prompt).toContain("[m1] Lives in Osaka (confirmed ");
    expect(prompt).toContain("Your notes (agent.md):");
    expect(prompt).toContain("[m2] Likes tea");

    // Seven months on, the line says it has not been confirmed for a while.
    store().db.run("UPDATE memory_lines SET confirmed_at = ? WHERE seq = 1", server.clock.now() - 210 * 86_400_000);
    await talk(id, "and now?");
    expect(stepPayloads(server, id).at(-1)).toMatch(/not confirmed for 7 months/);
  });

  it("refuses secrets, empty and long lines, and lines past the budget", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    let d = await talk(id, add("my password is hunter2hunter2"));
    expect(toolOutputs(d).join()).toContain("Not saved: memory never holds passwords");
    expect(await texts()).toEqual([]);
    d = await talk(id, add("x".repeat(600)));
    expect(toolOutputs(d).at(-1)).toMatch(/too long|500/i);
    // Fill the profile to its budget (3,000 tokens) the way the Memory page would, then the tool's add is refused.
    for (let i = 0; i < 60; i++) {
      try {
        memory().lines.add(
          { doc: "profile", text: `Fact number ${i}: ${"alpha beta gamma delta ".repeat(18)}` },
          { by: "user", sessionId: null },
        );
      } catch {
        break;
      }
    }
    expect((await texts()).length).toBeGreaterThan(10);
    expect((await lines()).usedTokens).toBeLessThanOrEqual(3_000);
    d = await talk(id, add(`one more fact that does not fit any more ${"omega ".repeat(60)}`));
    expect(toolOutputs(d).at(-1)).toMatch(/Memory is full/);
    expect(await texts()).not.toContain(`one more fact that does not fit any more ${"omega ".repeat(60)}`.trim());
  });

  it("cannot edit another agent's notes, and says which lines exist", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await talk(id, add("Own note", "agent"));
    const second = await secondAgent();
    const other = (await server.client.post("/api/sessions", { agentId: second })).body.session.id as string;
    const d = await talk(other, tool("memory_replace", { id: "m1", text: "Hijacked" }));
    expect(toolOutputs(d).at(-1)).toMatch(/another agent's notes/);
    const unknown = await talk(other, tool("memory_remove", { id: "m99" }));
    expect(toolOutputs(unknown).at(-1)).toMatch(/no saved line \[m99\]/);
    expect((await lines()).agents.flatMap((a) => a.lines.map((l) => l.text))).toEqual(["Own note"]);
  });

  it("asks first when the chat read outside content, and writes with the chip once approved", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await setProfile(server, id, "strict");
    store().addTaint(id, ["external"]);
    await say(server, id, add("Reads the news at 7"));
    const [ap] = await waitPending(server, id);
    expect(ap).toMatchObject({
      tool: "memory_add",
      resumesTool: true,
      actionClass: "memory_write",
      destination: "profile",
      taint: ["external"],
    });
    expect(ap!.summary).toMatch(/^Save to memory: Reads the news at 7/);
    expect(await texts()).toEqual([]);
    await decide(server, ap!.id, { decision: "approve" });
    const completed = await settled(server, id);
    expect(completed.runs).toHaveLength(1);
    expect(completed.messages.find((message) => message.approval?.id === ap!.id)?.approval).toMatchObject({
      execution: "ran",
    });
    expect(await texts()).toEqual(["Reads the news at 7"]);
    expect(chips(await detail(server, id))).toHaveLength(1);
  });

  it.each(["standard", "yolo"] as const)(
    "saves memory automatically in %s after reading outside content",
    async (profile) => {
      server = await startSignedIn();
      const id = await chat(server);
      await setProfile(server, id, profile);
      await talk(id, `${tool("demo_read_web", { url: "https://example.com/page" })} ${add("Walks the dog at 6")}`);
      expect(await texts()).toEqual(["Walks the dog at 6"]);
    },
  );
});

describe("undo", () => {
  it("restores the line as it was; an add is undone by removing it; later edits block the undo", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const d1 = await talk(id, add("Uses Linux"));
    const addChange = chips(d1)[0]!.memory!.change;
    const d2 = await talk(id, tool("memory_replace", { id: "m1", text: "Uses macOS" }));
    const replaceChange = chips(d2).at(-1)!.memory!.change;

    // The add cannot be undone while a later edit stands.
    const blocked = await server.client.post(`/api/memory/changes/${addChange.id}/undo`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("not_undoable");

    const undone = await server.client.post(`/api/memory/changes/${replaceChange.id}/undo`, {});
    expect(undone.status).toBe(200);
    expect(undone.body.line.text).toBe("Uses Linux");
    expect(undone.body.change.undoneAt).not.toBeNull();
    // The chip in the chat shows it was undone.
    const chip = chips(await detail(server, id)).find((m) => m.memory!.change.id === replaceChange.id)!;
    expect(chip.memory!.change.undoneAt).not.toBeNull();
    expect((await server.client.post(`/api/memory/changes/${replaceChange.id}/undo`, {})).status).toBe(409);

    const removed = await server.client.post(`/api/memory/changes/${addChange.id}/undo`, {});
    expect(removed.body.line).toBeNull();
    expect(await texts()).toEqual([]);
    expect((await server.client.post("/api/memory/changes/nope/undo", {})).status).toBe(404);
  });
});

describe("memory edits from runs the user is not behind", () => {
  it("a spawned brief only suggests; the suggestion rides on the report and the parent saves it with a chip", async () => {
    server = await startSignedIn();
    const parent = homeChat(server);
    await say(server, parent, `[spawn: ${add("Prefers vegetarian food")}]`);
    const child = await until(async () => (await childrenOf(server!, parent))[0], 10_000, "the child");
    await settled(server, child.id, 1);
    // The child's tool said so, and nothing was written by the child.
    expect(toolOutputs(await detail(server, child.id)).join()).toContain(
      "Suggested to the agent that started this session",
    );
    expect(chips(await detail(server, child.id))).toHaveLength(0);

    // The parent got it with the report, took the advice, and the write is its own: a chip in the parent chat.
    await until(async () => (await texts()).length === 1, 15_000, "the parent to save the suggestion");
    await settled(server, parent, 2);
    expect(await texts()).toEqual(["Prefers vegetarian food"]);
    const p = await detail(server, parent);
    expect(chips(p)).toHaveLength(1);
    expect(chips(p)[0]!.memory!.change).toMatchObject({ op: "add", by: "agent", sessionId: parent });
    const report = p.messages.find((m) => m.role === "report")!;
    expect(report.report!.memorySuggestions).toMatchObject([
      { op: "add", doc: "profile", text: "Prefers vegetarian food", status: "reported", sessionId: child.id },
    ]);
    expect(memory().lines.pendingFor(child.id)).toEqual([]);
  });

  it("workers cannot start a second worker or create a grandchild's memory suggestion", async () => {
    server = await startSignedIn();
    const parent = homeChat(server);
    await say(server, parent, `[spawn: [spawn: ${add("Allergic to peanuts")}]]`);
    const child = await until(async () => (await childrenOf(server!, parent))[0], 10_000, "the child");
    await settled(server, parent, 2);
    expect(await childrenOf(server, child.id)).toEqual([]);
    expect(await texts()).toEqual([]);
    expect(chips(await detail(server, child.id))).toHaveLength(0);
  });

  it("a run you type in a spawned session writes directly, with the chip in that session", async () => {
    server = await startSignedIn();
    const parent = homeChat(server);
    await say(server, parent, "[spawn: a small job]");
    const child = await until(async () => (await childrenOf(server!, parent))[0], 10_000, "the child");
    await settled(server, child.id, 1);
    const d = await talk(child.id, add("Born in Kyoto"));
    expect(await texts()).toEqual(["Born in Kyoto"]);
    expect(chips(d)).toHaveLength(1);
    expect(chips(d)[0]!.memory!.change.sessionId).toBe(child.id);
    expect(memory().lines.pendingFor(child.id)).toEqual([]);
  });

  it("does not confirm a line from a run the user is not behind", async () => {
    server = await startSignedIn();
    const home = homeChat(server);
    await talk(home, add("Likes jazz"));
    server.clock.advance(5 * 86_400_000);
    const before = (await lines()).profile[0]!.confirmedAt;
    await say(server, home, `[spawn: ${tool("memory_confirm", { id: "m1" })}]`);
    const child = await until(async () => (await childrenOf(server!, home))[0], 10_000, "the child");
    await settled(server, child.id, 1);
    expect(toolOutputs(await detail(server, child.id)).join()).toContain("Not confirmed");
    expect((await lines()).profile[0]!.confirmedAt).toBe(before);
  });
});

async function secondAgent(): Promise<string> {
  const now = server!.clock.now();
  store().db.run(
    "INSERT INTO agents (id, name, avatar, default_profile, instructions, home_session_id, created_at) VALUES ('agt_dot', 'Dot', 'bot:cat', 'standard', '', NULL, ?)",
    now,
  );
  return "agt_dot";
}

describe("search_history", () => {
  it("reports abstention and explicitly requires context verification for possible leads", async () => {
    server = await startSignedIn();
    const source = await chat(server);
    await talk(source, "The Kyoto hotel is near the station.");
    const reader = await chat(server);
    await talk(reader, tool("search_history", { query: "Kyoto maples" }));
    expect(toolOutputs(await detail(server, reader)).at(-1)).toContain("[Possible lead]");
    expect(lastPayload(reader)).toContain("read history_context and verify");
    await talk(reader, tool("search_history", { query: "What is my favourite football team?" }));
    expect(toolOutputs(await detail(server, reader)).at(-1)).toContain("No sufficiently relevant matches in history");
  });

  it("returns hits with the message id, and history_context reads around one", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await talk(a, "The passphrase for the shed is MANGO-LANTERN");
    const b = await chat(server);
    await talk(b, tool("search_history", { query: "lantern" }));
    const said = lastPayload(b);
    expect(said).toContain("MANGO-LANTERN");
    expect(said).toMatch(/\[message \w+/);
    const messageId = (await detail(server, a)).messages.find((m) => m.role === "user")!.id;
    expect(said).toContain(`[message ${messageId}]`);
    const around = await talk(b, tool("history_context", { message_id: messageId }));
    expect(lastPayload(b)).toContain("MANGO-LANTERN");
    expect(around.messages.filter((m) => m.role === "assistant").length).toBeGreaterThan(0);
    expect(toolOutputs(await talk(b, tool("history_context", { message_id: "nope" }))).at(-1)).toContain(
      "No such message",
    );
    expect(toolOutputs(await talk(b, tool("search_history", { query: "x", from: "yesterday-ish" }))).at(-1)).toContain(
      "ISO dates",
    );
  });

  it("brings the labels of what it read to the reader (your own words carry none)", async () => {
    server = await startSignedIn();
    const reader = await chat(server);
    const plain = await chat(server);
    await talk(plain, "The word is PLAINWORD");
    await talk(reader, tool("search_history", { query: "plainword" }));
    expect((await detail(server, reader)).session.taint).toEqual([]);

    const web = await chat(server);
    await talk(web, tool("demo_read_web", { url: "https://example.com/x" }));
    expect((await detail(server, web)).session.taint).toContain("external");
    // The page the web chat read is in its history as a tool result; reading it labels the reader.
    await talk(reader, tool("search_history", { query: "kyoto maples" }));
    expect((await detail(server, reader)).session.taint).toContain("external");
  });

  it("covers every agent by default, narrows by agent name or id, and says which agent a hit is from", async () => {
    server = await startSignedIn();
    const second = await secondAgent();
    const mine = await chat(server);
    const theirs = (await server.client.post("/api/sessions", { agentId: second })).body.session.id as string;
    await talk(mine, "Shared topic: kumquat from the Assistant chat");
    await talk(theirs, "Shared topic: kumquat from the Dot chat");
    const ask = async (args: Record<string, unknown>) => {
      const id = await chat(server!);
      await talk(id, tool("search_history", { query: "kumquat", ...args }));
      return lastResult(id);
    };
    const all = await ask({});
    expect(all).toContain("· Dot ·");
    expect(all).toContain("· Assistant ·");

    for (const agent of ["dot", second]) {
      const only = await ask({ agent });
      expect(only).toContain("· Dot ·");
      expect(only).not.toContain("· Assistant ·");
    }

    const unknown = await ask({ agent: "Nobody" });
    expect(unknown).toContain('There is no agent \\"Nobody\\"');
    expect(unknown).toContain("Assistant, Dot");
  });

  it("names no agent in the hits while there is only one", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await talk(a, "A single-agent kumquat");
    const b = await chat(server);
    await talk(b, tool("search_history", { query: "kumquat" }));
    expect(lastPayload(b)).toContain("single-agent kumquat");
    expect(lastPayload(b)).not.toContain("· Assistant ·");
  });
});

describe("the memory section of the prompt", () => {
  it("says who the agent is and that search covers everyone unless narrowed, without naming the other agents", async () => {
    server = await startSignedIn();
    const first = await chat(server);
    await talk(first, "hello");
    const memorySection = (payload: string) => /<memory>[\s\S]*?<\/memory>/.exec(payload)?.[0];
    const alone = stepPayloads(server, first)[0]!;
    expect(alone).toMatch(/You are Assistant \(agent id agt_\w+\)\./);
    expect(alone).toContain("search_history covers every agent's chats; pass agent (a name or id");
    expect(alone).toContain('e.g. agent: \\"Assistant\\" for your own');
    expect(memorySection(alone)).toBeDefined();

    // Another agent appearing leaves this conversation's memory section as it was, so its prompt cache holds.
    await secondAgent();
    await talk(first, "again");
    const both = stepPayloads(server, first).at(-1)!;
    expect(memorySection(both)).toBe(memorySection(alone));
    expect(memorySection(both)).not.toContain("Dot");
    const dot = (await server.client.post("/api/sessions", { agentId: "agt_dot" })).body.session.id as string;
    await talk(dot, "hi");
    const dotPayload = stepPayloads(server, dot)[0]!;
    expect(dotPayload).toMatch(/You are Dot \(agent id agt_dot\)\./);
    expect(memorySection(dotPayload)).not.toContain("Assistant");
  });
});

describe("the recent-sessions digest", () => {
  it("lists other recent sessions with status and one line of result, whatever their labels", async () => {
    server = await startSignedIn();
    const web = await chat(server);
    await talk(web, `${tool("demo_read_web", { url: "https://example.com/x" })} summary please`);
    expect((await detail(server, web)).session.taint).toContain("external");
    const other = await chat(server);
    await talk(other, "and what is new elsewhere");
    const prompt = stepPayloads(server, other)[0]!;
    expect(prompt).toContain("Recent activity in your other sessions, newest first (read one with read_chat):");
    // The external-labelled session's result is shown like any other's.
    expect(prompt).toMatch(/Recent activity[^"]*"[^"]*demo_read_web[^"]*"/s);
  });

  it("shows only the caller's agent, with ids, and leaves out sessions the caller lists as its own", async () => {
    server = await startSignedIn();
    const mine = await chat(server);
    await talk(mine, "MINE-MARK question");
    await secondAgent();
    const dot = (await server.client.post("/api/sessions", { agentId: "agt_dot" })).body.session.id as string;
    await talk(dot, "DOT-MARK question");
    const home = homeChat(server);
    await say(server, home, "[spawn: CHILD-MARK job]");
    await settled(server, home, 2);
    await talk(home, "and now");
    const prompt = stepPayloads(server, home).at(-1)!;
    const recent = prompt.slice(prompt.indexOf("Recent activity in your other sessions"));
    expect(recent).toContain(`${mine} `);
    expect(recent).toContain("MINE-MARK");
    expect(recent).not.toContain("DOT-MARK");
    const [child] = await childrenOf(server, home);
    expect(recent.slice(0, recent.indexOf("</recent>"))).not.toContain(child!.id);
    expect(prompt).toContain(`${child!.id} \\"CHILD-MARK job\\"`);
  });

  it("leaves out the session itself, home chats, and the chat a fork was branched from", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await talk(a, "FIRST-MARK question");
    const home = (await server.client.get("/api/agents")).body.agents[0].homeSessionId as string;
    await talk(home, "HOME-MARK question");
    const b = await chat(server);
    await talk(b, "other");
    const prompt = stepPayloads(server, b)[0]!;
    expect(prompt).toContain("FIRST-MARK");
    expect(prompt).not.toContain("HOME-MARK");
    expect(prompt).not.toMatch(/Recent activity[^<]*"other"/);
  });
});
