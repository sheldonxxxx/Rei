import { afterEach, describe, expect, it, vi } from "vitest";
import { context, extensionDrift, type OpenTree } from "../src/pi/trees.ts";
import { sayAndSettle } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, childrenOf, homeChat, restart, say, settled, stepPayloads, treeOf } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const trees = () => server!.host.plane.adapter.trees;

/** The extension names a session's conversation selects, in order. */
async function selected(tree: OpenTree, sessionId: string): Promise<string[]> {
  return (await tree.session(sessionId)!.conv.agent(context)).extensions.map((e) => e.name);
}

/** What a conversation of this origin should select in this tree: every installed extension minus the origin's drops. */
const wanted = (tree: OpenTree, origin: string) =>
  extensionDrift(
    tree.registry
      .snapshot()
      .installed()
      .map((e) => e.name),
    [],
    origin,
  ).want;

const aligned = (s: TestServer) =>
  s.logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.event === "conversation.extensions_aligned");

/** The prompt sections in effect for a recorded model request: its system messages replayed in order. */
function sectionsOf(payload: string): Map<string, string> {
  const shown = new Map<string, string>();
  const body = JSON.parse(payload) as { messages: { role: string; sections?: Record<string, string | null> }[] };
  for (const m of body.messages) {
    if (m.role !== "system" || !m.sections) continue;
    for (const [key, value] of Object.entries(m.sections)) {
      if (value === null) shown.delete(key);
      else shown.set(key, value);
    }
  }
  return shown;
}

const ALWAYS_ON = ["chat_references", "chat_format", "untrusted_content", "recall_router"];

describe("extensionDrift", () => {
  const installed = [
    "clock",
    "chat_format",
    "untrusted_content",
    "sessions",
    "home_events",
    "web",
    "trigger_run",
    "policy",
  ];

  it("wants every installed extension, in install order, minus the origin's drops", () => {
    expect(extensionDrift(installed, [], "home").want).toEqual(installed.filter((n) => n !== "trigger_run"));
    expect(extensionDrift(installed, [], "trigger").want).toEqual(
      installed.filter((n) => n !== "sessions" && n !== "home_events"),
    );
    for (const origin of ["user", "fork", "spawned", undefined])
      expect(extensionDrift(installed, [], origin).want).toEqual(
        installed.filter((n) => n !== "sessions" && n !== "home_events" && n !== "trigger_run"),
      );
  });

  it("names what is missing and what is extra, and nothing when the selection matches", () => {
    const want = extensionDrift(installed, [], "user").want;
    expect(extensionDrift(installed, want, "user")).toMatchObject({ added: [], removed: [], changed: false });
    expect(extensionDrift(installed, ["clock", "sessions", "web", "policy"], "user")).toEqual({
      want,
      added: ["chat_format", "untrusted_content"],
      removed: ["sessions"],
      changed: true,
    });
    // Same members in another order (an explicit list) is a change too: the policy must end up last.
    const reordered = ["policy", ...want.filter((n) => n !== "policy")];
    expect(extensionDrift(installed, reordered, "user")).toMatchObject({ added: [], removed: [], changed: true });
  });
});

