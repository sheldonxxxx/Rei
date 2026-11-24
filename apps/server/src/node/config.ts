import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type LogLevel, parseLogLevel } from "@rei/logging";
import { type BrowserConfig, type ControlPlaneConfig, DEFAULT_CONFIG, type ExecConfig } from "../control-plane.ts";
import { type EmbedderConfig, embeddingBase, MODEL_PROFILES, validateProfile } from "../memory/embedder.ts";
import { BUCKET_PATTERN, type GarageConfig } from "../node/garage-object-store.ts";
import type { QdrantConfig } from "../node/qdrant-store.ts";

export interface NodeConfig {
  /** REI_LOG_LEVEL: the lowest service-log level written (default info). */
  logLevel: LogLevel;
  dataDir: string;
  port: number;
  host: string;
  webDist: string;
  /** The stand-in token the control plane presents to the gateway: REI_STANDIN (from secrets.env), or the file REI_STANDIN_FILE names. */
  standinToken?: string | undefined;
  standinFile: string | undefined;
  codexImageGateway?: string;
  /** REI_EVENTS_KEY: 64 hex characters, the key event sources' secrets are encrypted with (absent: events are not accepted). */
  eventsKey?: string | undefined;
  /** The object store that holds file bytes. Absent only in faux mode, where the folder store stands in (see readStorage). */
  garage: GarageConfig | undefined;
  /** The retrieval service (BM25 + dense vectors). Absent only in faux mode. */
  qdrant: QdrantConfig | undefined;
  control: ControlPlaneConfig;
}

