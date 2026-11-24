// Code mode (ticket 01): the `codemode` tool behind the Runtime setting, with the faux model and the real engine.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveTool } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/node/config.ts";
import { TOO_MANY_SCRIPTS } from "../src/pi/codemode.ts";
import { CODEMODE_DEMO_SCRIPT } from "../src/pi/faux.ts";
import { tool as directive } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { type ExecServer, startExecServer } from "./helpers/exec.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, detail, homeChat, say, settled, stepPayloads } from "./helpers/sessions.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const setCodeMode = async (s: TestServer, enabled: boolean) => {
  const res = await s.client.call("PUT", "/api/settings/behavior", { body: { codeMode: { enabled } } });
  expect(res.status).toBe(200);
  expect(res.body.settings.codeMode.enabled).toBe(enabled);
};
const treeOf = (s: TestServer, sessionId: string) =>
  s.host.plane.adapter.trees.get(s.host.plane.store.getSessionRow(sessionId)!.tree_id)!;
const installed = (s: TestServer, sessionId: string): string[] =>
  treeOf(s, sessionId)
    .registry.snapshot()
    .installed()
    .map((e) => e.name);
const stepsOf = (s: TestServer, sessionId: string, toolName: string) =>
  s.host.plane.store.db.all<{ id: string; status: string }>(
    "SELECT id, status FROM steps WHERE session_id = ? AND tool_name = ? ORDER BY started_at, id",
    sessionId,
    toolName,
  );
const script = (code: string) => directive("codemode", { code });
const liveTools = async (s: TestServer, id: string): Promise<LiveTool[]> =>
  ((await s.client.get(`/api/sessions/${id}`)).body.live?.tools ?? []) as LiveTool[];

/** Marks that a command started, then waits `seconds`: a nested call that stays running for a while. */
const slow = (marker: string, seconds: number) => `echo run >> "${marker}"; sleep ${seconds}`;
const started = (marker: string): number => {
  try {
    return (readFileSync(marker, "utf8").match(/run/g) ?? []).length;
  } catch {
    return 0;
  }
};
let exec: ExecServer | undefined;
afterEach(async () => {
  await exec?.destroy();
  exec = undefined;
});

describe("code mode limits in the configuration", () => {
  const faux = { REI_MODEL_MODE: "faux" };
  it("default to 10 minutes, 128 MiB and 4 scripts at once", () => {
    expect(readConfig(faux).control.codemode).toEqual({
      timeoutMs: 600_000,
      memoryLimitBytes: 134_217_728,
      maxWorkers: 4,
    });
  });

  it("are read from REI_CODEMODE_* and refuse zero", () => {
    const env = {
      ...faux,
      REI_CODEMODE_TIMEOUT_MS: "60000",
      REI_CODEMODE_MEMORY_BYTES: "33554432",
      REI_CODEMODE_MAX_WORKERS: "2",
    };
    expect(readConfig(env).control.codemode).toEqual({
      timeoutMs: 60_000,
      memoryLimitBytes: 33_554_432,
      maxWorkers: 2,
    });
    expect(() => readConfig({ ...faux, REI_CODEMODE_MAX_WORKERS: "0" })).toThrow(/REI_CODEMODE_MAX_WORKERS/);
  });
});

