// Runs the real entry point (src/main.ts) as a child process, so a test can kill -9 it mid-reply.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { totpCode } from "../../src/auth/totp.ts";
import { Client } from "./client.ts";
import { PASSWORD, STANDIN } from "./server.ts";

const MAIN = fileURLToPath(new URL("../../src/main.ts", import.meta.url));

export interface Child {
  proc: ChildProcess;
  port: number;
  client: Client;
  logs: string[];
  /** SIGKILL, and wait until the process is gone. */
  kill(): Promise<void>;
  /** SIGTERM, wait for a clean exit. */
  stop(): Promise<number | null>;
}

export async function startChild(dir: string, env: Record<string, string> = {}): Promise<Child> {
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
    env: {
      PATH: process.env.PATH ?? "",
      REI_DATA: dir,
      REI_PORT: "0",
      REI_HOST: "127.0.0.1",
      REI_MODEL_MODE: "faux",
      REI_STANDIN_FILE: join(dir, "standin.txt"),
      REI_COMMIT_MS: "100",
      REI_RETRY_MAX: "0",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not start: ${logs.join("\n")}`)), 20_000);
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        logs.push(line);
        const m = /"event":"server.listening".*"port":(\d+)/.exec(line);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`child exited early (${code}): ${logs.join("\n")}`)));
  });
  // Keep collecting after startup.
  let tail = "";
  const more = (chunk: Buffer) => {
    tail += chunk.toString("utf8");
    let nl: number;
    while ((nl = tail.indexOf("\n")) >= 0) {
      logs.push(tail.slice(0, nl));
      tail = tail.slice(nl + 1);
    }
  };
  proc.stdout!.on("data", more);
  proc.stderr!.on("data", more);
  const client = new Client((path, init) => fetch(`http://127.0.0.1:${port}${path}`, init));
  const exited = new Promise<number | null>((r) => proc.once("exit", (code) => r(code)));
  return {
    proc,
    port,
    client,
    logs,
    async kill() {
      proc.kill("SIGKILL");
      await exited;
    },
    async stop() {
      proc.kill("SIGTERM");
      return exited;
    },
  };
}

/** Creates the account in a child that has none; leaves the client signed in. */
export async function setUpAccount(child: Child, dir: string): Promise<{ totpSecret: string }> {
  const setupCode = readFileSync(join(dir, "setup-code.txt"), "utf8").trim();
  const start = await child.client.post("/api/auth/setup", { setupCode, password: PASSWORD });
  if (start.status !== 200) throw new Error(`setup failed: ${JSON.stringify(start.body)}`);
  const enrol = await child.client.post("/api/auth/totp/start", { password: PASSWORD });
  const totpSecret = enrol.body.totpSecret as string;
  const confirm = await child.client.post("/api/auth/totp/confirm", {
    password: PASSWORD,
    totpCode: await totpCode(totpSecret, Date.now()),
  });
  if (confirm.status !== 200) throw new Error(`confirm failed: ${JSON.stringify(confirm.body)}`);
  return { totpSecret };
}

export { STANDIN };
