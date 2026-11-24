import type { Logger } from "@rei/logging";
import type {
  CallerBudget,
  GatewayCallRecord,
  GatewayCallsSummary,
  ProviderConnection,
  SaveProviderConnectionRequest,
  ScanProviderModelsRequest,
  ScanProviderModelsResponse,
} from "@rei/protocol";
import type { Redactor } from "./redact.ts";
import type { SearchDeps } from "./search/service.ts";
import type { SecretStore } from "./secrets.ts";
import type { UpstreamRule } from "./upstream.ts";

/** Why a real token could not be produced. `code` is stable and is what the control plane sees. */
export class TokenError extends Error {
  readonly code: "not_signed_in" | "credential_refresh_failed" | "credential_error";
  constructor(code: TokenError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

/** Holds the real credential. The proxy core only ever sees the bearer string for the next request. */
export interface TokenSource {
  /** The real bearer token for the upstream; refreshes first when it is about to expire (single flight). */
  accessToken(providerId?: string): Promise<string>;
  status(): Promise<{ signedIn: boolean; accessExpiresInS: number | null }>;
}

export interface ProviderManager {
  list(): Promise<ProviderConnection[]>;
  scanModels(input: ScanProviderModelsRequest): Promise<ScanProviderModelsResponse>;
  save(input: SaveProviderConnectionRequest): Promise<ProviderConnection>;
  remove(id: string): Promise<void>;
  token(id: string): Promise<string>;
  upstreams(): Promise<UpstreamRule[]>;
  startOpenAiOAuth(): Promise<{ authorizationUrl: string }>;
  submitOpenAiOAuthCallback(url: string): Promise<void>;
  openAiOAuthStatus(): { pending: boolean; authorizationUrl?: string; error?: string };
  cancelOpenAiOAuth(): void;
}

export interface CodexImagesSignInStatus {
  enabled: boolean;
  signedIn: boolean;
  pending: boolean;
  userCode?: string;
  verificationUrl?: string;
  error?: string;
}

/** Codex Images sign-in from the web app: a device-code attempt the gateway runs and remembers. */
export interface CodexImagesSetup {
  status(): Promise<CodexImagesSignInStatus>;
  start(): Promise<{ userCode: string; verificationUrl: string }>;
  cancel(): void;
  signOut(): Promise<void>;
}

export interface CallLog {
  insert(record: GatewayCallRecord): void;
  /** One caller's records for a step, oldest first. */
  byStep(stepId: string, caller: string): GatewayCallRecord[];
  /** Newest first; every caller's unless one is named. */
  recent(limit: number, caller?: string): GatewayCallRecord[];
  summary(sinceMs: number): GatewayCallsSummary["rows"];
  /** When each caller's newest record started. */
  lastUsed(): Map<string, number>;
}

export interface GatewayDeps {
  /** Rei's own caller token (REI_STANDIN): the control plane presents it, and it carries every scope. */
  standin: string;
  /** Caps for Rei's own caller (GATEWAY_REI_BUDGET). Unset means no caps. */
  reiBudget?: CallerBudget;
  /** The longest a call that holds a capped slot may run before it is cut. Default 10 minutes. */
  cappedCallMaxMs?: number;
  setupSearch?: {
    read(): Promise<import("@rei/protocol").SearchSetupSettings>;
    save(input: import("@rei/protocol").SaveSearchSetupSettings): Promise<import("@rei/protocol").SearchSetupSettings>;
  };
  codexImages?: import("./codex-images.ts").RenderCodexImage;
  codexImagesSetup?: CodexImagesSetup;
  embedding?: import("./embedding.ts").EmbeddingRoute;
  tokens: TokenSource;
  providers?: ProviderManager;
  calls: CallLog;
  /** Models found by the last probe. */
  models: () => string[];
  version: string;
  upstreams: readonly UpstreamRule[];
  redactor: Redactor;
  /** Structured service log (ADR 0003): ids, counts and codes only. The gateway redacts string fields before writing. */
  log: Logger;
  fetch?: typeof fetch;
  /** Web search providers (POST /search). Without it the endpoint answers 503 search_unavailable. */
  search?: SearchDeps;
  /** The shared reader (POST /read is handed to it, with the caller's id). Without it the endpoint answers 503 read_unavailable. */
  reader?: { url: string; timeoutMs?: number };
  /** Where MCP connectors and the VAPID key are kept. Without it /mcp/* and /notify/* answer 503. */
  secrets?: SecretStore;
  /** MCP connectors and the notification senders. */
  mcp?: {
    /** Hostnames allowed over plain http and exempt from the public-host rule (tests, a local MCP server). */
    devHosts?: readonly string[];
    callTimeoutMs?: number;
  };
  /** VAPID `sub` claim for Web Push (a mailto: or https: URL). */
  vapidSubject?: string;
  fcm?: import("./notify/fcm.ts").FcmSender;
  /** Test seam for the Web Push encryption (fixed sender key and salt); never set in production. */
  pushEncrypt?: import("./notify/webpush.ts").EncryptOptions;
  /** Wait for response headers (connect + request + first reply). Default 15 s. */
  connectTimeoutMs?: number;
  /** Maximum silence between two body chunks. Default 60 s. */
  idleTimeoutMs?: number;
  /** Request body limit in bytes. Default 64 MiB. */
  maxBodyBytes?: number;
  now?: () => number;
}