describe("code mode", () => {
  it("is off by default: the tool is not installed, offered or declared in the prompt", async () => {
    server = await startSignedIn();
    const id = homeChat(server);
    await say(server, id, "hello");
    await settled(server, id, 1);
    expect(installed(server, id)).not.toContain("codemode");
    expect(stepPayloads(server, id).join("\n")).not.toContain("codemode");
  });

  it("runs the faux script end to end: the result reaches the model and the nested calls are traced", async () => {
    server = await startSignedIn();
    const id = homeChat(server);
    await setCodeMode(server, true);
    await say(server, id, "/demo codemode");
    const done = await settled(server, id, 1);
    expect(done.runs.map((r) => r.status)).toEqual(["completed"]);
    const answer = done.messages.filter((m) => m.role === "assistant").at(-1)!.text;
    expect(answer).toContain("Listed my sessions twice;");
    expect(stepsOf(server, id, "codemode")).toHaveLength(1);
    expect(stepsOf(server, id, "list_sessions")).toHaveLength(2);
    expect(stepPayloads(server, id).join("\n")).toContain("codemode");
    await server.host.plane.codemode.idle();
    expect(server.host.plane.codemode.workers).toBe(0);
  });

  it("shows a running script's nested calls in the live tools with nested: true", async () => {
    exec = await startExecServer();
    const id = homeChat(exec);
    const marker = join(exec.dir, "marker.txt");
    await setCodeMode(exec, true);
    await say(
      exec,
      id,
      script(`await tools.list_sessions({}); await tools.bash({ command: ${JSON.stringify(slow(marker, 3))} });`),
    );
    const live = await until(
      async () => {
        const tools = await liveTools(exec!, id);
        return tools.some((t) => t.nested && t.name === "bash") ? tools : undefined;
      },
      10_000,
      "the nested call to show as live",
    );
    expect(live.find((t) => t.name === "codemode")).toMatchObject({ status: "running" });
    expect(live.find((t) => t.name === "bash")).toMatchObject({ nested: true });
    await settled(exec, id, 1);
    await exec.host.plane.codemode.idle();
  });

  it("keeps the prompt prefix when the setting is turned on and off again between model calls", async () => {
    server = await startSignedIn();
    const id = homeChat(server);
    await say(server, id, "first");
    await settled(server, id, 1);
    await setCodeMode(server, true);
    await setCodeMode(server, false);
    await say(server, id, "second");
    await settled(server, id, 2);
    const rows = server.host.plane.store.db.all<{ prefix_items: number | null; input_items: number }>(
      "SELECT prefix_items, input_items FROM steps WHERE session_id = ? AND type = 'llm.call' ORDER BY started_at, id",
      id,
    );
    expect(rows).toHaveLength(2);
    // Everything the first request sent, tools and sections included, is the start of the second: nothing changed.
    expect(rows[1]!.prefix_items).toBe(rows[0]!.input_items);
    expect(installed(server, id)).not.toContain("codemode");
    expect(stepPayloads(server, id).join("\n")).not.toContain("codemode");
  });

  it("installs and removes the tool in an open tree when the setting changes", async () => {
    server = await startSignedIn();
    const id = homeChat(server);
    await say(server, id, "hello");
    await settled(server, id, 1);
    await setCodeMode(server, true);
    expect(installed(server, id)).toContain("codemode");
    await say(server, id, "again");
    await settled(server, id, 2);
    expect(stepPayloads(server, id).at(-1)).toContain("codemode");
    await setCodeMode(server, false);
    expect(installed(server, id)).not.toContain("codemode");
  });

  it("declares codemode as read_internal in the catalog, with the first line of the code as its summary", async () => {
    server = await startSignedIn();
    const id = homeChat(server);
    await setCodeMode(server, true);
    await say(server, id, "hello");
    await settled(server, id, 1);
    const policy = server.host.plane.catalog.get("codemode");
    expect(policy).toMatchObject({ actionClass: "read_internal", connector: "codemode" });
    expect(policy!.summary({ code: `// @options: {"timeout_ms": 1000}\n\n${"x".repeat(200)}\nmore` })).toBe(
      `${"x".repeat(79)}…`,
    );
    expect(policy!.summary({ code: CODEMODE_DEMO_SCRIPT })).toBe("let total = 0;");
    // Every tool the extension brings is declared, so none can reach the policy hook undeclared.
    const tree = treeOf(server, id);
    const codemode = tree.registry
      .snapshot()
      .installed()
      .find((e) => e.name === "codemode")!;
    for (const t of codemode.tools ?? []) expect(server.host.plane.catalog.get(t.name)).toBeDefined();
  });

  it("fails a script over the deadline with a clear error and leaves no worker", async () => {
    exec = await startExecServer({
      config: { codemode: { timeoutMs: 500, memoryLimitBytes: 128 * 1024 * 1024, maxWorkers: 4 } },
    });
    const id = homeChat(exec);
    const marker = join(exec.dir, "marker.txt");
    await setCodeMode(exec, true);
    // The script asks for a longer deadline; the server's limit holds.
    await say(
      exec,
      id,
      script(
        `// @options: {"timeout_ms": 2000000}\nawait tools.bash({ command: ${JSON.stringify(slow(marker, 20))} });`,
      ),
    );
    const done = await settled(exec, id, 1);
    const texts = done.messages.map((m) => m.text).join("\n");
    expect(texts).toMatch(/time(d)? ?out|deadline/i);
    expect(started(marker)).toBe(1);
    await exec.host.plane.codemode.idle();
    expect(exec.host.plane.codemode.workers).toBe(0);
  });

  it("fails a script over the heap limit with a clear error and leaves no worker", async () => {
    server = await startSignedIn({
      config: { codemode: { timeoutMs: 60_000, memoryLimitBytes: 16 * 1024 * 1024, maxWorkers: 4 } },
    });
    const id = homeChat(server);
    await setCodeMode(server, true);
    await say(server, id, script("const keep = []; while (true) keep.push(new Array(100000).fill(1));"));
    await settled(server, id, 1);
    const texts = (await detail(server, id)).messages.map((m) => m.text).join("\n");
    expect(texts).toMatch(/out of memory|memory/i);
    await server.host.plane.codemode.idle();
    expect(server.host.plane.codemode.workers).toBe(0);
  });

  it("refuses a script over the concurrency limit at once, and leaves no worker", async () => {
    exec = await startExecServer({
      config: { codemode: { timeoutMs: 60_000, memoryLimitBytes: 128 * 1024 * 1024, maxWorkers: 1 } },
    });
    const first = homeChat(exec);
    const second = await chat(exec);
    const marker = join(exec.dir, "marker.txt");
    await setCodeMode(exec, true);
    await say(exec, first, script(`await tools.bash({ command: ${JSON.stringify(slow(marker, 3))} });`));
    await until(async () => (started(marker) > 0 ? true : undefined), 10_000, "the first script to be running");
    expect(exec.host.plane.codemode.workers).toBe(1);
    await say(exec, second, script('console.log("hi");'));
    const done = await settled(exec, second, 1);
    expect(done.messages.map((m) => m.text).join("\n")).toContain(TOO_MANY_SCRIPTS);
    await settled(exec, first, 1);
    await exec.host.plane.codemode.idle();
    expect(exec.host.plane.codemode.workers).toBe(0);
  });

  it("resumes a running script after a restart without repeating its finished calls", async () => {
    exec = await startExecServer();
    const id = homeChat(exec);
    const marker = join(exec.dir, "marker.txt");
    await setCodeMode(exec, true);
    await say(
      exec,
      id,
      script(
        `await tools.list_sessions({});
         try { await tools.bash({ command: ${JSON.stringify(slow(marker, 20))} }); } catch (e) { console.log("bash was cut short"); }
         await tools.list_sessions({});
         console.log("finished");`,
      ),
    );
    await until(async () => (started(marker) > 0 ? true : undefined), 15_000, "the script to start its slow call");
    expect(stepsOf(exec, id, "list_sessions")).toHaveLength(1);
    const { dir, cookie } = { dir: exec.dir, cookie: exec.client.cookie };
    await exec.stop();
    exec = await startExecServer({ dir, cookie });
    const done = await settled(exec, id, 1);
    expect(done.runs.map((r) => r.status)).toEqual(["completed"]);
    expect(done.messages.filter((m) => m.role === "assistant").at(-1)!.text).toContain("finished");
    // The script went on from where it was: the first call ran once, the command once, the last call once.
    expect(stepsOf(exec, id, "list_sessions")).toHaveLength(2);
    expect(started(marker)).toBe(1);
    await exec.host.plane.codemode.idle();
    expect(exec.host.plane.codemode.workers).toBe(0);
  });
});
