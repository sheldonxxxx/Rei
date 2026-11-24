// A running gateway for tests: real HTTP server on loopback, real credential file and SQLite store in a temp
// directory, the fake upstream as both OpenAI API and OAuth token endpoint.

import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createLogger } from "@rei/logging";
import { STEP_ID_HEADER, UPSTREAM_HEADER } from "@rei/protocol";
import { createGatewayApp } from "../src/core/proxy.ts";
import { createRedactor } from "../src/core/redact.ts";
import { DEFAULT_UPSTREAMS } from "../src/core/upstream.ts";
import { PiTokenSource } from "../src/node/auth.ts";
import { SqliteCallLog } from "../src/node/calllog.ts";
import { dataPaths, PROVIDER_ID } from "../src/node/config.ts";
import { FileCredentialStore } from "../src/node/credstore.ts";
import { modelsReader, writeProbe } from "../src/node/modelsfile.ts";
import { FileProviderManager } from "../src/node/providers.ts";
import { type FakeOptions, type Handler, makeToken, startFakeUpstream } from "./fake-upstream.ts";

export interface RigOptions {
  handler?: Handler;
  fake?: FakeOptions;
  /** Seed an access token that has already expired, so the first request must refresh. */
  expired?: boolean;
  /** Do not seed any credential. */
  signedOut?: boolean;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  failureBackoffMs?: number;
  /** The gateway's outbound fetch (the end-to-end test points api.openai.com at the fake upstream with it). */
  fetch?: typeof fetch;
}

export const defaultHandler: Handler = (rec) => ({
  kind: "text",
  text: `echo: ${rec.json?.input?.[0]?.content?.[0]?.text ?? ""}`,
});

export async function startRig(options: RigOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gateway-test-"));
  const paths = dataPaths(dir);
  const access = makeToken("access");
  const refresh = makeToken("refresh");
  const fake = await startFakeUpstream(options.handler ?? defaultHandler, { ...options.fake, access, refresh });
  process.env.GATEWAY_TEST_TOKEN_URL = fake.tokenUrl;

  const store = new FileCredentialStore(paths.credentialsFile);
  if (!options.signedOut) {
    await store.modify(PROVIDER_ID, async () => ({
      type: "oauth",
      access,
      refresh,
      expires: Date.now() + (options.expired ? -60_000 : 3_600_000),
      clientId: "client-test",
      scopes: ["openid", "offline_access", "chatgpt.tokens.use.direct"],
    }));
  }
  const standin = `standin-${randomBytes(24).toString("base64url")}`;
  const redactor = createRedactor();
  redactor.add(standin);
  const logs: string[] = [];
  const log = createLogger({ service: "gateway", level: "debug", write: (line) => void logs.push(line) });
  const tokens = new PiTokenSource(store, redactor, { failureBackoffMs: options.failureBackoffMs ?? 0, log });
  await tokens.prime();
  const calls = new SqliteCallLog(paths.callsDb);

  // Everything the process prints while the rig is up, for the leak scan.
  const printed: string[] = [];
  const restores: (() => void)[] = [];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      printed.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
    restores.push(() => void (stream.write = original as typeof stream.write));
  }

  const app = createGatewayApp({
    standin,
    tokens,
    providers: new FileProviderManager(join(paths.secretDir, "providers.json"), store),
    calls,
    models: modelsReader(paths.modelsFile),
    version: "0.0.0-test",
    upstreams: [
      ...DEFAULT_UPSTREAMS,
      { protocol: "http:", host: "127.0.0.1", port: String(fake.port), pathPrefix: "/v1/" },
    ],
    redactor,
    log,
    ...(options.connectTimeoutMs ? { connectTimeoutMs: options.connectTimeoutMs } : {}),
    ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const body = (text: string, model = "gpt-test") =>
    JSON.stringify({ model, stream: true, input: [{ role: "user", content: [{ type: "input_text", text }] }] });

  const post = (
    text: string,
    o: {
      token?: string | null;
      step?: string;
      upstream?: string | null;
      headers?: Record<string, string>;
      path?: string;
      model?: string;
      signal?: AbortSignal;
    } = {},
  ) =>
    fetch(`${base}${o.path ?? "/v1/responses"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? standin}` }),
        ...(o.upstream === null ? {} : { [UPSTREAM_HEADER]: o.upstream ?? `${fake.url}/responses` }),
        ...(o.step ? { [STEP_ID_HEADER]: o.step } : {}),
        ...o.headers,
      },
      body: body(text, o.model),
      ...(o.signal ? { signal: o.signal } : {}),
    });

  const getCalls = async (stepId: string) =>
    (await (
      await fetch(`${base}/calls?stepId=${encodeURIComponent(stepId)}`, {
        headers: { authorization: `Bearer ${standin}` },
      })
    ).json()) as import("@rei/protocol").GatewayCallRecord[];

  return {
    dir,
    paths,
    fake,
    access,
    refresh,
    standin,
    base,
    logs,
    printed,
    calls,
    store,
    tokens,
    post,
    getCalls,
    writeProbe: (accepted: string[]) =>
      writeProbe(paths.modelsFile, { at: new Date().toISOString(), accepted, rejected: [] }),
    /** Raw bytes of every file outside secret/ (logs, SQLite incl. -wal/-shm, models.json). */
    nonSecretFiles: () =>
      walk(dir)
        .filter((f) => !f.startsWith(paths.secretDir))
        .map((f) => ({ file: f, bytes: readFileSync(f) })),
    stop: async () => {
      for (const r of restores) r();
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      calls.close();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type Rig = Awaited<ReturnType<typeof startRig>>;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
