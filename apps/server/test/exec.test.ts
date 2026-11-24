import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tool } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { bash, type ExecServer, lastAssistant, run, startExecServer } from "./helpers/exec.ts";
import { startSignedIn } from "./helpers/server.ts";
import { chat, homeChat, settled, stepPayloads, treeOf, workspaceOf } from "./helpers/sessions.ts";

let server: { destroy(): Promise<void> } | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const start = async (...args: Parameters<typeof startExecServer>): Promise<ExecServer> => {
  const s = await startExecServer(...args);
  server = s;
  return s;
};

describe("sandbox tools", () => {
  it("run read, write, edit and bash in a workspace of the chat's agent", async () => {
    const s = await start();
    const id = await chat(s);
    const treeId = workspaceOf(s, id);
    expect(existsSync(join(s.root, treeId))).toBe(false); // made on first use
    await run(s, id, `${tool("write", { path: "n.txt", content: "hello" })}`);
    expect(readFileSync(join(s.root, treeId, "n.txt"), "utf8")).toBe("hello");
    expect(lastAssistant(await run(s, id, tool("read", { path: "n.txt" })))).toContain("hello");
    await run(s, id, tool("edit", { path: "n.txt", edits: [{ oldText: "hello", newText: "bye" }] }));
    expect(readFileSync(join(s.root, treeId, "n.txt"), "utf8")).toBe("bye");
    const out = lastAssistant(await run(s, id, bash("pwd; cat n.txt")));
    expect(out).toContain(join(s.root, treeId));
    expect(out).toContain("bye");
  });

  it("shares one workspace across the agent's chats and forks, while another agent has its own", async () => {
    const s = await start();
    const a = await chat(s);
    const b = await chat(s);
    await run(s, a, tool("write", { path: "shared.txt", content: "from a" }));
    const d = await run(s, a, bash("ls"));
    const reply = d.messages.filter((m) => m.role === "assistant").at(-1)!;
    const forked = (await s.client.post(`/api/sessions/${a}/fork`, { messageId: reply.id })).body.session as {
      id: string;
    };
    expect(treeOf(s, forked.id)).toBe(treeOf(s, a));
    expect(lastAssistant(await run(s, forked.id, bash("cat shared.txt")))).toContain("from a");
    // Another chat of the same agent shares files too. A different agent does not.
    expect(lastAssistant(await run(s, b, bash("cat shared.txt")))).toContain("from a");
    const other = s.host.plane.adapter.createAgent({ name: "Other", avatar: "O", instructions: "Help." });
    expect(lastAssistant(await run(s, other.session.id, bash("ls; echo end")))).not.toContain("shared.txt");
    expect(readdirSync(s.root).sort()).toEqual([workspaceOf(s, a), other.agent.id].sort());
  });

  it("gives bash a 120 s timeout by default and caps it at 600 s", async () => {
    const s = await start();
    const id = await chat(s);
    await run(s, id, bash("true"));
    await run(s, id, bash("true", 30));
    await run(s, id, bash("true", 9999));
    expect(s.spy.execCalls.map((c) => c.timeout)).toEqual([120, 30, 600]);
  });

  it("sets the git prompt switch, and the proxy variables only while a run is going", async () => {
    const s = await start();
    const id = await chat(s);
    const treeId = workspaceOf(s, id);
    await run(
      s,
      id,
      bash(`echo "$HTTPS_PROXY" > proxy.txt; echo "$NO_PROXY $GIT_TERMINAL_PROMPT" > other.txt; sleep 1`),
    );
    const call = s.spy.execCalls.at(-1)!;
    expect(Object.keys(call.env ?? {}).sort()).toEqual([
      "GIT_TERMINAL_PROMPT",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NODE_USE_ENV_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ]);
    const proxy = readFileSync(join(s.root, treeId, "proxy.txt"), "utf8").trim();
    expect(proxy).toMatch(/^http:\/\/run:run_[0-9a-f]{24}\.[A-Za-z0-9_-]{43}@egress:3128$/);
    expect(proxy).toContain(`run:${s.host.plane.store.runs.forSession(id).at(-1)!.id}.`);
    expect(readFileSync(join(s.root, treeId, "other.txt"), "utf8").trim()).toBe("localhost,127.0.0.1 0");
  });

  it("gives no proxy variables when no proxy is configured", async () => {
    const s = await start({ proxy: false });
    const id = await chat(s);
    await run(s, id, bash("true"));
    expect(Object.keys(s.spy.execCalls.at(-1)!.env ?? {})).toEqual(["GIT_TERMINAL_PROMPT"]);
  });

  it("tells the model about the sandbox in the prompt, and only when execution is on", async () => {
    const s = await start();
    const id = await chat(s);
    await run(s, id, "hello");
    const text = stepPayloads(s, id).join("\n");
    expect(text).toContain(`Your working directory is ${join(s.root, workspaceOf(s, id))}`);
    expect(text).toContain("at most 600 seconds");
    await s.destroy();
    const off = await startSignedIn();
    server = off;
    expect(off.host.plane.workspaces).toBeUndefined();
    const offId = await chat(off);
    await run(off, offId, "hello");
    expect(stepPayloads(off, offId).join("\n")).not.toContain("Your working directory is");
  });

  it("answers an unavailable sandbox with an ordinary tool error: the run still completes and the chat goes on", async () => {
    const s = await start();
    const id = await chat(s);
    s.spy.readyError = new Error("The sandbox is not available right now.");
    const d = await run(s, id, bash("echo hi"));
    expect(d.runs.at(-1)!.status).toBe("completed");
    expect(lastAssistant(d)).toContain("The sandbox is not available right now.");
    s.spy.readyError = undefined;
    expect(lastAssistant(await run(s, id, bash("echo back")))).toContain("back");
  });

  // What Pi does when HarnessOptions.env throws: building the environment for a tool call is part of the call, so it
  // ends as an ordinary tool error (the task is marked failed, the run is not). Model calls only report it.
  it("treats a throwing env() as an ordinary tool error, not a crash or a run failure", async () => {
    const s = await start();
    const id = await chat(s);
    s.spy.envError = new Error("env exploded");
    const d = await run(s, id, bash("echo hi"));
    expect(d.runs.at(-1)!.status).toBe("completed");
    expect(lastAssistant(d)).toContain("env exploded");
    s.spy.envError = undefined;
    expect(lastAssistant(await run(s, id, bash("echo fine")))).toContain("fine");
    // A chat without tools is not affected either.
    s.spy.envError = new Error("env exploded");
    expect((await run(s, id, "just talk")).runs.at(-1)!.status).toBe("completed");
  });
});

