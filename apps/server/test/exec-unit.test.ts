import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { type ExecutionEnv, ExecutionError, err, ok } from "@earendil-works/pi-durable/env";
import type { Connection } from "@earendil-works/pi-env";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/control-plane.ts";
import { type ExecBackend, UNAVAILABLE } from "../src/exec/backend.ts";
import { blockNote, EgressService } from "../src/exec/egress.ts";
import { createExecExtension, DEADLINE_TEXT, effectiveTimeout, LOST_TEXT, sandboxNote } from "../src/exec/tools.ts";
import { checkExecConfig, readConfig } from "../src/node/config.ts";
import { LocalExecBackend } from "../src/node/exec-local.ts";
import { knownHostsLine, ReconnectingConnection, SshExecBackend } from "../src/node/exec-ssh.ts";
import { createExecBackend } from "../src/node/host.ts";
import { parseApprovalInput } from "../src/pi/faux.ts";
import { ToolCatalog } from "../src/pi/policy-ext.ts";
import { approvedText } from "../src/store/approvals.ts";
import { nullLogger } from "../src/util/log.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "rei-unit-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIA28Kjj1K2xbDRe/qKcXMsnHFzaMCg6/mLEOiylSOPxC";

describe("config", () => {
  // A deployment has to have an object store and a retrieval service (M11), so a gateway-mode readConfig without them is
  // meant to fail. These tests are about other settings, so they are given a complete storage environment in temp files.
  const storageDir = mkdtempSync(join(tmpdir(), "rei-storage-config-"));
  afterAll(() => rmSync(storageDir, { recursive: true, force: true }));
  const secretFile = (name: string, value: string): string => {
    const path = join(storageDir, name);
    writeFileSync(path, `${value}\n`, { mode: 0o600 });
    return path;
  };
  const base = {
    GATEWAY_URL: "http://gateway:8780",
    REI_GARAGE_ENDPOINT: "http://garage:3900",
    REI_GARAGE_BUCKET: "rei-files",
    REI_GARAGE_ACCESS_KEY_FILE: secretFile("garage-access", "GK0123456789abcdef0123456789abcdef"),
    REI_GARAGE_SECRET_KEY_FILE: secretFile("garage-secret", "0123456789abcdef0123456789abcdef"),
    REI_QDRANT_URL: "http://qdrant:6333",
    REI_QDRANT_API_KEY_FILE: secretFile("qdrant-key", "test-qdrant-key"),
  };
  it("refuses a real deployment with no file store, and accepts one that names the folder fallback", () => {
    const gateway = { GATEWAY_URL: base.GATEWAY_URL, REI_DATA_DIR: storageDir };
    expect(() => readConfig(gateway)).toThrow(/REI_GARAGE_ENDPOINT and REI_QDRANT_URL are required/);
    // Half-set is the dangerous one: it would mean files written somewhere nobody reads.
    expect(() => readConfig({ ...gateway, REI_GARAGE_ENDPOINT: base.REI_GARAGE_ENDPOINT })).toThrow(/half-configured/);
    const allowed = readConfig({ ...gateway, REI_ALLOW_FOLDER_FILES: "1" });
    expect(allowed.garage).toBeUndefined();
    expect(allowed.qdrant).toBeUndefined();
    // Faux mode (tests, the offline smoke) never needs either.
    expect(readConfig({ REI_MODEL_MODE: "faux", REI_DATA_DIR: storageDir }).garage).toBeUndefined();
  });

  it("reads the storage keys from the variables Garage and Qdrant bootstrap from, as secrets.env supplies them", () => {
    const fromEnv = {
      GATEWAY_URL: base.GATEWAY_URL,
      REI_GARAGE_ENDPOINT: base.REI_GARAGE_ENDPOINT,
      REI_GARAGE_BUCKET: base.REI_GARAGE_BUCKET,
      REI_QDRANT_URL: base.REI_QDRANT_URL,
      GARAGE_DEFAULT_ACCESS_KEY: "GKfromenv0123456789abcdef0123456789",
      GARAGE_DEFAULT_SECRET_KEY: "secretfromenv",
      QDRANT__SERVICE__API_KEY: "qdrantfromenv",
    };
    const config = readConfig(fromEnv);
    expect(config.garage?.accessKeyId).toBe("GKfromenv0123456789abcdef0123456789");
    expect(config.garage?.secretAccessKey).toBe("secretfromenv");
    expect(config.qdrant?.apiKey).toBe("qdrantfromenv");
    // A missing key names both ways to supply it.
    const { QDRANT__SERVICE__API_KEY: _omitted, ...withoutQdrantKey } = fromEnv;
    expect(() => readConfig(withoutQdrantKey)).toThrow(/REI_QDRANT_API_KEY_FILE or QDRANT__SERVICE__API_KEY/);
    // A file still wins when one is named.
    expect(readConfig({ ...fromEnv, REI_QDRANT_API_KEY_FILE: base.REI_QDRANT_API_KEY_FILE }).qdrant?.apiKey).toBe(
      "test-qdrant-key",
    );
  });
  it.each(["0.5", "-1", "Infinity", "NaN", "9007199254740992"])("rejects invalid integer settings: %s", (value) => {
    expect(() => readConfig({ ...base, REI_RETRY_MAX: value })).toThrow(/REI_RETRY_MAX/);
  });
  it("reads REI_LOG_LEVEL, defaulting to info, and refuses a typo at startup", () => {
    expect(readConfig(base).logLevel).toBe("info");
    expect(readConfig({ ...base, REI_LOG_LEVEL: "DEBUG" }).logLevel).toBe("debug");
    expect(() => readConfig({ ...base, REI_LOG_LEVEL: "verbose" })).toThrow(/REI_LOG_LEVEL must be one of/);
  });
  it("reads REI_PUBLIC_URL as an origin, and refuses anything but an http(s) URL", () => {
    expect(readConfig(base).control.publicUrl).toBeUndefined();
    expect(readConfig({ ...base, REI_PUBLIC_URL: "https://rei.example.ts.net/" }).control.publicUrl).toBe(
      "https://rei.example.ts.net",
    );
    expect(() => readConfig({ ...base, REI_PUBLIC_URL: "rei.example.com" })).toThrow(/REI_PUBLIC_URL/);
    expect(() => readConfig({ ...base, REI_PUBLIC_URL: "ftp://rei.example.com" })).toThrow(/REI_PUBLIC_URL/);
  });
  it.each(["0.5", "65536", "-1"])("rejects an invalid server port: %s", (value) => {
    expect(() => readConfig({ ...base, REI_PORT: value })).toThrow(/REI_PORT/);
  });
  it.each(["0", "65536", "1.5"])("rejects an invalid SSH port: %s", (value) => {
    expect(() =>
      readConfig({ ...base, REI_EXEC: "ssh", REI_EXEC_HOST: "exec", REI_EXEC_KEYS: "/keys", REI_EXEC_PORT: value }),
    ).toThrow(/REI_EXEC_PORT/);
  });
  it("keeps ephemeral server ports and zero retry limits, and treats blank values as unset", () => {
    expect(readConfig({ ...base, REI_PORT: "0", REI_RETRY_MAX: "0" }).port).toBe(0);
    expect(readConfig({ ...base, REI_RETRY_MAX: "0" }).control.retry.enabled).toBe(false);
    expect(readConfig({ ...base, REI_PORT: "  ", REI_RETRY_MAX: " " }).port).toBe(8787);
    expect(readConfig({ ...base, REI_RETRY_MAX: " " }).control.retry).toEqual(DEFAULT_CONFIG.retry);
  });

  it("defaults to no execution", () => {
    expect(readConfig(base).control.exec).toEqual({ mode: "off" });
    expect(DEFAULT_CONFIG.exec).toEqual({ mode: "off" });
  });
  it("refuses local execution outside faux mode, and accepts it in faux mode", () => {
    expect(() => readConfig({ ...base, REI_EXEC: "local" })).toThrow(/faux/);
    expect(
      readConfig({
        REI_MODEL_MODE: "faux",
        REI_EXEC: "local",
        REI_EXEC_ROOT: "/tmp/w",
        REI_EGRESS_SOCKET: "/run/e.sock",
        REI_EGRESS_PROXY: "egress:3128",
      }).control.exec,
    ).toEqual({
      mode: "local",
      root: "/tmp/w",
      egressSocket: "/run/e.sock",
      egressProxy: "egress:3128",
    });
    const config = readConfig({ REI_MODEL_MODE: "faux", REI_EXEC: "local" });
    expect(createExecBackend(config, nullLogger)).toBeInstanceOf(LocalExecBackend);
    // The host checks it again, whatever built the config.
    expect(() => createExecBackend({ ...config, control: { ...config.control, mode: "gateway" } }, nullLogger)).toThrow(
      /faux/,
    );
  });
  it("needs host and keys for ssh, with port 2222 by default, and rejects other values", () => {
    expect(() => readConfig({ ...base, REI_EXEC: "ssh" })).toThrow(/REI_EXEC_HOST/);
    expect(() => readConfig({ ...base, REI_EXEC: "ssh", REI_EXEC_HOST: "exec" })).toThrow(/REI_EXEC_KEYS/);
    expect(
      readConfig({ ...base, REI_EXEC: "ssh", REI_EXEC_HOST: "exec", REI_EXEC_KEYS: "/run/exec-keys" }).control.exec,
    ).toEqual({ mode: "ssh", host: "exec", port: 2222, keysDir: "/run/exec-keys" });
    expect(
      readConfig({ ...base, REI_EXEC: "ssh", REI_EXEC_HOST: "exec", REI_EXEC_KEYS: "/k", REI_EXEC_PORT: "2200" })
        .control.exec.port,
    ).toBe(2200);
    expect(() => readConfig({ ...base, REI_EXEC: "docker" })).toThrow(/REI_EXEC/);
    expect(() => checkExecConfig("faux", { mode: "off" })).not.toThrow();
  });
});

