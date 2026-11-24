import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { PrivateSnapshots } from "../pi/private-execution.ts";

/** Each backup has a hard worker lifetime; termination closes SQLite before directory removal. */
export class NodePrivateSnapshots implements PrivateSnapshots {
  readonly root: string;
  readonly trees: string;
  readonly limits: { maxBytes: number; timeoutMs: number };
  constructor(dataDir: string, limits = { maxBytes: 256 * 1024 * 1024, timeoutMs: 30_000 }) {
    this.root = join(dataDir, "background-private");
    this.trees = join(dataDir, "trees");
    this.limits = limits;
  }
  async sweep(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.root)) await rm(join(this.root, entry), { recursive: true, force: true });
  }
  async create(treeId: string, id: string, signal: AbortSignal): Promise<{ path: string; dispose(): Promise<void> }> {
    if (!/^[\w-]+$/.test(treeId) || !/^[\w-]+$/.test(id)) throw new Error("INVALID_SNAPSHOT_ID");
    signal.throwIfAborted();
    const dir = join(this.root, id);
    await mkdir(dir, { recursive: false, mode: 0o700 });
    const path = join(dir, "pi.sqlite");
    const dispose = () => rm(dir, { recursive: true, force: true });
    let worker: Worker;
    try {
      worker = new Worker(
        `
      const {workerData,parentPort}=require('node:worker_threads');
      const {DatabaseSync,backup}=require('node:sqlite');
      (async()=>{const db=new DatabaseSync(workerData.source,{readOnly:true});
        try { const count=db.prepare('PRAGMA page_count').get().page_count;
          const size=db.prepare('PRAGMA page_size').get().page_size;
          if(count*size>workerData.maxBytes) throw new Error('SNAPSHOT_SIZE_LIMIT');
          await backup(db,workerData.path,{rate:64,progress(p){if(p.totalPages*size>workerData.maxBytes) parentPort.postMessage('SNAPSHOT_SIZE_LIMIT');}});
          parentPort.postMessage('done');
        } finally { db.close(); }
      })().catch(error=>parentPort.postMessage(error.message==='SNAPSHOT_SIZE_LIMIT'?'SNAPSHOT_SIZE_LIMIT':'SNAPSHOT_FAILED'));
    `,
        {
          eval: true,
          execArgv: process.execArgv.filter(
            (arg, index, args) => !arg.startsWith("--input-type") && args[index - 1] !== "--input-type",
          ),
          workerData: { source: join(this.trees, treeId, "pi.sqlite"), path, maxBytes: this.limits.maxBytes },
        },
      );
    } catch (error) {
      await dispose();
      throw error;
    }
    let abort: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => reject(new Error("SNAPSHOT_CANCELLED"));
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new Error("SNAPSHOT_TIMEOUT")), this.limits.timeoutMs);
        worker.on("message", (message) => (message === "done" ? resolve() : reject(new Error(String(message)))));
        worker.on("error", () => reject(new Error("SNAPSHOT_FAILED")));
        worker.on("exit", (code) => {
          if (code !== 0) reject(new Error("SNAPSHOT_FAILED"));
        });
        if (signal.aborted) abort();
      });
      await worker.terminate();
      signal.throwIfAborted();
      return { path, dispose };
    } catch (error) {
      await worker.terminate();
      await dispose();
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}
