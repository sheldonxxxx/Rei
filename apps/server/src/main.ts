// Entry point of the control-plane server: `node src/main.ts`. Everything it reads comes from the environment
// (see src/node/config.ts); everything it does lives in createControlPlane.
import { serve } from "@hono/node-server";
import { attachBrowserLive } from "./node/browser-live.ts";
import { readConfig } from "./node/config.ts";
import { createNodeHost } from "./node/host.ts";

const config = readConfig();
const host = await createNodeHost(config);
await host.plane.start();

// Node's default gives a request 5 minutes to arrive in full, which a 1 GiB upload over a slow link can miss. An hour
// covers about 300 KB/s; headers still have to arrive within Node's own 60 seconds.
const REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

const server = serve(
  {
    fetch: host.plane.app.fetch,
    port: config.port,
    hostname: config.host,
    serverOptions: { requestTimeout: REQUEST_TIMEOUT_MS },
  },
  (info) => {
    host.log.info("server.listening", { port: info.port, host: config.host, mode: config.control.mode });
  },
);

const closeLive = host.plane.browser
  ? attachBrowserLive(server, {
      live: host.plane.browser.live,
      auth: host.plane.auth,
      store: host.plane.store,
      log: host.log,
      publicUrl: config.control.publicUrl,
    })
  : () => {};

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  host.log.info("server.stopping", { signal });
  const hardStop = setTimeout(() => process.exit(1), 15_000);
  hardStop.unref();
  closeLive();
  server.close();
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  await host.plane.stop();
  host.closeDb();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