describe("ssh backend", () => {
  it("builds the known_hosts line from the host public key under the host key alias, and refuses anything else", () => {
    expect(knownHostsLine(`ssh-ed25519 ${KEY} root@exec\n`)).toBe(`rei-exec ssh-ed25519 ${KEY}`);
    expect(knownHostsLine(`ssh-ed25519 ${KEY}`, "x")).toBe(`x ssh-ed25519 ${KEY}`);
    for (const bad of ["", "ssh-ed25519", `ssh-ed25519 ${KEY}!`, `rm-rf ${KEY}`, `-----BEGIN OPENSSH PRIVATE KEY-----`])
      expect(() => knownHostsLine(bad)).toThrow(/public key/);
  });

  it("writes a 0600 known_hosts with that line, paths workspaces by tree id, and refuses odd tree ids", () => {
    const keys = tmp();
    writeFileSync(join(keys, "host_ed25519_key.pub"), `ssh-ed25519 ${KEY} host\n`);
    const backend = new SshExecBackend({ host: "exec", port: 2222, keysDir: keys, log: nullLogger });
    cleanup.push(() => backend.close());
    expect(readFileSync(backend.knownHostsFile, "utf8")).toBe(`rei-exec ssh-ed25519 ${KEY}\n`);
    expect(statSync(backend.knownHostsFile).mode & 0o777).toBe(0o600);
    expect(backend.cwd("tr_0123abcd")).toBe("/workspace/tr_0123abcd");
    expect(backend.env("tr_0123abcd")).toMatchObject({ id: "exec:tr_0123abcd", cwd: "/workspace/tr_0123abcd" });
    for (const bad of ["", "../x", "a/b", "a b", "a;b"]) {
      expect(() => backend.cwd(bad)).toThrow();
      expect(() => backend.env(bad)).toThrow();
    }
  });

  it("fails fast at start when the host key is missing, and says the sandbox is unavailable when nothing answers", async () => {
    expect(() => new SshExecBackend({ host: "exec", port: 2222, keysDir: tmp(), log: nullLogger })).toThrow();
    const keys = tmp();
    writeFileSync(join(keys, "host_ed25519_key.pub"), `ssh-ed25519 ${KEY}\n`);
    const port = await closedPort();
    const backend = new SshExecBackend({
      host: "127.0.0.1",
      port,
      keysDir: keys,
      log: nullLogger,
      reconnect: { waitMs: 200, intervalMs: 50, probeMs: 200 },
    });
    cleanup.push(() => backend.close());
    await expect(backend.ready("tr_a")).rejects.toThrow(UNAVAILABLE);
    await expect(backend.purge("tr_a")).rejects.toThrow(UNAVAILABLE);
  });
});

