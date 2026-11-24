import { collapseSystemMessages } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, describe, expect, it } from "vitest";
import { homeMessages, selectHomeMessages } from "../src/pi/home-context.ts";
import { RunPins } from "../src/pi/stable-prefix.ts";
import type { AppStore } from "../src/store/store.ts";
import { tool } from "./helpers/approvals.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, say, settled, stepPayloads } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

type Message = { role: string; content: unknown; sections?: Record<string, string>; timestamp?: number };
const msg = (role: string, content: string, timestamp = 0): Message => ({ role, content, timestamp });
/** The provider request of each model call in a session, oldest first. */
const requests = (s: TestServer, id: string) =>
  stepPayloads(s, id).map((p) => (JSON.parse(p) as { messages: Message[] }).messages);
/** The request as a provider without mid-conversation system messages receives it: all system messages folded first. */
const collapsed = (messages: Message[]) =>
  collapseSystemMessages({ messages } as unknown as Parameters<typeof collapseSystemMessages>[0])
    .messages as unknown as Message[];
/** Whether `later` starts with every message of `earlier`, byte for byte. */
const extendsPrefix = (earlier: Message[], later: Message[]) =>
  JSON.stringify(later.slice(0, earlier.length)) === JSON.stringify(earlier);

describe("home window start within a run", () => {
  const turn = (n: number) => [msg("user", `q${n} ${"w ".repeat(300)}`, n * 2), msg("assistant", `a${n}`, n * 2 + 1)];

  it("holds the pinned start past the budget, and moves once the selection passes twice the budget", () => {
    const messages = [msg("system", "keep"), ...turn(0), ...turn(1), ...turn(2), msg("user", "now")];
    // Without a pin, a 400-token budget drops the older turns and keeps the previous one that fits.
    expect(selectHomeMessages(messages, 400)[1]!.content).toMatch(/^q2 /);
    // A pin at the run's first start holds while the selection fits twice the budget...
    expect(selectHomeMessages(messages, 600, undefined, 3)).toEqual([messages[0], ...messages.slice(3)]);
    // ...and gives way past it.
    expect(selectHomeMessages(messages, 200, undefined, 1).at(1)!.content).toBe("now");
  });

  it("keeps a home request's prefix byte-identical across a failed tool call that pushes it over budget", () => {
    const store = {
      metaGet: (key: string) => (key === "home_context" ? JSON.stringify({ maxTokens: 1_200 }) : undefined),
      getSessionRow: () => ({ origin: "home" }),
      getRun: () => ({ id: "run-5", created_at: 5 }),
      runs: { forSession: () => [], get: () => undefined },
    } as unknown as AppStore;
    const history = [msg("system", "keep"), ...turn(0), ...turn(1), ...turn(2)];
    const first = [...history, msg("user", "save this", 10)];
    // The failed call: a long body in the arguments, and an error result.
    const failed = [
      ...first,
      msg("assistant", `call knowledge_write ${"body ".repeat(500)}`, 11),
      msg("toolResult", "Validation failed: action: missing", 12),
    ];
    const send = (pins: RunPins | undefined, messages: Message[]) =>
      homeMessages(store, "ses", "run-5", messages, {}, undefined, pins) as Message[];

    const pins = new RunPins();
    const call1 = send(pins, first);
    expect(call1).toEqual(first);
    const call2 = send(pins, failed);
    expect(extendsPrefix(call1, call2)).toBe(true);
    // Without the run's pin the window moved: the old turns were dropped mid-run.
    expect(extendsPrefix(send(undefined, first), send(undefined, failed))).toBe(false);
  });
});

describe("prompt section updates within a run", () => {
  it("drops only section-only system messages that appeared after the run's first call", () => {
    const pins = new RunPins();
    const base: Message = { role: "system", content: "base", sections: { a: "1" }, timestamp: 1 };
    const first = [base, msg("user", "hi", 2)];
    expect(pins.deferSectionUpdates("run-1", first)).toBe(first);
    const update: Message = { role: "system", content: "", sections: { a: "2" }, timestamp: 4 };
    const withTools = { role: "system", content: "", sections: { a: "3" }, toolsAdded: [{ name: "t" }], timestamp: 6 };
    const later = [...first, msg("assistant", "call", 3), update, msg("toolResult", "ok", 5), withTools];
    expect(pins.deferSectionUpdates("run-1", later)).toEqual([...first, later[2], later[4], withTools]);
    // The next run's first call carries the update.
    expect(pins.deferSectionUpdates("run-2", later)).toBe(later);
    // Another conversation's call under the same run never loses its own leading system message.
    const other = [{ role: "system", content: "", sections: { b: "1" }, timestamp: 7 }, msg("user", "title?", 8)];
    expect(pins.deferSectionUpdates("run-1", other)).toBe(other);
  });

  it("holds a knowledge section change back until the next run, so the run's requests share one prefix", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    await say(server, id, "hello");
    await settled(server, id);
    const before = requests(server, id).length;
    await say(server, id, tool("knowledge_write", { action: "create", parentId: "top", title: "Prefix plan" }));
    await settled(server, id, 2);
    const run = requests(server, id).slice(before);
    expect(run.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < run.length; i++) expect(extendsPrefix(collapsed(run[i - 1]!), collapsed(run[i]!))).toBe(true);
    expect(JSON.stringify(run.at(-1)!.filter((m) => m.role === "system"))).not.toContain("Prefix plan");
    await say(server, id, "thanks");
    await settled(server, id, 3);
    const next = requests(server, id).at(-1)!;
    expect(JSON.stringify(next.filter((m) => m.role === "system"))).toContain("Prefix plan");
  });
});
