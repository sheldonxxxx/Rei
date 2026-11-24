import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { afterEach, expect, it } from "vitest";
import { openPiStorage } from "../src/node/pi-storage.ts";
import { NodePrivateSnapshots } from "../src/node/private-snapshots.ts";
import { createGuard } from "../src/pi/guard.ts";
import { createModelRuntime } from "../src/pi/models.ts";
import { executePrivateFork } from "../src/pi/private-execution.ts";
import { until } from "./helpers/client.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, say, settled, treeDir, treeOf } from "./helpers/sessions.ts";

let server: TestServer | undefined;
let copy: Harness | undefined;
let folder: string | undefined;
afterEach(async () => {
  await copy?.close(context);
  copy = undefined;
  if (folder) rmSync(folder, { recursive: true, force: true });
  await server?.destroy();
  server = undefined;
});

it("orphans copied sleeping background tasks and ownership descendants without running their effects", async () => {
  folder = mkdtempSync(join(tmpdir(), "rei-private-tasks-"));
  const sourcePath = join(folder, "trees", "source", "pi.sqlite");
  mkdirSync(join(folder, "trees", "source"), { recursive: true });
  const runtime = await createModelRuntime({ mode: "faux" });
  let effects = 0;
  const sleeper = defineTask<null, { phase: "start" | "wake" }, null>({
    name: "unsafe.sleeper",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: (_task, api, ctx) => api.sleepUntil(Date.now() + 3_600_000, { phase: "wake" }, ctx),
      wake: async (_task, api, ctx) => {
        effects++;
        await api.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx);
      },
    },
    abort: (_task, api, ctx) => api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "unsafe", tasks: [sleeper] }));
  copy = await Harness.open(await openPiStorage(sourcePath), { models: runtime.models, registry }, context);
  const source = await copy.root(context, { agent: { model: runtime.ref("faux") } });
  runtime.arm();
  await (await source.submit({ type: "input", content: "BEFORE-SLEEP" }, context)).wait(context);
  const cut = (await source.context(context)).entries.at(-1)!.id;
  await source.commit(async (tx) => {
    const parent = await tx.createTask(sleeper, null, { ownership: { kind: "conversation" }, background: true });
    await tx.createTask(sleeper, null, { ownership: { kind: "task", taskId: parent } });
  }, context);
  copy.resume();
  await until(
    async () => {
      const tasks = (await copy!.inspect(context)).tasks;
      return tasks.length === 2 && tasks.every((t) => t.state.kind === "sleeping") ? true : undefined;
    },
    2000,
    "sleeping tasks",
  );
  const snapshots = new NodePrivateSnapshots(folder);
  await snapshots.sweep();
  const policy = defineExtension({ name: "private_policy" });
  runtime.arm();
  await executePrivateFork(snapshots, openPiStorage, {
    sourceTree: "source",
    sourceConversation: String(source.id),
    cut: String(cut),
    id: "probe",
    model: runtime.ref("faux"),
    instructions: "Private",
    input: "Private",
    extensions: [],
    policy,
    models: runtime.models,
    signal: AbortSignal.timeout(5000),
    allowedTools: [],
    prepare: async () => "Private",
  });
  expect(effects).toBe(0);
  expect((await copy.inspect(context)).tasks).toHaveLength(2);
  expect(readdirSync(join(folder, "background-private"))).toEqual([]);
});

it("isolates a native fixed-cut fork from copied live and queued work", async () => {
  server = await startSignedIn();
  const session = await chat(server);
  await say(server, session, "BEFORE-CUT");
  const first = await settled(server, session);
  const cut = server.host.plane.store.getRun(first.runs[0]!.id)!.answer_entry_id;
  expect(cut).toBeDefined();
  await say(server, session, "LATER-LIVE [len=9000]");
  await until(async () => (await detail(server!, session)).runs.some((r) => r.status === "running"), 5000, "run");
  await say(server, session, "LATER-QUEUED [call: forbidden {}]");

  folder = mkdtempSync(join(tmpdir(), "rei-private-proof-"));
  const connection = new DatabaseSync(join(treeDir(server, treeOf(server, session)), "pi.sqlite"), { readOnly: true });
  try {
    await backup(connection, join(folder, "pi.sqlite"));
  } finally {
    connection.close();
  }
  const runtime = await createModelRuntime({ mode: "faux" });
  let modelCalls = 0;
  const models = new Proxy(runtime.models, {
    get(target, key) {
      if (key === "streamSimple")
        return (...args: Parameters<typeof target.streamSimple>) => {
          modelCalls++;
          return target.streamSimple(...args);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const policy = defineExtension({ name: "private_policy" });
  const registry = createRegistry();
  registry.install(policy);
  copy = await Harness.open(await openPiStorage(join(folder, "pi.sqlite")), { models, registry }, context);
  const inspection = await copy.inspect(context);
  expect(inspection.scheduling).toBe("paused");
  expect(inspection.tasks.length).toBeGreaterThan(0);
  expect(inspection.submissions.some((s) => s.status === "queued")).toBe(true);
  for (const submission of inspection.submissions) await copy.abortSubmission(submission.id, context);
  for (const task of inspection.tasks) await copy.abortTask(task.record.id, context);
  await copy.waitForIdle(context);
  expect(modelCalls).toBe(0);
  expect((await copy.inspect(context)).tasks).toHaveLength(0);

  const sourceRow = server.host.plane.store.getSessionRowAny(session)!;
  const source = await copy.conversation(Number(sourceRow.pi_conversation_id) as ConversationId, context);
  const privateFork = await createGuard(policy).fork(
    source!,
    Number(cut) as EntryId,
    {
      ownership: { kind: "ownerless" },
      agent: { extensions: [policy], instructions: "Private review only" },
    },
    context,
  );
  const inherited = JSON.stringify(await privateFork.context(context));
  expect(inherited).toContain("BEFORE-CUT");
  expect(inherited).not.toContain("LATER-LIVE");
  expect(inherited).not.toContain("LATER-QUEUED");
  runtime.arm();
  await (await privateFork.submit({ type: "input", content: "Review privately" }, context)).wait(context);
  expect(modelCalls).toBe(1);
  expect((await detail(server, session)).messages.some((m) => m.text.includes("Review privately"))).toBe(false);
});