describe("workspace lifecycle", () => {
  it("home and workers exchange files, and deleting workers or clearing home keeps the shared workspace", async () => {
    const s = await start();
    const home = homeChat(s);
    const owner = workspaceOf(s, home);
    await run(s, home, tool("write", { path: "brief.txt", content: "shared brief" }));
    const caller = s.host.plane.store.getSessionRow(home)!;
    await s.host.plane.adapter.startSession({ caller, callId: "shared", brief: tool("read", { path: "brief.txt" }) });
    const [child] = s.host.plane.store.childrenOf(home);
    expect(lastAssistant(await settled(s, child!.id))).toContain("shared brief");
    await run(s, child!.id, tool("write", { path: "result.txt", content: "worker result" }));
    expect(lastAssistant(await run(s, home, tool("read", { path: "result.txt" })))).toContain("worker result");
    expect((await s.client.call("DELETE", `/api/sessions/${child!.id}`)).status).toBe(200);
    await s.host.plane.adapter.deleteSession(home, false, true);
    const fresh = homeChat(s);
    expect(fresh).not.toBe(home);
    expect(lastAssistant(await run(s, fresh, bash("cat brief.txt result.txt")))).toContain("worker result");
    expect(existsSync(join(s.root, owner, "brief.txt"))).toBe(true);
    expect(s.host.plane.workspaces!.pending()).toEqual([]);
  });

  it("cross-agent workers use their own agent's workspace", async () => {
    const s = await start();
    const home = homeChat(s);
    await run(s, home, tool("write", { path: "private.txt", content: "parent file" }));
    const other = s.host.plane.adapter.createAgent({ name: "Researcher", avatar: "R", instructions: "Research." });
    await s.host.plane.adapter.startSession({
      caller: s.host.plane.store.getSessionRow(home)!,
      callId: "cross",
      agent: other.agent.id,
      brief: bash("pwd; ls"),
    });
    const [child] = s.host.plane.store.childrenOf(home);
    const d = await settled(s, child!.id);
    expect(lastAssistant(d)).toContain(join(s.root, other.agent.id));
    expect(lastAssistant(d)).not.toContain("private.txt");
  });

  it("carries file-sharing sessions' private labels into a sandbox reader", async () => {
    const s = await start();
    const a = await chat(s);
    const b = await chat(s);
    s.host.plane.store.addTaint(a, ["private", "external"]);
    await run(s, a, tool("write", { path: "secret.txt", content: "secret" }));
    await run(s, b, tool("read", { path: "secret.txt" }));
    expect(s.host.plane.store.getSession(b)!.taint.sort()).toEqual(["external", "private"]);
  });

  it("purges shared files only when the agent is deleted", async () => {
    const s = await start();
    const other = s.host.plane.adapter.createAgent({ name: "Other", avatar: "O", instructions: "Help." });
    await run(s, other.session.id, tool("write", { path: "f.txt", content: "x" }));
    await s.host.plane.adapter.deleteAgent(other.agent.id);
    await s.host.plane.workspaces!.settled();
    expect(existsSync(join(s.root, other.agent.id))).toBe(false);
    expect(s.host.plane.workspaces!.pending()).toEqual([]);
  });

  it("retries an agent purge when the sandbox is unavailable", async () => {
    const s = await start();
    const other = s.host.plane.adapter.createAgent({ name: "Other", avatar: "O", instructions: "Help." });
    await run(s, other.session.id, tool("write", { path: "f.txt", content: "x" }));
    s.spy.purgeFailures = 2;
    await s.host.plane.adapter.deleteAgent(other.agent.id);
    await until(() => !existsSync(join(s.root, other.agent.id)), 10_000, "the retried purge");
    await s.host.plane.workspaces!.settled();
    expect(s.logs.join("\n")).toContain('"event":"workspace.purge_failed"');
    expect(s.host.plane.workspaces!.pending()).toEqual([]);
  });

  it("finishes a pending agent purge at the next start", async () => {
    const s = await start();
    const other = s.host.plane.adapter.createAgent({ name: "Other", avatar: "O", instructions: "Help." });
    await run(s, other.session.id, tool("write", { path: "f.txt", content: "x" }));
    s.spy.purgeFailures = 1000;
    await s.host.plane.adapter.deleteAgent(other.agent.id);
    await until(() => s.host.plane.workspaces!.pending().length > 0, 5_000, "a pending purge");
    const { dir, cookie } = { dir: s.dir, cookie: s.client.cookie };
    await s.stop();
    expect(existsSync(join(s.root, other.agent.id))).toBe(true);
    const next = await startExecServer({ dir, cookie: cookie! });
    server = next;
    await until(() => !existsSync(join(next.root, other.agent.id)), 10_000, "the purge at start");
    await next.host.plane.workspaces!.settled();
    expect(next.host.plane.workspaces!.pending()).toEqual([]);
  });
});
