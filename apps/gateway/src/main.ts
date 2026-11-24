// The gateway process: `node src/main.ts`. Environment: REI_STANDIN (required: the stand-in token; REI_STANDIN_FILE names a file that holds it),
// REI_LOG_LEVEL (info), GATEWAY_PORT (8780), GATEWAY_DATA (/data), GATEWAY_HOST (0.0.0.0; a comma-separated list binds
// each address), GATEWAY_SHARED_LISTEN (host:port of the listener for outside callers; unset means none),
// GATEWAY_REI_BUDGET (JSON caps for Rei's own caller; unset means none), GATEWAY_CAPPED_CALL_MAX_MS (600000),
// GATEWAY_READER_URL (the shared reader, for POST /read; unset means none), GATEWAY_ALLOWED_UPSTREAMS (extra origins), GATEWAY_CONNECT_TIMEOUT_MS, GATEWAY_IDLE_TIMEOUT_MS. Web search (POST /search) is configured in the web
// app only: providers, Exa auth, an external SearXNG URL and every API key are saved settings (see node/search-setup.ts).
// MCP connectors and notifications: REI_VAPID_SUBJECT (Web Push `sub`, default https://example.com/), GATEWAY_MCP_DEV_HOSTS
// (hosts allowed over plain http, for local MCP servers; none by default). Their secrets live in <data>/secret/gateway-state.json.
import { serve } from "@hono/node-server";
import { createLogger, parseLogLevel } from "@rei/logging";
import { createFcmSender, readFcmAccount } from "./core/notify/fcm.ts";
import { createGatewayApps } from "./core/proxy.ts";
import { createRedactor } from "./core/redact.ts";
import { DEFAULT_PROVIDER_ORDER } from "./core/search/service.ts";
import { PiTokenSource } from "./node/auth.ts";
import { gatewayBackup } from "./node/backup.ts";
import { SqliteCallLog } from "./node/calllog.ts";
import { codexAccess } from "./node/codex-auth.ts";
import { codexImages } from "./node/codex-images.ts";
import { codexImagesSetup } from "./node/codex-signin.ts";
import { loadConfig, resolveStandin } from "./node/config.ts";
import { FileCredentialStore } from "./node/credstore.ts";
import { modelsReader } from "./node/modelsfile.ts";
import { FileProviderManager } from "./node/providers.ts";
import { SearchSetup } from "./node/search-setup.ts";
import { FileSecretStore } from "./node/secretstore.ts";
import { subscriptionSearch } from "./node/subscription-search.ts";

process.umask(0o077); // every file the gateway creates is private to its user
const config = loadConfig();
const standin = resolveStandin(config);
const redactor = createRedactor();
redactor.add(standin);
const log = createLogger({
  service: "gateway",
  level: parseLogLevel(process.env.REI_LOG_LEVEL),
  redact: redactor.redact,
});

const store = new FileCredentialStore(config.credentialsFile);
const tokens = new PiTokenSource(store, redactor, { log });
await tokens.prime();
const providers = new FileProviderManager(config.providersFile, store);
const calls = new SqliteCallLog(config.callsDb);
const pruneTimer = setInterval(() => calls.prune(), 3_600_000);
pruneTimer.unref();

const secrets = new FileSecretStore(config.secretsFile);

const searchSetup = await SearchSetup.load(secrets, {
  providers: [...DEFAULT_PROVIDER_ORDER],
  subscription: subscriptionSearch(store, tokens, (value) => redactor.add(value)),
  exaAuth: "keyless",
  keys: async () => null, // keys are saved settings; SearchSetup reads them
});
const apps = createGatewayApps({
  standin,
  ...(config.reiBudget ? { reiBudget: config.reiBudget } : {}),
  cappedCallMaxMs: config.cappedCallMaxMs,
  setupSearch: searchSetup,
  codexImages: codexImages(codexAccess(new FileCredentialStore(config.codexCredentialsFile), redactor)),
  codexImagesSetup: codexImagesSetup(new FileCredentialStore(config.codexCredentialsFile)),
  ...(config.embeddingUrl && config.embeddingModel
    ? {
        embedding: {
          baseUrl: config.embeddingUrl,
          apiModel: config.embeddingModel,
        },
      }
    : {}),
  tokens,
  providers,
  calls,
  models: modelsReader(config.modelsFile),
  version: config.version,
  upstreams: config.upstreams,
  redactor,
  log,
  connectTimeoutMs: config.connectTimeoutMs,
  idleTimeoutMs: config.idleTimeoutMs,
  secrets,
  backup: gatewayBackup({
    dataDir: config.dataDir,
    secretDir: config.secretDir,
    modelsFile: config.modelsFile,
    calls,
    version: config.version,
  }),
  ...(config.readerUrl ? { reader: { url: config.readerUrl } } : {}),
  mcp: { devHosts: config.mcpDevHosts },
  vapidSubject: config.vapidSubject,
  ...(config.fcmServiceAccount
    ? { fcm: createFcmSender(await readFcmAccount(config.fcmServiceAccount), fetch, Date.now) }
    : {}),
  search: searchSetup.config,
});

// The full app on every internal address, and the app for outside callers on its own address when one is set.
const listeners = [
  ...config.hosts.map((host) => ({ kind: "internal", app: apps.internal, host, port: config.port })),
  ...(config.sharedListen ? [{ kind: "shared", app: apps.shared, ...config.sharedListen }] : []),
];
const servers = listeners.map(({ kind, app, host, port }) =>
  serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    log.info("gateway.listening", {
      version: config.version,
      listener: kind,
      address: info.address,
      port: info.port,
      upstreams: config.upstreams.length,
    });
  }),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info("gateway.stopping", { signal });
    for (const server of servers) {
      server.close();
      if ("closeAllConnections" in server) server.closeAllConnections();
    }
    calls.close();
    process.exit(0);
  });
}
