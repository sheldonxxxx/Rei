import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { SetupCodeStore } from "../auth/service.ts";
import type { BrowserDriver } from "../browser/driver.ts";
import { type ControlPlane, type ControlPlaneDeps, createControlPlane, type WebHostOptions } from "../control-plane.ts";
import { parseEventsKey } from "../events/sources.ts";
import type { ExecBackend } from "../exec/backend.ts";
import type { WebAssets } from "../http/assets.ts";
import { DEFAULT_MODELS_JSON, type ModelsConfig, type ModelsConfigSource } from "../pi/model-config.ts";
import type { StandinSource } from "../pi/models.ts";
import type { RetrievalStore } from "../retrieval/retrieval-store.ts";
import type { FileObjectStore } from "../storage/file-object-store.ts";
import { type Clock, systemClock } from "../util/clock.ts";
import { createLogger, type Logger } from "../util/log.ts";
import { BundleWriter } from "./backup-bundle.ts";
import { backupFolder } from "./backup-folder.ts";
import { FolderBlobStore } from "./blob-store.ts";
import { CdpBrowserDriver } from "./browser-cdp.ts";
import { CodexImages } from "./codex-images.ts";
import { checkExecConfig, embedderKeySource, type NodeConfig } from "./config.ts";
import { EgressSocketListener } from "./egress-socket.ts";
import { LocalExecBackend } from "./exec-local.ts";
import { SshExecBackend } from "./exec-ssh.ts";
import { FolderFileObjectStore } from "./folder-object-store.ts";
import { GarageFileObjectStore } from "./garage-object-store.ts";
import { openPiStorage } from "./pi-storage.ts";
import { NodePrivateSnapshots } from "./private-snapshots.ts";
import { QdrantStore } from "./qdrant-store.ts";
import { ProcessRestic } from "./restic.ts";
import { openSqliteDb } from "./sqlite-db.ts";
import { NodeTreeFiles } from "./tree-files.ts";
import { FolderUploadSpool } from "./upload-spool.ts";
import { createWebAuthnEngine } from "./webauthn.ts";

