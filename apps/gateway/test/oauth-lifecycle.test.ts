import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileCredentialStore } from "../src/node/credstore.ts";
import { FileProviderManager } from "../src/node/providers.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = "oauth-lifecycle-test";
let dir: string;
let credentials: FileCredentialStore;
let providers: FileProviderManager;
let exchange: (init?: RequestInit) => Promise<Response>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rei-oauth-lifecycle-"));
  credentials = new FileCredentialStore(join(dir, "credentials.json"));
  providers = new FileProviderManager(join(dir, "providers.json"), credentials);
  await providers.save({ kind: "openai", name: "Existing connection", apiKey: "previous-test-key" });
  exchange = async () => {
    throw new Error("Unexpected token exchange");
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/.well-known/jwks.json")
      return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid }] });
    if (url.pathname === "/api/accounts/oauth/token") return exchange(init);
    throw new Error("Unexpected OAuth request");
  });
});
afterEach(() => {
  providers.cancelOpenAiOAuth();
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function callback(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state")!;
  return `http://127.0.0.1:1455/auth/callback?code=test-code&client_id=issued-client&state=${state}`;
}
function tokens(authorizationUrl: string): Response {
  const nonce = new URL(authorizationUrl).searchParams.get("nonce");
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      aud: "issued-client",
      exp: Date.now() / 1000 + 3600,
      iat: Date.now() / 1000,
      nonce,
      sub: "test-user",
    }),
  ).toString("base64url");
  const data = `${header}.${claims}`;
  const idToken = `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
  return Response.json({
    access_token: "test-access",
    refresh_token: "test-refresh",
    id_token: idToken,
    scope: "openid chatgpt.tokens.use.direct",
    expires_in: 3600,
  });
}
async function unchanged(): Promise<void> {
  expect(await credentials.read("openai")).toEqual({ type: "api_key", key: "previous-test-key" });
  expect(await providers.list()).toEqual([
    { id: "openai", kind: "openai", name: "Existing connection", auth: "api_key", connected: true, models: [] },
  ]);
}

it("reserves an attempt before credential loading and never revives a canceled start", async () => {
  const gate = Promise.withResolvers<undefined>();
  vi.spyOn(credentials, "read").mockImplementationOnce(() => gate.promise);
  const starting = providers.startOpenAiOAuth();
  const rejected = expect(starting).rejects.toThrow("no longer active");
  expect(providers.openAiOAuthStatus().pending).toBe(true);
  await expect(providers.startOpenAiOAuth()).rejects.toThrow("already in progress");
  providers.cancelOpenAiOAuth();
  const next = await providers.startOpenAiOAuth();
  gate.resolve(undefined);
  await rejected;
  expect(providers.openAiOAuthStatus()).toEqual({ pending: true, authorizationUrl: next.authorizationUrl });
  await unchanged();
});

it.each([false, true])(
  "ignores late exchange results after cancel and a replacement attempt (HTTP failure=%s)",
  async (fail) => {
    const response = Promise.withResolvers<Response>();
    let signal: AbortSignal | null | undefined;
    exchange = (init) => {
      signal = init?.signal;
      return response.promise;
    };
    const first = await providers.startOpenAiOAuth();
    const old = providers.submitOpenAiOAuthCallback(callback(first.authorizationUrl));
    const rejected = expect(old).rejects.toThrow("no longer active");
    await expect(providers.submitOpenAiOAuthCallback(callback(first.authorizationUrl))).rejects.toThrow(
      "already being processed",
    );
    providers.cancelOpenAiOAuth();
    expect(signal?.aborted).toBe(true);
    const next = await providers.startOpenAiOAuth();
    response.resolve(fail ? new Response("refused", { status: 400 }) : tokens(first.authorizationUrl));
    await rejected;
    expect(providers.openAiOAuthStatus()).toEqual({ pending: true, authorizationUrl: next.authorizationUrl });
    await unchanged();
  },
);

it("expires an exchanging attempt without retaining late errors or writing credentials", async () => {
  vi.useFakeTimers();
  const response = Promise.withResolvers<Response>();
  exchange = () => response.promise;
  const first = await providers.startOpenAiOAuth();
  const old = providers.submitOpenAiOAuthCallback(callback(first.authorizationUrl));
  const rejected = expect(old).rejects.toThrow("no longer active");
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  response.resolve(tokens(first.authorizationUrl));
  await rejected;
  expect(providers.openAiOAuthStatus()).toEqual({ pending: false });
  await unchanged();
});

it("checks cancellation again inside credential persistence after token verification", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const modify = credentials.modify.bind(credentials);
  vi.spyOn(credentials, "modify").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return modify(...args);
  });
  const first = await providers.startOpenAiOAuth();
  exchange = async () => tokens(first.authorizationUrl);
  const old = providers.submitOpenAiOAuthCallback(callback(first.authorizationUrl));
  const rejected = expect(old).rejects.toThrow();
  await entered.promise;
  providers.cancelOpenAiOAuth();
  const next = await providers.startOpenAiOAuth();
  release.resolve();
  await rejected;
  expect(providers.openAiOAuthStatus()).toEqual({ pending: true, authorizationUrl: next.authorizationUrl });
  await unchanged();
});

it("commits a current verified attempt once and permits a later reauthorization", async () => {
  const first = await providers.startOpenAiOAuth();
  exchange = async () => tokens(first.authorizationUrl);
  await providers.submitOpenAiOAuthCallback(callback(first.authorizationUrl));
  expect(await credentials.read("openai")).toMatchObject({
    type: "oauth",
    access: "test-access",
    clientId: "issued-client",
  });
  expect(providers.openAiOAuthStatus()).toEqual({ pending: false });
  const next = await providers.startOpenAiOAuth();
  expect(new URL(next.authorizationUrl).searchParams.get("client_id")).toBe("issued-client");
});
