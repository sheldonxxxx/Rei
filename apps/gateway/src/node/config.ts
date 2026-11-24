// Environment, paths and the stand-in token. Everything the gateway process reads from its surroundings is here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallerBudget } from "@rei/protocol";
import { parseBudget, UNCAPPED_BUDGET } from "../core/callers.ts";
import type { UpstreamRule } from "../core/upstream.ts";
import { DEFAULT_UPSTREAMS, parseUpstreamRules } from "../core/upstream.ts";

export interface GatewayConfig {
  embeddingUrl: string | undefined;
  embeddingModel: string | undefined;
  port: number;
  /** Where the full app listens (GATEWAY_HOST, comma separated; default 0.0.0.0). */
  hosts: string[];
  /** Where the app for outside callers listens (GATEWAY_SHARED_LISTEN, host:port). Unset: no such listener. */
  sharedListen: { host: string; port: number } | undefined;
  /** Caps for Rei's own caller (GATEWAY_REI_BUDGET, JSON). Unset: none. */
  reiBudget: CallerBudget | undefined;
  /** Where the shared reader listens (GATEWAY_READER_URL, for example http://reader:8790). Unset: no reader. */
  readerUrl: string | undefined;
  /** GATEWAY_CAPPED_CALL_MAX_MS: the longest a call that holds a capped slot may run. */
  cappedCallMaxMs: number;
  dataDir: string;
  secretDir: string;
  credentialsFile: string;
  codexCredentialsFile: string;
  providersFile: string;
  /** Connectors and the VAPID key pair (node/secretstore.ts). */
  secretsFile: string;
  callsDb: string;
  modelsFile: string;
  /** The stand-in token itself (REI_STANDIN, from containers/.secrets/secrets.env), or the file that holds it. */
  standinToken: string | undefined;
  standinFile: string | undefined;
  upstreams: UpstreamRule[];
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  /** MCP connectors: hostnames allowed over plain http (GATEWAY_MCP_DEV_HOSTS, comma separated; empty by default). */
  mcpDevHosts: string[];
  /** Web Push VAPID `sub` (REI_VAPID_SUBJECT). */
  vapidSubject: string;
  fcmServiceAccount?: string;
  version: string;
}

export const PROVIDER_ID = "openai";

export function dataPaths(dataDir: string) {
  const secretDir = join(dataDir, "secret");
  return {
    dataDir,
    secretDir,
    credentialsFile: join(secretDir, "credentials.json"),
    codexCredentialsFile: join(secretDir, "codex-images.json"),
    providersFile: join(secretDir, "providers.json"),
    secretsFile: join(secretDir, "gateway-state.json"),
    callsDb: join(dataDir, "calls.sqlite"),
    modelsFile: join(dataDir, "models.json"),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const standinToken = env.REI_STANDIN?.trim() || undefined;
  const standinFile = env.REI_STANDIN_FILE || undefined;
  if (!standinToken && !standinFile)
    throw new Error(
      "REI_STANDIN is not set: it holds the stand-in token (or set REI_STANDIN_FILE to the file that does).",
    );
  const port = Number(env.GATEWAY_PORT ?? 8780);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`GATEWAY_PORT is not a valid port: ${env.GATEWAY_PORT}`);
  const hosts = (env.GATEWAY_HOST ?? "0.0.0.0")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hosts.length === 0) throw new Error("GATEWAY_HOST names no address");
  const cappedCallMaxMs = Number(env.GATEWAY_CAPPED_CALL_MAX_MS ?? 600_000);
  if (!Number.isFinite(cappedCallMaxMs) || cappedCallMaxMs < 1000)
    throw new Error(`GATEWAY_CAPPED_CALL_MAX_MS must be at least 1000: ${env.GATEWAY_CAPPED_CALL_MAX_MS}`);
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return {
    embeddingUrl: env.GATEWAY_EMBEDDING_URL || undefined,
    embeddingModel: env.GATEWAY_EMBEDDING_MODEL || undefined,
    port,
    hosts,
    sharedListen: parseListen(env.GATEWAY_SHARED_LISTEN),
    reiBudget: parseReiBudget(env.GATEWAY_REI_BUDGET),
    cappedCallMaxMs,
    readerUrl: parseReaderUrl(env.GATEWAY_READER_URL),
    ...dataPaths(env.GATEWAY_DATA ?? "/data"),
    standinToken,
    standinFile,
    upstreams: [...DEFAULT_UPSTREAMS, ...parseUpstreamRules(env.GATEWAY_ALLOWED_UPSTREAMS ?? "")],
    connectTimeoutMs: Number(env.GATEWAY_CONNECT_TIMEOUT_MS ?? 15_000),
    idleTimeoutMs: Number(env.GATEWAY_IDLE_TIMEOUT_MS ?? 60_000),
    mcpDevHosts: (env.GATEWAY_MCP_DEV_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    ...(env.REI_FCM_SERVICE_ACCOUNT_JSON?.trim() ? { fcmServiceAccount: env.REI_FCM_SERVICE_ACCOUNT_JSON.trim() } : {}),
    vapidSubject: env.REI_VAPID_SUBJECT?.trim() || "https://example.com/",
    version: pkg.version,
  };
}

/** GATEWAY_READER_URL: an http(s) URL with no path, or undefined when the variable is empty. A bad value stops the gateway. */
export function parseReaderUrl(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`GATEWAY_READER_URL must be an http or https URL, got: ${text}`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash)
    throw new Error(`GATEWAY_READER_URL must be an http or https URL with no credentials or query, got: ${text}`);
  return url.origin;
}

/** `host:port` (an IPv6 host in brackets), or undefined when the variable is empty. */
export function parseListen(raw: string | undefined): { host: string; port: number } | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:\s]+):(\d{1,5})$/.exec(text);
  const port = Number(m?.[2]);
  if (!m || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`GATEWAY_SHARED_LISTEN must be host:port, got: ${text}`);
  return { host: m[1]!.replace(/^\[|\]$/g, ""), port };
}

/** GATEWAY_REI_BUDGET: JSON in the shape of a caller budget. A bad value stops the gateway instead of being ignored. */
export function parseReiBudget(raw: string | undefined): CallerBudget | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  try {
    return parseBudget(JSON.parse(text), UNCAPPED_BUDGET);
  } catch (cause) {
    throw new Error(`GATEWAY_REI_BUDGET is not a valid budget: ${cause instanceof Error ? cause.message : "bad JSON"}`);
  }
}

/** The stand-in token, from REI_STANDIN or its file; the gateway refuses to start without one. */
export function resolveStandin(config: Pick<GatewayConfig, "standinToken" | "standinFile">): string {
  if (config.standinToken) {
    if (config.standinToken.length < 16) throw new Error("REI_STANDIN must hold a token of at least 16 characters");
    return config.standinToken;
  }
  return readStandin(config.standinFile!);
}

/** Reads the stand-in token from a file. */
export function readStandin(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch (cause) {
    throw new Error(`cannot read the stand-in file ${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (text.length < 16) throw new Error(`the stand-in file ${file} must hold a token of at least 16 characters`);
  return text;
}