/** The setup code as a 0600 file in the data folder. */
export class FileSetupCodeStore implements SetupCodeStore {
  readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, "setup-code.txt");
  }
  read(): string | undefined {
    try {
      return readFileSync(this.path, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }
  write(code: string): void {
    writeFileSync(this.path, `${code}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
  remove(): void {
    rmSync(this.path, { force: true });
  }
}

/** `${REI_DATA}/models.json`; created with the defaults when missing so there is a file to edit. */
export class FileModelsConfig implements ModelsConfigSource {
  readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, "models.json");
    if (!existsSync(this.path))
      writeFileSync(this.path, `${JSON.stringify(DEFAULT_MODELS_JSON, null, 2)}\n`, { mode: 0o644 });
  }
  async read(): Promise<unknown> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return undefined; // missing or broken: defaults apply
    }
  }
  write(value: ModelsConfig): void {
    const temporary = `${this.path}.tmp`;
    const fileValue = {
      fast: { model: value.fast.model, ...value.fast.deadlines },
      standard: { model: value.standard.model, ...value.standard.deadlines },
      // Only the user's own limits are written; detected and built-in values are never copied into the file.
      ...(Object.keys(value.overrides).length > 0 ? { models: value.overrides } : {}),
    };
    writeFileSync(temporary, `${JSON.stringify(fileValue, null, 2)}\n`, { mode: 0o644 });
    chmodSync(temporary, 0o644);
    renameSync(temporary, this.path);
  }
}

/** The stand-in token as the deployment hands it over: a value in the environment (secrets.env). */
export class StaticStandin implements StandinSource {
  readonly #token: string | undefined;
  constructor(token: string | undefined) {
    this.#token = token?.trim() || undefined;
  }
  async read(): Promise<string | undefined> {
    return this.#token;
  }
}

export class FileStandin implements StandinSource {
  readonly path: string | undefined;
  constructor(path: string | undefined) {
    this.path = path;
  }
  async read(): Promise<string | undefined> {
    if (!this.path) return undefined;
    try {
      return readFileSync(this.path, "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".bcmap": "application/octet-stream",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** The PWA from a folder (read per request; the files are small and the OS caches them). */
export class FolderWebAssets implements WebAssets {
  readonly root: string;
  constructor(root: string) {
    this.root = normalize(root);
  }
  async get(path: string) {
    const full = normalize(join(this.root, path));
    if (full !== this.root && !full.startsWith(this.root + sep)) return undefined;
    try {
      if (!statSync(full).isFile()) return undefined;
      const bytes = new Uint8Array(readFileSync(full)) as Uint8Array<ArrayBuffer>;
      return { bytes, contentType: MIME[extname(full).toLowerCase()] ?? "application/octet-stream" };
    } catch {
      return undefined;
    }
  }
}

/** The key file of a remote embedder endpoint, read each time (it may be rotated); an unreadable or empty file means no key. */
async function readKeyFile(path: string): Promise<string | undefined> {
  try {
    const key = readFileSync(path, "utf8").trim();
    return key === "" ? undefined : key;
  } catch {
    return undefined;
  }
}

export interface NodeHost {
  plane: ControlPlane;
  log: Logger;
  closeDb(): void;
}

/** Wires the control plane to the file system and SQLite under `config.dataDir`. */
export interface NodeHostOptions {
  write?: (line: string) => void;
  announce?: (line: string) => void;
  /** Tests: a clock they can move (to leave a TOTP step, for example). */
  clock?: Clock;
  /** Tests: the fetch the gateway client uses. */
  fetchImpl?: typeof fetch;
  /** Tests: the execution backend, instead of the one the config asks for. */
  exec?: ExecBackend;
  /** Tests: the browser driver, instead of the one the config asks for. */
  browserDriver?: BrowserDriver;
  /** Tests: the web tools' outside connections instead of the real ones (the /search and /read base URL, a shorter read deadline). */
  web?: WebHostOptions;
  /** Tests: the gateway address MCP connectors use (faux mode has no gateway). */
  mcp?: ControlPlaneDeps["mcp"];
  /** Tests: the embedder's fetch (and the indexer's timers) instead of the real ones. */
  memory?: ControlPlaneDeps["memory"];
  /** Tests: the file store, instead of the one the config asks for (a fake that can be made to fail mid-upload). */
  fileObjects?: FileObjectStore;
  /** Tests: backup settings over the config's (a folder to back up to, a fake restic, a faster tick). */
  backup?: Partial<NonNullable<ControlPlaneDeps["backup"]>>;
  /** Tests: the search service (a fake), instead of the one `config.qdrant` asks for. */
  retrieval?: RetrievalStore;
}

export async function createNodeHost(config: NodeConfig, options: NodeHostOptions = {}): Promise<NodeHost> {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const log = createLogger(write, undefined, config.logLevel);
  const db = openSqliteDb(join(config.dataDir, "app.sqlite"));
  const exec = options.exec ?? createExecBackend(config, log);
  const browserDriver =
    options.browserDriver ??
    (config.control.browser.mode === "cdp"
      ? new CdpBrowserDriver({ endpoint: config.control.browser.cdpUrl!, log })
      : undefined);
  const standin: StandinSource = config.standinToken
    ? new StaticStandin(config.standinToken)
    : new FileStandin(config.standinFile);
  const eventsKey = parseEventsKey(config.eventsKey);
  const embedderKey = embedderKeySource(config.control.embedder, config.control.gatewayUrl);
  // Two stores, deliberately apart (M11): file bytes go to the object store (Garage, or a folder in faux mode), while
  // trace payloads stay as content-addressed local blobs so redaction can keep rewriting them in place.
  const retrieval = options.retrieval ?? (config.qdrant ? new QdrantStore(config.qdrant) : undefined);
  const fileObjects =
    options.fileObjects ??
    (config.garage
      ? new GarageFileObjectStore(config.garage)
      : new FolderFileObjectStore(join(config.dataDir, "files")));
  const plane = await createControlPlane({
    db,
    traceBlobs: new FolderBlobStore(join(config.dataDir, "blobs")),
    fileObjects,
    // On the data volume, not /tmp: in the stack /tmp is a small tmpfs, and a staged upload may be 1 GiB.
    uploadSpool: new FolderUploadSpool(join(config.dataDir, "uploads")),
    webauthn: createWebAuthnEngine(),
    ...(retrieval ? { retrieval } : {}),
    treeFiles: new NodeTreeFiles(config.dataDir),
    openPiStorage,
    privateSnapshots: new NodePrivateSnapshots(config.dataDir),
    clock: options.clock ?? systemClock,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    log,
    setupCodes: new FileSetupCodeStore(config.dataDir),
    modelsConfig: new FileModelsConfig(config.dataDir),
    standin,
    ...(eventsKey ? { eventsKey } : {}),
    web: new FolderWebAssets(config.webDist),
    announceSetupCode: (code) =>
      (options.announce ?? ((line: string) => process.stdout.write(`${line}\n`)))(
        `Rei setup code: ${code}  (also in ${join(config.dataDir, "setup-code.txt")})`,
      ),
    config: config.control,
    backup: {
      repositoryDir: config.backup.repositoryDir,
      stagingDir: config.backup.stagingDir,
      dataDir: config.dataDir,
      appVersion: config.backup.version,
      restic: (options) => new ProcessRestic(options),
      bundle: (deps) => new BundleWriter(deps),
      folder: backupFolder,
      ...options.backup,
    },
    ...(config.codexImageGateway
      ? { images: new CodexImages(config.codexImageGateway, () => standin.read(), options.fetchImpl) }
      : {}),
    webTools: { ...options.web },
    ...(options.mcp ? { mcp: options.mcp } : {}),
    memory: {
      ...(embedderKey
        ? { readKey: () => ("file" in embedderKey ? readKeyFile(embedderKey.file) : standin.read()) }
        : {}),
      ...options.memory,
    },
    ...(browserDriver ? { browserDriver } : {}),
    ...(exec ? { exec } : {}),
    ...(exec && config.control.exec.egressSocket
      ? { egressListener: new EgressSocketListener(config.control.exec.egressSocket, log) }
      : {}),
  });
  return { plane, log, closeDb: () => db.close() };
}

/** The backend the config asks for: the exec container over ssh, or (faux mode only) a folder of this machine. */
export function createExecBackend(config: NodeConfig, log: Logger): ExecBackend | undefined {
  const exec = config.control.exec;
  checkExecConfig(config.control.mode, exec);
  if (exec.mode === "ssh")
    return new SshExecBackend({ host: exec.host!, port: exec.port ?? 2222, keysDir: exec.keysDir!, log });
  if (exec.mode === "local") return new LocalExecBackend(exec.root ?? join(config.dataDir, "workspaces"));
  return undefined;
}