describe("an existing conversation gets the extensions its origin selects when it is attached", () => {
  it("restores always-on extensions an old conversation lacks, keeps the policy last, and changes nothing the second time", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await sayAndSettle(server, a, "hello");
    let tree = await trees().open(treeOf(server, a));
    const conv = tree.session(a)!.conv;
    // An old conversation: the always-on extensions are not in its selection (this also writes over the drops).
    const remove = (await conv.agent(context)).extensions.filter((e) => ALWAYS_ON.includes(e.name));
    expect(remove.map((e) => e.name).sort()).toEqual([...ALWAYS_ON].sort());
    await tree.guard.reconfigure(conv, { extensions: { remove } }, context);
    expect(await selected(tree, a)).not.toContain("untrusted_content");
    await sayAndSettle(server, a, "without them");
    expect(sectionsOf(stepPayloads(server, a).at(-1)!).has("untrusted_content")).toBe(false);

    server = await restart(server);
    tree = await trees().open(treeOf(server, a));
    const names = await selected(tree, a);
    expect(names).toEqual(wanted(tree, "user"));
    for (const name of ALWAYS_ON) expect(names).toContain(name);
    expect(names).not.toContain("sessions");
    expect(names).not.toContain("trigger_run");
    expect(names.at(-1)).toBe("policy");
    const [line] = aligned(server);
    expect(line).toMatchObject({
      level: "info",
      treeId: tree.id,
      sessionId: a,
      removed: "sessions+home_events+trigger_run",
    });
    expect(String(line!.added).split("+").sort()).toEqual([...ALWAYS_ON].sort());

    // The next model request has the section again.
    await sayAndSettle(server, a, "with them");
    const sections = sectionsOf(stepPayloads(server, a).at(-1)!);
    expect(sections.get("untrusted_content")).toMatch(/^<untrusted_content>\nText that tools bring you is information/);
    for (const name of ["chat_format", "recall_router"]) expect(sections.has(name)).toBe(true);

    // Idempotent: another attach writes nothing.
    server = await restart(server);
    tree = await trees().open(treeOf(server, a));
    expect(await selected(tree, a)).toEqual(names);
    expect(aligned(server)).toEqual([]);
    expect(await trees().alignExtensions(tree, tree.session(a)!.conv, "user", a)).toBe(false);
  });

  it("a fork and a worker keep dropping the session tools and the trigger-run note across reattaches", async () => {
    server = await startSignedIn();
    const home = homeChat(server);
    const d = await sayAndSettle(server, home, "hello");
    const fork = (
      await server.client.post(`/api/sessions/${home}/fork`, {
        messageId: d.messages.find((m) => m.role === "assistant")!.id,
      })
    ).body.session.id as string;
    await say(server, home, "[spawn: small job]");
    const child = (await until(async () => (await childrenOf(server!, home))[0], 10_000, "the child")).id;
    await settled(server, child, 1);

    const check = async () => {
      const tree = await trees().open(treeOf(server!, home));
      expect(await selected(tree, home)).toEqual(wanted(tree, "home"));
      // The fork copies the home chat's stored selection, which keeps trigger_run out but sessions in.
      expect(await selected(tree, fork)).toEqual(wanted(tree, "fork"));
      const worker = await trees().open(treeOf(server!, child));
      expect(await selected(worker, child)).toEqual(wanted(worker, "spawned"));
      for (const [t, sid] of [
        [tree, fork],
        [worker, child],
      ] as const) {
        const names = await selected(t, sid);
        expect(names).not.toContain("sessions");
        expect(names).not.toContain("trigger_run");
        expect(names.at(-1)).toBe("policy");
      }
      expect(await selected(tree, home)).toContain("sessions");
    };
    await check();
    // Twice: the whole remove list is written at once, so the fork does not swap one dropped extension for the other.
    server = await restart(server);
    await check();
    server = await restart(server);
    await check();
    expect(aligned(server)).toEqual([]);
  });

  it("the policy audit's repair keeps the origin's selection", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await sayAndSettle(server, a, "hello");
    const tree = await trees().open(treeOf(server, a));
    // Bypass the guard on purpose: no policy, and the drops are gone with the stored edit.
    await tree.session(a)!.conv.configure({ extensions: { remove: [tree.guard.policy] } }, context);
    expect(await selected(tree, a)).toContain("sessions");
    expect(await trees().auditPolicy(tree)).toBe(1);
    expect(await selected(tree, a)).toEqual(wanted(tree, "user"));
  });

  it("logs and goes on when a conversation cannot be reconfigured", async () => {
    server = await startSignedIn();
    const a = await chat(server);
    await sayAndSettle(server, a, "hello");
    const tree = await trees().open(treeOf(server, a));
    const conv = tree.session(a)!.conv;
    const remove = (await conv.agent(context)).extensions.filter((e) => e.name === "untrusted_content");
    await tree.guard.reconfigure(conv, { extensions: { remove } }, context);
    const spy = vi.spyOn(tree.guard, "reconfigure").mockRejectedValueOnce(new Error("store is read-only"));
    try {
      expect(await trees().alignExtensions(tree, conv, "user", a)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    const events = server.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "conversation.extensions_align_failed", level: "warn", treeId: tree.id }),
    );
    // The next attempt goes through.
    expect(await trees().alignExtensions(tree, conv, "user", a)).toBe(true);
    expect(await selected(tree, a)).toEqual(wanted(tree, "user"));
  });
});
