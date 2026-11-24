// The exec container over ssh (pi-env's RemoteExecutionEnv), following "what the adapter must do".
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { type Connection, RemoteExecutionEnv, type SshConnectOptions, sshConnection } from "@earendil-works/pi-env";
import { checkTreeId, type ExecBackend, PREPARE_FAILED, UNAVAILABLE } from "../exec/backend.ts";
import type { Logger } from "../util/log.ts";

const HOST_KEY_ALIAS = "rei-exec";
const SSH_USER = "agent";
const WORKSPACE = "/workspace";

/**
 * The known_hosts line for the exec container, from its host public key as the key volume holds it (`ssh-ed25519 AAAA… comment`).
 * ssh looks the key up under the HostKeyAlias, so the line starts with that, not with host and port. The key is never scanned.
 */
export function knownHostsLine(publicKey: string, alias: string = HOST_KEY_ALIAS): string {
  const [type, key] = publicKey.trim().split(/\s+/);
  if (!type || !key || !/^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+)$/.test(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(key))
    throw new Error("The exec host public key is not a valid ssh public key.");
  return `${alias} ${type} ${key}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ReconnectOptions {
  /** How long one TCP probe waits (default 1.5 s). */
  probeMs?: number;
  /** How long `reachable` keeps probing before it gives up (default 5 s). */
  waitMs?: number;
  intervalMs?: number;
}

/**
 * One lazy pi-env Connection per exec container, replaceable. pi-env starts its daemon again by itself after a loss, so what
 * this adds is the S5 findings: a TCP check of the ssh port first (a dead container otherwise costs 35 to 39 s per call),
 * and a way to throw away a connection that went stale (`close()` is terminal for a Connection, so recovery is a new one).
 */
export class ReconnectingConnection {
  #current: Connection;
  readonly #make: () => Connection;
  readonly #endpoint: { host: string; port: number };
  readonly #o: Required<ReconnectOptions>;
  resets = 0;

  constructor(make: () => Connection, endpoint: { host: string; port: number }, options: ReconnectOptions = {}) {
    this.#make = make;
    this.#endpoint = endpoint;
    this.#o = {
      probeMs: options.probeMs ?? 1_500,
      waitMs: options.waitMs ?? 5_000,
      intervalMs: options.intervalMs ?? 250,
    };
    this.#current = make();
  }

  /** The connection to hand to `RemoteExecutionEnv` (build the env per use). */
  get connection(): Connection {
    return this.#current;
  }

  /** Whether something accepts TCP connections on the ssh port, within the probe time; the reason when not. */
  tcpProbe(): Promise<string | undefined> {
    const { host, port } = this.#endpoint;
    const timeoutMs = this.#o.probeMs;
    return new Promise((resolve) => {
      const socket = connect({ host, port });
      const done = (reason?: string) => {
        socket.destroy();
        resolve(reason);
      };
      socket.setTimeout(timeoutMs, () => done(`no answer within ${timeoutMs} ms`));
      socket.once("connect", () => done());
      socket.once("error", (error) => done(error.message));
    });
  }

  /** Drops the current connection (ending its ssh child and the commands it ran) and starts a fresh lazy one. */
  reset(): void {
    const old = this.#current;
    this.#current = this.#make();
    this.resets++;
    try {
      old.close();
    } catch {
      // already gone
    }
  }

  /** Polls the ssh port until it answers, for up to `waitMs`. The first failure resets the connection (it is stale, or soon will be). */
  async reachable(): Promise<boolean> {
    const started = Date.now();
    let first = true;
    for (;;) {
      if ((await this.tcpProbe()) === undefined) return true;
      if (first) this.reset();
      first = false;
      if (Date.now() - started >= this.#o.waitMs) return false;
      await sleep(this.#o.intervalMs);
    }
  }

  close(): void {
    this.#current.close();
  }
}

export interface SshExecOptions {
  host: string;
  port: number;
  /** Folder with `id_ed25519` and `host_ed25519_key.pub`. */
  keysDir: string;
  log: Logger;
  reconnect?: ReconnectOptions;
}

/** Runs `work`, but gives up on it after `ms`: `onExpire` runs and the call fails with `message`. */
async function within<T>(ms: number, message: string, onExpire: () => void, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onExpire();
      reject(new Error(message));
    }, ms);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

export class SshExecBackend implements ExecBackend {
  readonly mode = "ssh";
  /** The file with the one trusted host key line (under $TMPDIR). */
  readonly knownHostsFile: string;
  readonly #conn: ReconnectingConnection;
  readonly #log: Logger;
  /** Trees whose workspace folder was made in this process. */
  readonly #made = new Set<string>();

  constructor(options: SshExecOptions) {
    // The host key comes from the key volume and is written as the only trusted line; the file lives under $TMPDIR.
    const dir = mkdtempSync(join(tmpdir(), "rei-ssh-"));
    const knownHostsFile = join(dir, "known_hosts");
    this.knownHostsFile = knownHostsFile;
    writeFileSync(
      knownHostsFile,
      `${knownHostsLine(readFileSync(join(options.keysDir, "host_ed25519_key.pub"), "utf8"))}\n`,
      { mode: 0o600 },
    );
    const target: SshConnectOptions = {
      host: options.host,
      port: options.port,
      user: SSH_USER,
      identityFile: join(options.keysDir, "id_ed25519"),
      knownHostsFile,
      hostKeyAlias: HOST_KEY_ALIAS,
    };
    this.#log = options.log;
    this.#conn = new ReconnectingConnection(
      () => sshConnection(target).connection,
      { host: options.host, port: options.port },
      options.reconnect,
    );
  }

  cwd(treeId: string): string {
    return `${WORKSPACE}/${checkTreeId(treeId)}`;
  }

  env(treeId: string): ExecutionEnv {
    return new RemoteExecutionEnv({
      connection: this.#conn.connection,
      id: `exec:${checkTreeId(treeId)}`,
      cwd: this.cwd(treeId),
    });
  }

  async ready(treeId: string): Promise<void> {
    if (!(await this.#conn.reachable())) {
      this.#made.clear();
      throw new Error(UNAVAILABLE);
    }
    if (this.#made.has(treeId)) return;
    const env = this.env(treeId);
    const made = await within(
      20_000,
      UNAVAILABLE,
      () => this.#conn.reset(),
      env.createDir(this.cwd(treeId), { recursive: true }, BACKGROUND_CONTEXT),
    );
    if (!made.ok) {
      this.#log.warn("workspace.prepare_failed", { treeId, code: made.error.code });
      throw new Error(PREPARE_FAILED);
    }
    this.#made.add(treeId);
  }

  reset(): void {
    this.#conn.reset();
  }

  async purge(treeId: string): Promise<void> {
    if (!(await this.#conn.reachable())) throw new Error(UNAVAILABLE);
    const removed = await within(
      60_000,
      UNAVAILABLE,
      () => this.#conn.reset(),
      this.env(treeId).remove(this.cwd(treeId), { recursive: true, force: true }, BACKGROUND_CONTEXT),
    );
    if (!removed.ok) throw new Error(`remove failed: ${removed.error.code}`);
    this.#made.delete(treeId);
  }

  async close(): Promise<void> {
    this.#conn.close();
  }
}
