// File-backed pi-ai CredentialStore. One JSON file `{ "<providerId>": Credential }`, mode 0600, in a 0700 directory.
// Writes go to a temp file that is fsynced and renamed over the target. `modify` is serialized inside the process by a
// promise chain and across processes (gateway and CLI) by an exclusive lock file.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function ensureSecretDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export interface WriteEvent {
  previous: Credential | undefined;
  next: Credential;
}

export class FileCredentialStore implements CredentialStore {
  readonly file: string;
  /** Called after every successful write (login, refresh). */
  onWrite: ((event: WriteEvent) => void) | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  #cache: { key: string; data: Record<string, Credential> } | undefined;

  constructor(file: string) {
    this.file = file;
    ensureSecretDir(dirname(file));
  }

  #load(): Record<string, Credential> {
    if (!existsSync(this.file)) {
      this.#cache = undefined;
      return {};
    }
    const st = statSync(this.file);
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (this.#cache?.key === key) return this.#cache.data;
    const data = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Credential>;
    this.#cache = { key, data };
    return data;
  }

  #save(data: Record<string, Credential>): void {
    const tmp = `${this.file}.tmp.${process.pid}`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(data));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.#cache = undefined;
    // Make the rename itself durable.
    const dirFd = openSync(dirname(this.file), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  async #withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        closeSync(openSync(lock, "wx", 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 60_000) unlinkSync(lock); // left by a process that died
        } catch {
          // someone else removed it
        }
        if (Date.now() > deadline) throw new Error("credential lock timeout");
        await sleep(20);
      }
    }
    try {
      return await fn();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        // already gone
      }
    }
  }

  #enqueue<T>(task: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    const run = this.#chain
      .catch(() => {})
      .then(() => {
        options?.signal?.throwIfAborted();
        return task();
      });
    this.#chain = run.catch(() => {});
    return run;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return this.#load()[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(this.#load()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#enqueue(
      () =>
        this.#withFileLock(async () => {
          // Re-read inside the lock: another process may have refreshed meanwhile.
          const data = { ...this.#load() };
          const current = data[providerId];
          const next = await fn(current);
          options?.signal?.throwIfAborted();
          if (next === undefined) return current;
          data[providerId] = next;
          this.#save(data);
          this.onWrite?.({ previous: current, next });
          return next;
        }),
      options,
    );
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.#enqueue(
      () =>
        this.#withFileLock(async () => {
          const data = { ...this.#load() };
          delete data[providerId];
          this.#save(data);
        }),
      options,
    );
  }
}

/** A stable UUID for this installation, created once. OpenAI receives it as the agent host id at login. */
export function getDeviceId(secretDir: string): string {
  ensureSecretDir(secretDir);
  const file = join(secretDir, "device-id");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const id = randomUUID();
  writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
}
