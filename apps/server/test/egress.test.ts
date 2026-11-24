import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EgressSocketListener } from "../src/node/egress-socket.ts";
import { fromBase64Url, toBase64Url } from "../src/util/encoding.ts";
import { createLogger } from "../src/util/log.ts";
import { pending, setProfile } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { askCommand, bash, type ExecServer, lastAssistant, postSocket, run, startExecServer } from "./helpers/exec.ts";
import { chat, stepPayloads, workspaceOf } from "./helpers/sessions.ts";

let server: ExecServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const start = async (...args: Parameters<typeof startExecServer>): Promise<ExecServer> =>
  (server = await startExecServer(...args));
const payloads = (s: ExecServer, id: string) => stepPayloads(s, id).join("\n");
const row = (s: ExecServer, id: string) => s.host.plane.store.getSessionRow(id)!;

const setMode = (s: ExecServer, id: string, networkMode: string) =>
  s.client.call("PATCH", `/api/agents/${row(s, id).agent_id}`, { body: { networkMode } });

describe("egress decisions over the socket", () => {
  it("allows network in Any even in a strict, tainted chat, taints the session as external, and logs it", async () => {
    const s = await start();
    const id = await chat(s);
    await setMode(s, id, "any");
    await setProfile(s, id, "strict");
    s.host.plane.store.addTaint(id, ["external", "private"]);
    const d = await run(s, id, bash(askCommand(s.socket, "Example.COM")));
    expect(lastAssistant(d)).toContain("Done. allow");
    expect(JSON.parse(row(s, id).taint)).toEqual(expect.arrayContaining(["external", "private"]));
    expect(s.logs.join("\n")).toContain('"event":"egress.allowed"');
    expect(await pending(s)).toEqual([]);
    expect(payloads(s, id)).not.toContain("Network access");
  });

  it("refuses ports other than 80 and 443 with a reason, without an approval, and tells the model", async () => {
    const s = await start();
    const id = await chat(s);
    const d = await run(s, id, bash(askCommand(s.socket, "example.com", 22)));
    expect(lastAssistant(d)).toContain("Done. deny Only ports 80 and 443 are allowed.");
    expect(payloads(s, id)).toContain(
      "[Network access to example.com is not allowed: Only ports 80 and 443 are allowed. Do not retry or work around it.]",
    );
    expect(await pending(s)).toEqual([]);
  });
});

describe("egress tokens", () => {
  it("are valid for the running run only, and the proxy variables carry them", async () => {
    const s = await start();
    const id = await chat(s);
    await setMode(s, id, "any");
    const treeId = workspaceOf(s, id);
    const egress = s.host.plane.egress;
    const running = run(
      s,
      id,
      bash('echo "$HTTPS_PROXY" > p.txt; for i in $(seq 300); do [ -f go ] && break; sleep 0.1; done'),
    );
    const file = join(s.root, treeId, "p.txt");
    await until(() => existsSync(file) && readFileSync(file, "utf8").endsWith("\n"), 10_000, "the proxy file");
    const token = decodeURIComponent(new URL(readFileSync(file, "utf8").trim()).password);
    const live = await egress.verify(token);
    expect(live?.session_id).toBe(id);
    expect(await postSocket(s.socket, JSON.stringify({ token, host: "example.com", port: 443 }))).toEqual({
      status: 200,
      json: { decision: "allow", localNetworks: "all" },
    });
    // Forged or damaged tokens never verify.
    // Mutate a decoded MAC byte: changing the final base64 character can alter only unused padding bits.
    const [runId, signature] = token.split(".");
    const damaged = fromBase64Url(signature!);
    damaged[0] = damaged[0]! ^ 1;
    const tampered = `${runId}.${toBase64Url(damaged)}`;
    for (const bad of ["", "abc", ".", "run_x.y", tampered, `${live!.id}.`, `other.${token.split(".")[1]}`])
      expect(await egress.verify(bad)).toBeUndefined();
    expect(
      (await postSocket(s.socket, JSON.stringify({ token: tampered, host: "example.com", port: 443 }))).json,
    ).toEqual({ decision: "deny", message: "This connection does not belong to a running task." });
    // The command waits for this file, so the run is surely still going while the checks above run.
    writeFileSync(join(s.root, treeId, "go"), "");
    await running;
    // The run is over: the same token is worth nothing now.
    expect(await egress.verify(token)).toBeUndefined();
    expect((await postSocket(s.socket, JSON.stringify({ token, host: "example.com", port: 443 }))).json).toEqual({
      decision: "deny",
      message: "This connection does not belong to a running task.",
    });
  });

  it("do not survive a restart of the process", async () => {
    const s = await start();
    const id = await chat(s);
    const token = await s.host.plane.egress.issue("run_000000000000000000000000");
    await run(s, id, "hi");
    const { dir, cookie } = { dir: s.dir, cookie: s.client.cookie! };
    await s.stop();
    const other = await startExecServer({ dir, cookie });
    expect(await other.host.plane.egress.verify(token)).toBeUndefined();
    server = other;
  });
});