const fakeConnection = () => ({
  closed: false,
  close() {
    this.closed = true;
  },
});
async function listening(port = 0): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { server, port: (server.address() as { port: number }).port };
}
async function closedPort(): Promise<number> {
  const { server, port } = await listening();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("ReconnectingConnection", () => {
  const make = () => {
    const made: ReturnType<typeof fakeConnection>[] = [];
    return { made, factory: () => (made.push(fakeConnection()), made.at(-1) as unknown as Connection) };
  };

  it("starts with one lazy connection and replaces it on reset, closing the old one", () => {
    const { made, factory } = make();
    const rc = new ReconnectingConnection(factory, { host: "127.0.0.1", port: 1 });
    expect(made).toHaveLength(1);
    const first = rc.connection;
    rc.reset();
    expect(rc.connection).not.toBe(first);
    expect(made.map((c) => c.closed)).toEqual([true, false]);
    expect(rc.resets).toBe(1);
  });

  it("is reachable at once when the port answers, without resetting", async () => {
    const { port } = await listening();
    const { made, factory } = make();
    const rc = new ReconnectingConnection(factory, { host: "127.0.0.1", port });
    expect(await rc.reachable()).toBe(true);
    expect(await rc.tcpProbe()).toBeUndefined();
    expect(made).toHaveLength(1);
  });

  it("gives up after the wait when nothing answers, resetting the connection once", async () => {
    const port = await closedPort();
    const { made, factory } = make();
    const rc = new ReconnectingConnection(
      factory,
      { host: "127.0.0.1", port },
      { waitMs: 300, intervalMs: 50, probeMs: 200 },
    );
    const started = Date.now();
    expect(await rc.reachable()).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(rc.resets).toBe(1);
    expect(made).toHaveLength(2);
    expect(await rc.tcpProbe()).toMatch(/ECONNREFUSED|refused/i);
  });

  it("waits for a container that comes back", async () => {
    const port = await closedPort();
    const { factory } = make();
    const rc = new ReconnectingConnection(
      factory,
      { host: "127.0.0.1", port },
      { waitMs: 3_000, intervalMs: 50, probeMs: 200 },
    );
    const back = new Promise<void>((resolve) => setTimeout(() => void listening(port).then(() => resolve()), 300));
    expect(await rc.reachable()).toBe(true);
    await back;
  });
});

describe("the sandbox tools", () => {
  const harness = (
    options: { ready?: () => Promise<void>; run?: ExecutionEnv["exec"]; proxy?: string; margin?: number } = {},
  ) => {
    const resets: number[] = [];
    const catalog = new ToolCatalog();
    const backend = {
      mode: "local",
      cwd: (t: string) => `/w/${t}`,
      env: () => {
        throw new Error("unused");
      },
      ready: options.ready ?? (async () => undefined),
      reset: () => void resets.push(Date.now()),
      purge: async () => undefined,
      close: async () => undefined,
    } as unknown as ExecBackend;
    const store = {
      db: { get: () => undefined },
      sessionByConversation: () => ({ id: "ses_1" }),
      nonTerminalRuns: () => [{ id: "run_000000000000000000000001", status: "running" }],
      runningRun: () => ({ id: "run_000000000000000000000001", status: "running" }),
    };
    const egress = new EgressService({ store: store as never, log: nullLogger });
    const ext = createExecExtension({
      treeId: "tr_1",
      store: store as never,
      backend,
      egress,
      catalog,
      proxy: options.proxy,
      deadlineMarginS: options.margin ?? 0.1,
    });
    const bash = (ext.tools as ToolRegistration[]).find((t) => t.name === "bash")!;
    const calls: { options: Parameters<ExecutionEnv["exec"]>[1] }[] = [];
    const env = {
      cwd: "/w/tr_1",
      exec: (
        command: unknown,
        execOptions: Parameters<ExecutionEnv["exec"]>[1],
        context: Parameters<ExecutionEnv["exec"]>[2],
      ) => {
        calls.push({ options: execOptions });
        return (options.run ?? (async () => ok({ exitCode: 0 })))(command as string, execOptions, context);
      },
    };
    let out = "";
    const api = {
      conversationId: 1,
      env,
      output: (t: string) => void (out += t),
      retainedOutput: () => ({ text: out, truncated: false }),
      diagnostic: () => undefined,
      outputWindow: undefined,
    };
    const call = (args: { command: string; timeout?: number }) =>
      bash.execute(args as never, api as never, {} as never);
    return { catalog, ext, call, calls, resets, output: () => out };
  };

  it("declares read, write, edit and bash in the catalog as internal sandbox tools", () => {
    const { catalog, ext } = harness();
    expect((ext.tools as ToolRegistration[]).map((t) => t.name)).toEqual(["read", "write", "edit", "bash"]);
    expect(catalog.names()).toEqual(["read", "write", "edit", "bash"]);
    expect(catalog.get("read")).toMatchObject({
      actionClass: "read_internal",
      connector: "sandbox",
      operation: "read",
    });
    for (const name of ["write", "edit", "bash"])
      expect(catalog.get(name)).toMatchObject({ actionClass: "write_internal", connector: "sandbox", operation: name });
    expect(catalog.get("read")!.summary({ path: "a.txt" })).toBe("Read a.txt");
    expect(catalog.get("bash")!.summary({ command: "ls -la" })).toBe("Run: ls -la");
    expect(catalog.get("bash")!.summary({ command: "x".repeat(500) })).toHaveLength("Run: ".length + 200);
    expect(sandboxNote("/workspace/tr_1")).toContain("/workspace/tr_1");
    expect(sandboxNote("/workspace/tr_1")).toContain("Python packages with uv and Node.js packages with npm");
    expect(sandboxNote("/workspace/tr_1", "block")).toBe(sandboxNote("/workspace/tr_1"));
    expect(sandboxNote("/workspace/tr_1", "whitelist")).toContain("can reach only whitelisted sites");
    expect(sandboxNote("/workspace/tr_1", "any")).toContain("without approval");
  });

  it("caps and defaults the timeout", () => {
    expect([undefined, 5, 600, 601, 1e9].map(effectiveTimeout)).toEqual([120, 5, 600, 600, 600]);
    expect(effectiveTimeout(-1)).toBe(-1); // refused later by Pi, with its own message
    expect(effectiveTimeout(Number.NaN)).toBeNaN();
  });

  it("passes the effective timeout and the proxy variables to the environment", async () => {
    const h = harness({ proxy: "egress:3128" });
    await h.call({ command: "true" });
    await h.call({ command: "true", timeout: 5000 });
    expect(h.calls.map((c) => c.options?.timeout)).toEqual([120, 600]);
    const env = h.calls[0]!.options!.env!;
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/run:run_000000000000000000000001\.[A-Za-z0-9_-]{43}@egress:3128$/);
    expect(env.https_proxy).toBe(env.HTTPS_PROXY);
    expect(env.HTTP_PROXY).toBe(env.HTTPS_PROXY);
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("gives up on a call the sandbox does not answer within the timeout plus the margin, resets the connection and says so", async () => {
    const h = harness({ run: () => new Promise(() => undefined), margin: 0.15 });
    const started = Date.now();
    await expect(h.call({ command: "sleep 1000", timeout: 0.1 })).rejects.toThrow(DEADLINE_TEXT);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(240);
    expect(took).toBeLessThan(2_000);
    expect(h.resets).toHaveLength(1);
  });

  it("explains a lost or timed out connection, and leaves other errors alone", async () => {
    for (const message of ["pi-env connection lost", "pi-env connection timed out"]) {
      const h = harness({ run: async () => err(new ExecutionError("unknown", message)) });
      await expect(h.call({ command: "x" })).rejects.toThrow(LOST_TEXT);
      expect(h.resets).toHaveLength(0);
    }
    const timedOut = harness({ run: async () => err(new ExecutionError("timeout", "timeout")) });
    await expect(timedOut.call({ command: "x", timeout: 1 })).rejects.toThrow("Command timed out after 1 seconds");
  });

  it("answers an unavailable sandbox with an error result, not a throw", async () => {
    const h = harness({
      ready: async () => {
        throw new Error(UNAVAILABLE);
      },
    });
    const r = await h.call({ command: "x" });
    expect(r).toMatchObject({ isError: true, output: [{ type: "text", text: UNAVAILABLE }] });
    expect(h.calls).toHaveLength(0);
  });
});

describe("texts", () => {
  it("word the approved network approval and the blocks the way the model is told to act on", () => {
    expect(
      approvedText(3, {
        tool: "network",
        args_json: JSON.stringify({ host: "example.com", port: 443, command: "curl -s https://example.com" }),
      }),
    ).toBe(
      "[Approval #3 approved] Network access to example.com is allowed now. Run the command that needed it again, then carry on with what you were doing before the approval. If that call was the whole request, tell the user in one short sentence how it went. If it fails, work around the failure within the rules instead of stopping: curl -s https://example.com",
    );
    expect(approvedText(1, { tool: "demo_add_todo", args_json: '{"text":"a"}' })).toBe(
      '[Approval #1 approved] Make exactly this call again now, then carry on with what you were doing before the approval. If that call was the whole request, tell the user in one short sentence how it went. If it fails, work around the failure within the rules instead of stopping: demo_add_todo {"text":"a"}',
    );
    expect(approvedText(2, { tool: "network", args_json: "not json" })).toContain("Make exactly this call again now");
    // The faux model replays the call named after the colon, so the wording before it must not contain one.
    expect(
      parseApprovalInput(
        approvedText(3, {
          tool: "network",
          args_json: JSON.stringify({ host: "example.com", command: "curl -s a:b" }),
        }),
      ),
    ).toEqual({ name: "bash", args: { command: "curl -s a:b" } });
    expect(parseApprovalInput(approvedText(1, { tool: "demo_add_todo", args_json: '{"text":"a"}' }))).toEqual({
      name: "demo_add_todo",
      args: { text: "a" },
    });
    expect(blockNote({ host: "a.example", reason: "Only ports 80 and 443 are allowed." })).toBe(
      "[Network access to a.example is not allowed: Only ports 80 and 443 are allowed. Do not retry or work around it.]",
    );
  });
});

describe("browser idle setting", () => {
  const env = (extra: Record<string, string>) => ({
    REI_BROWSER: "cdp",
    REI_BROWSER_CDP: "http://browser:9223",
    ...extra,
  });
  it("defaults to unset (the service uses 60 minutes), parses a number and accepts 0", () => {
    const base = { REI_MODEL_MODE: "faux" };
    expect(readConfig({ ...base, ...env({}) }).control.browser.idleMs).toBeUndefined();
    expect(readConfig({ ...base, ...env({ REI_BROWSER_IDLE_MS: "120000" }) }).control.browser.idleMs).toBe(120000);
    expect(readConfig({ ...base, ...env({ REI_BROWSER_IDLE_MS: "0" }) }).control.browser.idleMs).toBe(0);
    for (const bad of ["-1", "soon", "1.5"])
      expect(() => readConfig({ ...base, ...env({ REI_BROWSER_IDLE_MS: bad }) })).toThrow(/REI_BROWSER_IDLE_MS/);
  });
});
