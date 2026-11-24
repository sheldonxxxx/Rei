// A gateway app wired to the fake world (no sockets: requests go straight to app.fetch) with a real secret file and call
// log in a temp directory. `restart()` builds a second app over the same files, as a gateway restart would.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@rei/logging";
import type { EncryptOptions } from "../src/core/notify/webpush.ts";
import { createGatewayApp } from "../src/core/proxy.ts";
import { createRedactor } from "../src/core/redact.ts";
import { DEFAULT_UPSTREAMS } from "../src/core/upstream.ts";
import { SqliteCallLog } from "../src/node/calllog.ts";
import { dataPaths } from "../src/node/config.ts";
import { FileSecretStore } from "../src/node/secretstore.ts";
import type { World, WorldOptions } from "./mcp-world.ts";
import { createWorld } from "./mcp-world.ts";

export interface McpRigOptions {
  world?: WorldOptions;
  devHosts?: string[];
  fetch?: typeof fetch;
  /** Wrap the world's fetch (to break the network for some requests). */
  wrapFetch?: (real: typeof fetch) => typeof fetch;
  pushEncrypt?: EncryptOptions;
  callTimeoutMs?: number;
}

export function startMcpRig(options: McpRigOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gateway-mcp-test-"));
  const paths = dataPaths(dir);
  const world: World = createWorld(options.world);
  const standin = "standin-mcp-test-token-0123456789";
  const logs: string[] = [];
  const clock = { t: 1_700_000_000_000 };
  const printed: string[] = [];
  const originals: [NodeJS.WriteStream, typeof process.stdout.write][] = [];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    originals.push([stream, stream.write]);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      printed.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
  }
  const calls = new SqliteCallLog(paths.callsDb);

  function build() {
    const redactor = createRedactor();
    redactor.add(standin);
    return createGatewayApp({
      standin,
      tokens: {
        accessToken: async () => "unused-access-token",
        status: async () => ({ signedIn: false, accessExpiresInS: null }),
      },
      calls,
      models: () => [],
      version: "0.0.0-test",
      upstreams: DEFAULT_UPSTREAMS,
      redactor,
      log: createLogger({ service: "gateway", level: "debug", write: (line) => void logs.push(line) }),
      now: () => clock.t,
      fetch: options.fetch ?? (options.wrapFetch ? options.wrapFetch(world.fetch) : world.fetch),
      secrets: new FileSecretStore(paths.secretsFile),
      mcp: {
        devHosts: options.devHosts ?? [],
        ...(options.callTimeoutMs ? { callTimeoutMs: options.callTimeoutMs } : {}),
      },
      ...(options.pushEncrypt ? { pushEncrypt: options.pushEncrypt } : {}),
    });
  }
  let app = build();

  const request = (method: string, path: string, body?: unknown, o: { token?: string | null; raw?: string } = {}) =>
    app.fetch(
      new Request(`http://gateway.test${path}`, {
        method,
        headers: {
          ...(body !== undefined || o.raw !== undefined ? { "content-type": "application/json" } : {}),
          ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? standin}` }),
        },
        ...(body !== undefined || o.raw !== undefined ? { body: o.raw ?? JSON.stringify(body) } : {}),
      }),
    );
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

  return {
    dir,
    paths,
    world,
    standin,
    logs,
    printed,
    clock,
    request,
    json: async <T = any>(res: Response): Promise<T> => (await res.json()) as T,
    restart: () => void (app = build()),
    /** Raw text of every file outside secret/ (calls.sqlite incl. -wal/-shm). */
    nonSecretFiles: () =>
      walk(dir)
        .filter((f) => !f.startsWith(paths.secretDir))
        .map((f) => readFileSync(f).toString("latin1")),
    secretFile: () => readFileSync(paths.secretsFile, "utf8"),
    stop: () => {
      for (const [stream, write] of originals) stream.write = write;
      calls.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export type McpRig = ReturnType<typeof startMcpRig>;