describe("the decide listener", () => {
  it("is a unix socket with mode 0600, answers only POST /egress/decide, validates the body, and is not on the main app", async () => {
    const s = await start();
    expect(statSync(s.socket).isSocket()).toBe(true);
    expect(statSync(s.socket).mode & 0o777).toBe(0o600);
    const token = "run_x.y";
    expect((await postSocket(s.socket, JSON.stringify({ token, host: "example.com", port: 443 }))).status).toBe(200);
    for (const body of [
      "not json",
      "{}",
      JSON.stringify({ token, host: "example.com", port: "443" }),
      JSON.stringify({ token, host: 1, port: 443 }),
      JSON.stringify({ token, host: "a", port: 4.5 }),
      "x".repeat(10_000),
    ]) {
      expect((await postSocket(s.socket, body)).status).toBe(400);
    }
    expect((await postSocket(s.socket, "{}", "/other")).status).toBe(404);
    expect((await postSocket(s.socket, "{}", "/egress/decide", "GET")).status).toBe(404);
    expect((await s.client.post("/egress/decide", { token, host: "example.com", port: 443 })).status).toBe(404);
    expect(s.logs.join("\n")).not.toContain(token);
  });

  it("replaces a stale socket at start, and removes its socket on stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e-"));
    try {
      const path = join(dir, "decide.sock");
      const made = spawnSync("python3", [
        "-c",
        "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])",
        path,
      ]);
      expect(made.status).toBe(0);
      expect(statSync(path).isSocket()).toBe(true);
      const listener = new EgressSocketListener(
        path,
        createLogger(() => undefined),
      );
      await listener.start(async () => ({ decision: "deny", message: "no" }));
      expect((await postSocket(path, JSON.stringify({ token: "t", host: "h", port: 80 }))).json).toEqual({
        decision: "deny",
        message: "no",
      });
      await listener.stop();
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is not started when no socket is configured", async () => {
    const s = await start({ socket: false });
    expect(existsSync(s.socket)).toBe(false);
  });

  it("goes away when the control plane stops", async () => {
    const s = await start();
    await s.stop();
    expect(existsSync(s.socket)).toBe(false);
  });
});

describe("the sandbox network setting", () => {
  // A run that holds still until its `go` file appears, so its proxy token can be asked about while it runs.
  async function holdRun(s: ExecServer, id: string) {
    const treeId = workspaceOf(s, id);
    const running = run(
      s,
      id,
      bash('echo "$HTTPS_PROXY" > p.txt; for i in $(seq 300); do [ -f go ] && break; sleep 0.1; done'),
    );
    const file = join(s.root, treeId, "p.txt");
    await until(() => existsSync(file) && readFileSync(file, "utf8").endsWith("\n"), 10_000, "the proxy file");
    const token = decodeURIComponent(new URL(readFileSync(file, "utf8").trim()).password);
    return {
      token,
      ask: (host: string, port = 443) =>
        postSocket(s.socket, JSON.stringify({ token, host, port })).then((r) => r.json),
      release: async () => {
        writeFileSync(join(s.root, treeId, "go"), "");
        await running;
      },
    };
  }
  const outside = { decision: "deny", message: "The destination is outside the sandbox whitelist." };

  it("Block denies every host even in a yolo chat", async () => {
    const s = await start();
    const id = await chat(s);
    await setProfile(s, id, "yolo");
    const held = await holdRun(s, id);
    const blocked = { decision: "deny", message: "Sandbox network access is blocked." };
    expect(await held.ask("10.0.0.5")).toEqual(blocked);
    expect(await held.ask("example.com")).toEqual(blocked);
    expect(await pending(s)).toEqual([]);
    await held.release();
  });

  it("Whitelist permits listed names and denies unlisted names, and a local address needs its name and its address on the whitelist", async () => {
    const s = await start();
    const id = await chat(s);
    expect((await setMode(s, id, "whitelist")).status).toBe(200);
    const held = await holdRun(s, id);
    // Public sites open without a local-network scope: the defaults name no address.
    expect(await held.ask("pypi.org")).toEqual({ decision: "allow", localNetworks: [] });
    expect(await held.ask("Files.PythonHosted.org", 80)).toEqual({ decision: "allow", localNetworks: [] });
    expect(await pending(s)).toEqual([]);
    expect(await held.ask("example.com")).toEqual(outside);
    expect(await held.ask("10.0.0.5")).toEqual(outside);
    const { defaults } = (await s.client.get("/api/settings/sandbox-network")).body;
    const put = (whitelist: string[]) => s.client.call("PUT", "/api/settings/sandbox-network", { body: { whitelist } });
    // A network entry alone opens the address when it is typed as an address (the address is its own name).
    expect((await put([...defaults, "10.0.0.0/8"])).status).toBe(200);
    expect(await held.ask("10.0.0.5")).toEqual({ decision: "allow", localNetworks: ["10.0.0.0/8"] });
    expect(await held.ask("192.168.1.10")).toEqual(outside);
    // A name alone does not open its address: the network entry is not enough for a name that is not listed.
    expect(await held.ask("fileserver.lan")).toEqual(outside);
    // A listed name opens only the addresses the whitelist names too.
    expect((await put([...defaults, "10.0.0.0/8", "fileserver.lan"])).status).toBe(200);
    expect(await held.ask("fileserver.lan")).toEqual({ decision: "allow", localNetworks: ["10.0.0.0/8"] });
    expect((await put([...defaults, "nas.lan"])).status).toBe(200);
    expect(await held.ask("nas.lan")).toEqual({ decision: "allow", localNetworks: [] });
    await held.release();
  });

  it("Any allows public and local destinations even after private data enters the chat", async () => {
    const s = await start();
    const id = await chat(s);
    expect((await setMode(s, id, "any")).status).toBe(200);
    const held = await holdRun(s, id);
    expect(await held.ask("10.0.0.6")).toEqual({ decision: "allow", localNetworks: "all" });
    expect(await held.ask("example.com")).toEqual({ decision: "allow", localNetworks: "all" });
    expect(await pending(s)).toEqual([]);
    s.host.plane.store.addTaint(id, ["private"]);
    expect(await held.ask("other.example")).toEqual({ decision: "allow", localNetworks: "all" });
    expect(await pending(s)).toEqual([]);
    await held.release();
  });
});
