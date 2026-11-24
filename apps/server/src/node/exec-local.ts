// Faux mode and tests: Pi Durable's Node execution env on a folder of this machine. No network isolation at all.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { checkTreeId, type ExecBackend } from "../exec/backend.ts";

export class LocalExecBackend implements ExecBackend {
  readonly mode = "local";
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  cwd(treeId: string): string {
    return join(this.root, checkTreeId(treeId));
  }
  env(treeId: string): ExecutionEnv {
    return new NodeExecutionEnv({ cwd: this.cwd(treeId) });
  }
  async ready(treeId: string): Promise<void> {
    mkdirSync(this.cwd(treeId), { recursive: true });
  }
  reset(): void {}
  async purge(treeId: string): Promise<void> {
    rmSync(this.cwd(treeId), { recursive: true, force: true });
  }
  async close(): Promise<void> {}
}
