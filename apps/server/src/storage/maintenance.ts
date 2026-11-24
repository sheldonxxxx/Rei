// The background half of the object store: deletes the objects SQLite has already decided are unowned, and takes a look
// at objects nothing owns any more. Everything here is safe to run twice and safe to interrupt — the ledger in
// src/storage/registry.ts is what makes that true, so a failed pass costs a retry, not a file.

import type { Logger } from "../util/log.ts";
import type { FileObjectStore } from "./file-object-store.ts";
import { StorageError } from "./file-object-store.ts";
import type { ObjectRegistry } from "./registry.ts";
import { ORPHAN_GRACE_MS } from "./registry.ts";

export interface StorageMaintenanceDeps {
  registry: ObjectRegistry;
  objects: FileObjectStore;
  log: Logger;
}

export interface DrainResult {
  attempted: number;
  deleted: number;
  requeued: number;
}

export class StorageMaintenance {
  readonly #registry: ObjectRegistry;
  readonly #objects: FileObjectStore;
  readonly #log: Logger;
  #draining: Promise<DrainResult> | undefined;

  constructor(deps: StorageMaintenanceDeps) {
    this.#registry = deps.registry;
    this.#objects = deps.objects;
    this.#log = deps.log;
  }

  /** Delete what the ledger says is due. One pass at a time (a second one would race the first for the same objects). */
  drain(limit = 100): Promise<DrainResult> {
    if (!this.#draining)
      this.#draining = this.#drain(limit).finally(() => {
        this.#draining = undefined;
      });
    return this.#draining;
  }

  async #drain(limit: number): Promise<DrainResult> {
    this.reconcile();
    const result: DrainResult = { attempted: 0, deleted: 0, requeued: 0 };
    for (const object of this.#registry.due(limit)) {
      if (!this.#registry.claim(object.id)) continue;
      result.attempted++;
      try {
        await this.#objects.delete(object.object_key);
        this.#registry.markDeleted(object.id);
        result.deleted++;
      } catch (error) {
        // A refusal (bad key, wrong bucket) is not something to retry forever, but the object still must not be
        // reported gone: it stays in the ledger, where doctor can see it.
        const kind = error instanceof StorageError ? error.kind : "unavailable";
        this.#registry.requeue(object.id, error);
        result.requeued++;
        this.#log.warn("storage.delete_failed", { kind, attempts: object.attempts + 1 });
      }
    }
    return result;
  }

  /** Objects nobody owns after the grace period, from SQLite alone: the crash-and-restart cleanup. */
  reconcile(graceMs = ORPHAN_GRACE_MS): number {
    const reclaimed = this.#registry.reclaimOrphans(graceMs);
    if (reclaimed > 0) this.#log.info("storage.orphans_scheduled", { count: reclaimed });
    return reclaimed;
  }

  async settled(): Promise<void> {
    await this.#draining;
  }
}