function int(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative safe integer`);
  return n;
}

/** Like `int`, but zero is not allowed: a limit of nothing would refuse every script. */
function positive(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const n = int(env, name);
  if (n === 0) throw new Error(`${name} must be a positive safe integer`);
  return n;
}

function port(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const value = int(env, name) ?? fallback;
  if (value < min || value > 65535) throw new Error(`${name} must be between ${min} and 65535`);
  return value;
}

const text = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
};

/** Refuses an execution setup that must not run: `local` has no network isolation, so it is for the faux model only. */
export function checkExecConfig(mode: ControlPlaneConfig["mode"], exec: ExecConfig): void {
  if (exec.mode === "local" && mode !== "faux")
    throw new Error(
      "REI_EXEC=local runs commands on this machine with no isolation; it is only allowed with REI_MODEL_MODE=faux",
    );
  if (exec.mode === "ssh" && (!exec.host || !exec.keysDir))
    throw new Error("REI_EXEC=ssh needs REI_EXEC_HOST and REI_EXEC_KEYS");
}

function readExec(env: NodeJS.ProcessEnv, mode: ControlPlaneConfig["mode"]): ExecConfig {
  const raw = text(env, "REI_EXEC") ?? "off";
  if (raw !== "off" && raw !== "ssh" && raw !== "local")
    throw new Error("REI_EXEC must be 'off' (default), 'ssh' or 'local' (faux mode only)");
  const host = text(env, "REI_EXEC_HOST");
  const keysDir = text(env, "REI_EXEC_KEYS");
  const root = text(env, "REI_EXEC_ROOT");
  const egressSocket = text(env, "REI_EGRESS_SOCKET");
  const egressProxy = text(env, "REI_EGRESS_PROXY");
  const exec: ExecConfig = {
    mode: raw,
    ...(raw === "ssh" ? { port: port(env, "REI_EXEC_PORT", 2222, 1) } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(keysDir !== undefined ? { keysDir } : {}),
    ...(root !== undefined ? { root } : {}),
    ...(egressSocket !== undefined ? { egressSocket } : {}),
    ...(egressProxy !== undefined ? { egressProxy } : {}),
  };
  checkExecConfig(mode, exec);
  return exec;
}

function readBrowser(env: NodeJS.ProcessEnv): BrowserConfig {
  const raw = text(env, "REI_BROWSER") ?? "off";
  if (raw !== "off" && raw !== "cdp") throw new Error("REI_BROWSER must be 'off' (default) or 'cdp'");
  if (raw === "off") return { mode: "off" };
  const cdpUrl = text(env, "REI_BROWSER_CDP");
  if (!cdpUrl) throw new Error("REI_BROWSER=cdp needs REI_BROWSER_CDP (for example http://browser:9223)");
  const maxWindows = int(env, "REI_BROWSER_WINDOWS");
  const idleMs = int(env, "REI_BROWSER_IDLE_MS");
  return {
    mode: "cdp",
    cdpUrl,
    ...(maxWindows !== undefined && maxWindows > 0 ? { maxWindows } : {}),
    ...(idleMs !== undefined ? { idleMs } : {}),
  };
}

function readEmbedder(env: NodeJS.ProcessEnv): EmbedderConfig | undefined {
  const provider = text(env, "REI_EMBEDDER_PROVIDER");
  // Existing deployments used the bundled provider. Its service and model have been removed; leave those installs
  // keyword-only until the operator chooses oMLX or a custom OpenAI-compatible endpoint in Settings.
  if (provider === "bundled") return undefined;
  if (provider === "off") return undefined;
  if (provider !== undefined && provider !== "omlx" && provider !== "openai")
    throw new Error("REI_EMBEDDER_PROVIDER must be 'omlx' or 'openai'");
  const url = text(env, "REI_EMBEDDER_URL");
  if (!url) {
    if (provider) throw new Error("REI_EMBEDDER_URL is required for a configured embedding provider");
    return undefined;
  }
  try {
    embeddingBase(url);
  } catch {
    throw new Error("REI_EMBEDDER_URL must be an HTTP(S) embedding provider URL");
  }
  if (!provider) throw new Error("REI_EMBEDDER_PROVIDER must be 'omlx' or 'openai' when REI_EMBEDDER_URL is set");
  const profile = text(env, "REI_EMBEDDER_PROFILE");
  const validated = profile ? validateProfile(JSON.parse(profile)) : undefined;
  const model =
    text(env, "REI_EMBEDDER_MODEL") ??
    validated?.id ??
    (provider === "omlx" ? "mlx-community/embeddinggemma-2-6bit" : "");
  if (!model)
    throw new Error("REI_EMBEDDER_MODEL or REI_EMBEDDER_PROFILE is required for a custom OpenAI-compatible provider");
  if (!validated && !MODEL_PROFILES[model])
    throw new Error(`REI_EMBEDDER_MODEL must be one of: ${Object.keys(MODEL_PROFILES).join(", ")}`);
  if (validated && validated.id !== model) throw new Error("REI_EMBEDDER_MODEL must match REI_EMBEDDER_PROFILE.id");
  // /run/secrets/standin was the stand-in token's Docker secret, which deployments that predate secrets.env wrote here.
  const configuredKeyFile = text(env, "REI_EMBEDDER_KEY_FILE");
  const keyFile = configuredKeyFile === LEGACY_STANDIN_FILE ? undefined : configuredKeyFile;
  const apiModel = text(env, "REI_EMBEDDER_API_MODEL");
  if (!apiModel) throw new Error("REI_EMBEDDER_API_MODEL is required");
  if (provider === "omlx" && !validated && model !== "mlx-community/embeddinggemma-2-6bit")
    throw new Error("oMLX requires its validated embedding profile");
  if (provider === "openai" && !validated)
    throw new Error("REI_EMBEDDER_PROFILE is required for a custom OpenAI-compatible provider");
  return {
    url,
    model,
    provider,
    ...(apiModel ? { apiModel } : {}),
    ...(validated ? { profile: validated } : {}),
    ...(text(env, "REI_EMBEDDER_REMOTE") !== undefined ? { remote: env.REI_EMBEDDER_REMOTE === "1" } : {}),
    ...(keyFile !== undefined ? { keyFile } : {}),
  };
}

const LEGACY_STANDIN_FILE = "/run/secrets/standin";

/**
 * Where the embedding client's bearer key comes from. A key file when one is named (a remote endpoint of its own);
 * otherwise the stand-in token, but only for an endpoint on the gateway, which is the one place that token is valid.
 * An endpoint anywhere else gets no key at all rather than the stand-in.
 */
export function embedderKeySource(
  embedder: { url: string; keyFile?: string | undefined } | undefined,
  gatewayUrl: string | undefined,
): { file: string } | { standin: true } | undefined {
  if (!embedder) return undefined;
  if (embedder.keyFile) return { file: embedder.keyFile };
  if (!gatewayUrl) return undefined;
  try {
    return new URL(embedder.url).origin === new URL(gatewayUrl).origin ? { standin: true } : undefined;
  } catch {
    return undefined;
  }
}

/** Where cleartext is acceptable: a service name on the stack's own network, or this machine. Everything else is https. */
function assertTransport(url: URL, name: string): void {
  if (url.protocol === "https:") return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const private_ =
    host === "localhost" ||
    !host.includes(".") || // a compose or k8s service name: nothing outside the network can resolve it
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".svc") ||
    /^127\./.test(host) ||
    host === "::1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^f[cd]/i.test(host);
  if (!private_)
    throw new Error(
      `${name} is cleartext to a host outside this machine's own networks (${url.href}); use https:// or a private service name.`,
    );
}

