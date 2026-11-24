// The reader process: `node src/main.ts`. Environment: READER_PORT (8790), READER_HOST (0.0.0.0), READER_PROXY_PORT
// (3129, loopback only: the reader's own forward proxy), READER_DATA (/data), READER_REFUSE_CIDRS, READER_ENGINES
// (moli,chromium: the order engines are tried in; one name alone turns the other off), READER_RENDER_SLOTS (2, per
// engine), READER_SHADOW_RATE (0.1), READER_MOLI_PATH, READER_CHROMIUM_PATH, REI_LOG_LEVEL (info).
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createEgressProxy } from "@rei/forward-proxy";
import { createLogger, parseLogLevel } from "@rei/logging";
import { interfaceCidrs, parseCidrList } from "@rei/network";
import type { EngineEntry } from "./core/read.ts";
import { Slots } from "./core/render.ts";
import { createReaderApp } from "./node/app.ts";
import { SqliteAttempts } from "./node/attempts.ts";
import { loadConfig } from "./node/config.ts";
import { ChromiumEngine, MoliEngine } from "./node/engines.ts";
import { createJobTokens } from "./node/jobs.ts";
import { createProxyFetch } from "./node/proxy-fetch.ts";

process.umask(0o077);
const config = loadConfig();
const log = createLogger({ service: "reader", level: parseLogLevel(process.env.REI_LOG_LEVEL) });
const jobs = createJobTokens();
const refuse = [...interfaceCidrs(os.networkInterfaces()), ...parseCidrList(config.refuseCidrs)];
const proxy = createEgressProxy({ decide: jobs.decide, source: "render", refuse, log });
await new Promise<void>((resolve) => proxy.listen(config.proxyPort, config.proxyHost, resolve));
log.info("reader.proxy_listening", { host: config.proxyHost, port: config.proxyPort, refuse: refuse.length });

const proxyAddress = `${config.proxyHost}:${config.proxyPort}`;
const engines: EngineEntry[] = [];
let chromium: ChromiumEngine | undefined;
for (const name of config.engines) {
  const binary = name === "moli" ? config.moliPath : config.chromiumPath;
  try {
    await access(binary);
  } catch {
    log.warn("reader.engine_missing", { engine: name });
    continue;
  }
  let engine: MoliEngine | ChromiumEngine;
  if (name === "moli") engine = new MoliEngine({ binary, proxy: proxyAddress });
  else {
    chromium = new ChromiumEngine({ binary, proxy: proxyAddress });
    engine = chromium;
  }
  engines.push({ engine, slots: new Slots({ slots: config.renderSlots }) });
}
log.info("reader.engines", {
  engines: engines.map((e) => e.engine.name).join("+") || "none",
  slots: config.renderSlots,
});

const attempts = new SqliteAttempts(path.join(config.data, "reader.db"));
setInterval(() => attempts.prune(), 3_600_000).unref();

const app = createReaderApp({
  log,
  attempts,
  fetch: createProxyFetch(proxyAddress),
  openFetchJob: (request) =>
    jobs.open({
      kind: "fetch",
      allowHosts: request.allowHosts,
      localNetworks: request.localNetworks,
      deadlineMs: 60_000,
    }),
  render: {
    engines,
    attempts,
    shadowRate: config.shadowRate,
    openJob: (deadlineMs) => jobs.open({ kind: "render", deadlineMs }),
  },
});
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  log.info("reader.listening", { host: config.host, port: info.port });
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info("reader.stopping", { signal });
    chromium?.close();
    server.close();
    attempts.close();
    process.exit(0);
  });
}
