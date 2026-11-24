// File-backed SecretStore: one JSON file `{ "<key>": value }` (connectors with their tokens and the VAPID pair), mode
// 0600 in the 0700 secret directory. Same write discipline as credstore.ts: temp file, fsync, rename. Only
// the gateway process writes it, so a promise chain is enough to serialize read-modify-write (no lock file).
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { SecretStore } from "../core/secrets.ts";
import { ensureSecretDir } from "./credstore.ts";

export class FileSecretStore implements SecretStore {
  readonly file: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
    ensureSecretDir(dirname(file));
  }

  #load(): Record<string, unknown> {
    if (!existsSync(this.file)) return {};
    return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
  }

  #save(data: Record<string, unknown>): void {
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
    const dirFd = openSync(dirname(this.file), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  async read<T>(key: string): Promise<T | undefined> {
    await this.#chain.catch(() => {});
    return this.#load()[key] as T | undefined;
  }

  modify<T>(key: string, fn: (current: T | undefined) => T | undefined): Promise<T | undefined> {
    const run = this.#chain
      .catch(() => {})
      .then(() => {
        const data = this.#load();
        const next = fn(data[key] as T | undefined);
        if (next === data[key]) return next;
        if (next === undefined) delete data[key];
        else data[key] = next;
        this.#save(data);
        return next;
      });
    this.#chain = run.catch(() => {});
    return run;
  }
}
