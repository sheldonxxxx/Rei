// The egress proxy process: `node src/main.ts`. Environment: EGRESS_PORT (3128), EGRESS_HOST (0.0.0.0),
// EGRESS_DECIDE_SOCKET (/run/egress/decide.sock), EGRESS_BROWSER_LISTEN (host:port, off when unset): a second listener
// for the agent computer's browser, which has no token; its source network is the identity.
// EGRESS_REFUSE_CIDRS
// (comma-separated): networks the proxy never connects into, besides the subnets of its own interfaces, which are always
// refused (the stack's networks: from a page in the browser they would reach DevTools or another container).
// REI_LOG_LEVEL (info): debug adds one line per allowed connection.
import os from "node:os";
import { createEgressProxy } from "@rei/forward-proxy";
import { createLogger, parseLogLevel } from "@rei/logging";
import { interfaceCidrs, parseCidrList } from "@rei/network";
import { unixDecide } from "./decide.ts";

const port = Number(process.env.EGRESS_PORT ?? 3128);
const host = process.env.EGRESS_HOST ?? "0.0.0.0";
const socketPath = process.env.EGRESS_DECIDE_SOCKET ?? "/run/egress/decide.sock";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("EGRESS_PORT must be a port number");

const refuse = [...interfaceCidrs(os.networkInterfaces()), ...parseCidrList(process.env.EGRESS_REFUSE_CIDRS ?? "")];
const log = createLogger({ service: "egress", level: parseLogLevel(process.env.REI_LOG_LEVEL) });
const decide = unixDecide(socketPath);
const server = createEgressProxy({ decide, refuse, log });
server.listen(port, host, () => {
  log.info("egress.listening", { host, port, decideSocket: socketPath, refuse: refuse.length });
});
/** host:port from a variable, or undefined when it is unset. */
function listenAddress(name: string): { host: string; port: number } | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const at = value.lastIndexOf(":");
  const listenPort = Number(value.slice(at + 1));
  if (at < 1 || !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535)
    throw new Error(`${name} must be host:port`);
  return { host: value.slice(0, at), port: listenPort };
}
{
  const at = listenAddress("EGRESS_BROWSER_LISTEN");
  if (at)
    createEgressProxy({ decide, source: "browser", refuse, log }).listen(at.port, at.host, () => {
      log.info("egress.listening", { host: at.host, port: at.port, source: "browser" });
    });
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info("egress.stopping", { signal });
    process.exit(0); // tunnels are disposable; clients reconnect
  });
}
