import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { BrowserDriver } from "../../src/browser/driver.ts";
import type { ControlPlaneConfig } from "../../src/control-plane.ts";
import { LocalExecBackend } from "../../src/node/exec-local.ts";
import { tool } from "./approvals.ts";
import { startTestServer, type TestServer } from "./server.ts";
import { chat, detail, say, settled } from "./sessions.ts";

export const PROXY = "egress:3128";
const ASK = fileURLToPath(new URL("./egress-ask.mjs", import.meta.url));

export type ExecServer = TestServer & { totpSecret: string; root: string; socket: string; spy: SpyBackend };

/** A signed-in faux server whose sandbox is a folder (exec mode `local`), with the egress decide socket. */
export async function startExecServer(
  options: {
    browserDriver?: BrowserDriver;
    proxy?: string | false;
    socket?: boolean;
    config?: Partial<ControlPlaneConfig>;
    dir?: string;
    cookie?: string;
  } = {},
): Promise<ExecServer> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "rei-exec-"));
  const root = join(dir, "workspaces");
  const socketDir = mkdtempSync(join(tmpdir(), "e-"));
  const socket = join(socketDir, "decide.sock");
  const exec: ControlPlaneConfig["exec"] = {
    mode: "local",
    root,
    ...(options.socket === false ? {} : { egressSocket: socket }),
    ...(options.proxy === false ? {} : { egressProxy: options.proxy ?? PROXY }),
  };
  const spy = new SpyBackend(root);
  const server = Object.assign(
    await startTestServer({
      dir,
      config: { exec, ...options.config },
      exec: spy,
      ...(options.browserDriver ? { browserDriver: options.browserDriver } : {}),
    }),
    { totpSecret: "" },
  );
  if (options.cookie === undefined) server.totpSecret = (await server.createAccount()).totpSecret;
  else server.client.cookie = options.cookie;
  const destroy = server.destroy;
  server.destroy = async () => {
    await destroy();
    rmSync(socketDir, { recursive: true, force: true });
  };
  return Object.assign(server, { root, socket, spy });
}

/** The bash call that asks the decide socket about a destination, as the proxy would. */
export const askCommand = (socket: string, host: string, port = 443): string =>
  `"${process.execPath}" "${ASK}" "${socket}" ${host} ${port}`;
export const bash = (command: string, timeout?: number): string =>
  tool("bash", { command, ...(timeout !== undefined ? { timeout } : {}) });

/** One request to the decide socket. */
export function postSocket(
  socket: string,
  body: string,
  path = "/egress/decide",
  method = "POST",
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        path,
        method,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** The local backend with hooks: what `exec` was called with, and failures on demand. */
export class SpyBackend extends LocalExecBackend {
  execCalls: { command: unknown; timeout: number | undefined; env: Record<string, string> | undefined }[] = [];
  purgeFailures = 0;
  purges: string[] = [];
  readyError: Error | undefined;
  envError: Error | undefined;
  override env(treeId: string): ExecutionEnv {
    if (this.envError) throw this.envError;
    const real = new NodeExecutionEnv({ cwd: this.cwd(treeId) });
    const calls = this.execCalls;
    const exec = real.exec.bind(real);
    real.exec = (command, options, context) => {
      if (options?.env?.GIT_TERMINAL_PROMPT !== undefined)
        calls.push({ command, timeout: options?.timeout, env: options?.env });
      return exec(command, options, context);
    };
    return real;
  }
  override async ready(treeId: string): Promise<void> {
    if (this.readyError) throw this.readyError;
    await super.ready(treeId);
  }
  override async purge(treeId: string): Promise<void> {
    this.purges.push(treeId);
    if (this.purgeFailures > 0) {
      this.purgeFailures--;
      throw new Error("The sandbox is not available right now.");
    }
    await super.purge(treeId);
  }
}

/** Sends a message, waits for its run to finish, and returns the session detail. */
export async function run(s: TestServer, sessionId: string, text: string) {
  const before = (await detail(s, sessionId)).runs.length;
  await say(s, sessionId, text);
  return settled(s, sessionId, before + 1);
}
export const lastAssistant = (d: { messages: { role: string; text: string }[] }): string =>
  d.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
export { chat, existsSync };