function parseUrl(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL (got "${raw}").`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`${name} must be an http(s) URL (got "${raw}").`);
  if (url.pathname !== "/" && url.pathname !== "")
    throw new Error(`${name} must not carry a path (got "${url.pathname}").`);
  assertTransport(url, name);
  return url;
}

/**
 * A secret is a file the deployment owns (a compose secret, a mounted token) or, for the storage services, the value in
 * the environment that containers/.secrets/secrets.env hands every storage-tier container. Read now, never logged.
 */
const GARAGE_ACCESS_KEY_VAR = "GARAGE_DEFAULT_ACCESS_KEY";
const GARAGE_SECRET_KEY_VAR = "GARAGE_DEFAULT_SECRET_KEY";
const QDRANT_API_KEY_VAR = "QDRANT__SERVICE__API_KEY";

type SecretSource = { kind: "file"; path: string } | { kind: "value"; value: string };

function secretSource(env: NodeJS.ProcessEnv, fileVar: string, valueVar: string): SecretSource | undefined {
  const path = text(env, fileVar);
  if (path !== undefined) return { kind: "file", path };
  const value = text(env, valueVar);
  return value !== undefined ? { kind: "value", value } : undefined;
}

function readSecret(source: SecretSource, name: string, valueVar: string): string {
  if (source.kind === "file") return readSecretFile(source.path, name);
  const value = source.value.trim();
  if (value === "") throw new Error(`${name} is empty in ${valueVar}.`);
  return value;
}

function readSecretFile(path: string, name: string): string {
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error(`${name} could not be read from ${path}. Run containers/init.sh, then redeploy.`);
  }
  if (value === "") throw new Error(`${name} is empty in ${path}.`);
  return value;
}

/**
 * Garage and Qdrant (M11). A real deployment must have both: file bytes and search indexes have somewhere to live, and
 * "no object store configured" is not a state a working install may silently fall back into. A faux-mode server (tests,
 * the offline smoke test) may run without them, on the folder store and with no search index — and so may a process
 * that says so out loud with REI_ALLOW_FOLDER_FILES, which is how the end-to-end harness runs the real control plane
 * against a fake model gateway. Compose never sets it, so an installed Rei cannot drift onto the folder by accident.
 */
function readStorage(
  env: NodeJS.ProcessEnv,
  mode: ControlPlaneConfig["mode"],
): { garage: GarageConfig | undefined; qdrant: QdrantConfig | undefined } {
  const endpoint = text(env, "REI_GARAGE_ENDPOINT");
  const bucket = text(env, "REI_GARAGE_BUCKET");
  // The keys are the ones Garage and Qdrant bootstrap from (containers/.secrets/secrets.env), or a file that holds one.
  const accessKey = secretSource(env, "REI_GARAGE_ACCESS_KEY_FILE", GARAGE_ACCESS_KEY_VAR);
  const secretKey = secretSource(env, "REI_GARAGE_SECRET_KEY_FILE", GARAGE_SECRET_KEY_VAR);
  const qdrantUrl = text(env, "REI_QDRANT_URL");
  const qdrantKey = secretSource(env, "REI_QDRANT_API_KEY_FILE", QDRANT_API_KEY_VAR);
  const values = [endpoint, bucket, accessKey, secretKey, qdrantUrl, qdrantKey];
  const set = values.filter((value) => value !== undefined).length;
  if (set === 0) {
    if (mode !== "faux" && env.REI_ALLOW_FOLDER_FILES !== "1")
      throw new Error(
        "REI_GARAGE_ENDPOINT and REI_QDRANT_URL are required: file uploads and history search need Garage and Qdrant. " +
          "Run ./rei setup (or start the stack with containers/compose.yaml); REI_MODEL_MODE=faux runs without them, " +
          "and REI_ALLOW_FOLDER_FILES=1 stores file bytes in the data folder.",
      );
    return { garage: undefined, qdrant: undefined };
  }
  if (set < 6)
    throw new Error(
      `The file store is half-configured; also set ${values
        .map((value, index) =>
          value === undefined
            ? [
                "REI_GARAGE_ENDPOINT",
                "REI_GARAGE_BUCKET",
                `REI_GARAGE_ACCESS_KEY_FILE or ${GARAGE_ACCESS_KEY_VAR}`,
                `REI_GARAGE_SECRET_KEY_FILE or ${GARAGE_SECRET_KEY_VAR}`,
                "REI_QDRANT_URL",
                `REI_QDRANT_API_KEY_FILE or ${QDRANT_API_KEY_VAR}`,
              ][index]
            : undefined,
        )
        .filter((name) => name !== undefined)
        .join(", ")} (containers/compose.yaml sets them; containers/init.sh makes containers/.secrets/secrets.env).`,
    );
  if (!BUCKET_PATTERN.test(bucket!))
    throw new Error(`REI_GARAGE_BUCKET must be 3 to 63 lowercase letters, digits and hyphens (got "${bucket}").`);
  const garageUrl = parseUrl(endpoint!, "REI_GARAGE_ENDPOINT");
  const timeoutMs = (name: string): { timeoutMs?: number } => (text(env, name) ? { timeoutMs: int(env, name) } : {});
  return {
    garage: {
      endpoint: garageUrl.origin,
      region: text(env, "REI_GARAGE_REGION") ?? "garage",
      bucket: bucket!,
      accessKeyId: readSecret(accessKey!, "The Garage access key", GARAGE_ACCESS_KEY_VAR),
      secretAccessKey: readSecret(secretKey!, "The Garage secret key", GARAGE_SECRET_KEY_VAR),
      ...timeoutMs("REI_GARAGE_TIMEOUT_MS"),
    },
    qdrant: {
      url: parseUrl(qdrantUrl!, "REI_QDRANT_URL").origin,
      apiKey: readSecret(qdrantKey!, "The Qdrant API key", QDRANT_API_KEY_VAR),
      ...timeoutMs("REI_QDRANT_TIMEOUT_MS"),
    },
  };
}

/** Reads the environment (the only place in the server that does). */ export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
): NodeConfig {
  const mode = env.REI_MODEL_MODE === "faux" ? "faux" : "gateway";
  if (
    env.REI_MODEL_MODE !== undefined &&
    env.REI_MODEL_MODE !== "" &&
    env.REI_MODEL_MODE !== "gateway" &&
    env.REI_MODEL_MODE !== "faux"
  ) {
    throw new Error("REI_MODEL_MODE must be 'gateway' (default) or 'faux' (tests only)");
  }
  const gatewayUrl = env.GATEWAY_URL?.trim();
  if (mode === "gateway" && !gatewayUrl) throw new Error("GATEWAY_URL is required (for example http://gateway:8780)");
  const retry = { ...DEFAULT_CONFIG.retry };
  const retryMax = int(env, "REI_RETRY_MAX");
  if (retryMax !== undefined) {
    retry.maxRetries = retryMax;
    retry.enabled = retryMax > 0;
  }
  retry.baseDelayMs = int(env, "REI_RETRY_BASE_MS") ?? retry.baseDelayMs;
  const fauxTps = int(env, "REI_FAUX_TPS");
  const restartLimit = int(env, "REI_RESTART_LIMIT");
  const partial = int(env, "REI_PARTIAL_MS");
  const ping = int(env, "REI_SSE_PING_MS");
  const embedder = readEmbedder(env);
  const publicUrl = text(env, "REI_PUBLIC_URL");
  const publicOrigin = publicUrl ? parseUrl(publicUrl, "REI_PUBLIC_URL").origin : undefined;
  const androidPasskeyOrigins = text(env, "REI_ANDROID_PASSKEY_ORIGINS")
    ?.split(",")
    .map((origin) => origin.trim());
  if (
    androidPasskeyOrigins &&
    (!publicOrigin?.startsWith("https://") ||
      androidPasskeyOrigins.some((origin) => !/^android:apk-key-hash:[A-Za-z0-9_-]{43}$/.test(origin)))
  ) {
    throw new Error(
      "REI_ANDROID_PASSKEY_ORIGINS needs an HTTPS REI_PUBLIC_URL and comma-separated Android signing origins.",
    );
  }
  const storage = readStorage(env, mode);
  return {
    logLevel: parseLogLevel(env.REI_LOG_LEVEL),
    dataDir: env.REI_DATA && env.REI_DATA !== "" ? env.REI_DATA : join(homedir(), "rei-data"),
    port: port(env, "REI_PORT", 8787, 0),
    host: env.REI_HOST && env.REI_HOST !== "" ? env.REI_HOST : "127.0.0.1",
    webDist:
      env.REI_WEB_DIST && env.REI_WEB_DIST !== ""
        ? env.REI_WEB_DIST
        : fileURLToPath(new URL("../../../web/dist", import.meta.url)),
    standinToken: text(env, "REI_STANDIN"),
    eventsKey: text(env, "REI_EVENTS_KEY"),
    standinFile: env.REI_STANDIN_FILE && env.REI_STANDIN_FILE !== "" ? env.REI_STANDIN_FILE : undefined,
    garage: storage.garage,
    qdrant: storage.qdrant,
    ...(gatewayUrl ? { codexImageGateway: gatewayUrl } : {}),
    control: {
      ...DEFAULT_CONFIG,
      mode,
      ...(gatewayUrl ? { gatewayUrl } : {}),
      ...(publicOrigin ? { publicUrl: publicOrigin } : {}),
      ...(androidPasskeyOrigins ? { androidPasskeyOrigins } : {}),
      cookieSecure: env.REI_COOKIE_SECURE === "1",
      fcmEnabled: env.REI_FCM_ENABLED === "1",
      idleCloseMs: int(env, "REI_IDLE_CLOSE_MS") ?? DEFAULT_CONFIG.idleCloseMs,
      commitIntervalMs: int(env, "REI_COMMIT_MS") ?? DEFAULT_CONFIG.commitIntervalMs,
      maxSessionDepth: int(env, "REI_MAX_SESSION_DEPTH") ?? DEFAULT_CONFIG.maxSessionDepth,
      maxActiveChildren: int(env, "REI_MAX_ACTIVE_CHILDREN") ?? DEFAULT_CONFIG.maxActiveChildren,
      deleteSettleMs: int(env, "REI_DELETE_SETTLE_MS") ?? DEFAULT_CONFIG.deleteSettleMs,
      approvalTtlMs: int(env, "REI_APPROVAL_TTL_MS") ?? DEFAULT_CONFIG.approvalTtlMs,
      oneTimeGrantTtlMs: int(env, "REI_ONE_TIME_GRANT_TTL_MS") ?? DEFAULT_CONFIG.oneTimeGrantTtlMs,
      maxModelCallsPerRun: int(env, "REI_MAX_MODEL_CALLS") ?? DEFAULT_CONFIG.maxModelCallsPerRun,
      maxRunMs: int(env, "REI_MAX_RUN_MS") ?? DEFAULT_CONFIG.maxRunMs,
      codemode: {
        timeoutMs: positive(env, "REI_CODEMODE_TIMEOUT_MS") ?? DEFAULT_CONFIG.codemode.timeoutMs,
        memoryLimitBytes: positive(env, "REI_CODEMODE_MEMORY_BYTES") ?? DEFAULT_CONFIG.codemode.memoryLimitBytes,
        maxWorkers: positive(env, "REI_CODEMODE_MAX_WORKERS") ?? DEFAULT_CONFIG.codemode.maxWorkers,
        // 0 is allowed: the section then lists no declarations and scripts find tools with searchTools().
        ...(int(env, "REI_CODEMODE_INLINE_BUDGET") !== undefined
          ? { inlineBudget: int(env, "REI_CODEMODE_INLINE_BUDGET")! }
          : {}),
      },
      exec: readExec(env, mode),
      browser: readBrowser(env),
      ...(embedder ? { embedder } : {}),
      ...(env.REI_DEMO_TOOLS === "1" ? { demoTools: true } : env.REI_DEMO_TOOLS === "0" ? { demoTools: false } : {}),
      retry,
      ...(fauxTps !== undefined ? { fauxTokensPerSecond: fauxTps } : {}),
      ...(restartLimit !== undefined ? { restartLimit } : {}),
      ...(partial !== undefined ? { partialIntervalMs: partial } : {}),
      ...(ping !== undefined && ping > 0 ? { ssePingMs: ping } : {}),
    },
  };
}
