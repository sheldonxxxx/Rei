import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CODEX_IMAGES } from "../src/node/codex-auth.ts";
import { codexImagesSetup } from "../src/node/codex-signin.ts";
import { FileCredentialStore } from "../src/node/credstore.ts";

async function withStore(run: (store: FileCredentialStore) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "rei-img-signin-"));
  try {
    await run(new FileCredentialStore(join(dir, "images.json")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const credential = { type: "oauth" as const, access: "a", refresh: "r", expires: Date.now() + 3_600_000 };

it("shows the code, stays pending, then reports signed in once the login saves a credential", async () => {
  await withStore(async (store) => {
    const finish = Promise.withResolvers<void>();
    const setup = codexImagesSetup(store, async (target, showCode) => {
      showCode("ABCD-1234");
      await finish.promise;
      await target.modify(CODEX_IMAGES, async () => credential);
    });
    expect(await setup.status()).toEqual({ enabled: true, signedIn: false, pending: false });
    expect(await setup.start()).toEqual({
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    expect(await setup.status()).toMatchObject({ pending: true, userCode: "ABCD-1234", signedIn: false });
    await expect(setup.start()).rejects.toThrow("already in progress");
    finish.resolve();
    await expect.poll(async () => (await setup.status()).signedIn).toBe(true);
    expect(await setup.status()).toEqual({ enabled: true, signedIn: true, pending: false });
  });
});

it("reports why a sign-in ended and lets a new one start", async () => {
  await withStore(async (store) => {
    let fail = true;
    const setup = codexImagesSetup(store, async (_target, showCode) => {
      showCode("CODE-1");
      if (fail) throw new Error("Codex device approval failed (HTTP 500).");
    });
    await setup.start();
    await expect.poll(async () => (await setup.status()).error).toBe("Codex device approval failed (HTTP 500).");
    expect((await setup.status()).pending).toBe(false);
    fail = false;
    await setup.start();
    expect((await setup.status()).error).toBeUndefined();
  });
});

it("rejects start when the code could not be requested, and cancel stops a waiting attempt quietly", async () => {
  await withStore(async (store) => {
    const refused = codexImagesSetup(store, async () => {
      throw new Error("Codex device sign-in could not start (HTTP 403).");
    });
    await expect(refused.start()).rejects.toThrow("HTTP 403");
    expect((await refused.status()).pending).toBe(false);

    const setup = codexImagesSetup(
      store,
      (_target, showCode, signal) =>
        new Promise<void>((_resolve, reject) => {
          showCode("WAIT-1");
          signal?.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    await setup.start();
    setup.cancel();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await setup.status()).toEqual({ enabled: true, signedIn: false, pending: false });
  });
});

it("signs out by deleting the saved credential", async () => {
  await withStore(async (store) => {
    await store.modify(CODEX_IMAGES, async () => credential);
    const setup = codexImagesSetup(store);
    expect((await setup.status()).signedIn).toBe(true);
    await setup.signOut();
    expect((await setup.status()).signedIn).toBe(false);
  });
});

it("serves sign-in over authenticated gateway routes, and reports off when not configured", async () => {
  await withStore(async (store) => {
    const { createGatewayApp } = await import("../src/core/proxy.ts");
    const { createRedactor } = await import("../src/core/redact.ts");
    const { nullLogger } = await import("@rei/logging");
    const make = (codexImagesSetup_?: ReturnType<typeof codexImagesSetup>) =>
      createGatewayApp({
        standin: "standin",
        ...(codexImagesSetup_ ? { codexImagesSetup: codexImagesSetup_ } : {}),
        tokens: { accessToken: async () => "", status: async () => ({ signedIn: false, accessExpiresInS: null }) },
        calls: { insert() {}, byStep: () => [], recent: () => [], summary: () => [], lastUsed: () => new Map() },
        models: () => [],
        version: "test",
        upstreams: [],
        redactor: createRedactor(),
        log: nullLogger,
      });
    const call = (app: ReturnType<typeof make>, method: string, path: string) =>
      app.request(path, { method, headers: { authorization: "Bearer standin" } });

    const off = make();
    expect((await off.request("/setup/codex-images")).status).toBe(401);
    expect(await (await call(off, "GET", "/setup/codex-images")).json()).toEqual({
      enabled: false,
      signedIn: false,
      pending: false,
    });
    expect((await call(off, "POST", "/setup/codex-images/signin")).status).toBe(404);

    const on = make(codexImagesSetup(store, async (_t, showCode) => showCode("ROUTE-1")));
    const started = await call(on, "POST", "/setup/codex-images/signin");
    expect(await started.json()).toEqual({
      userCode: "ROUTE-1",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    expect((await call(on, "DELETE", "/setup/codex-images/signin")).status).toBe(204);
    expect((await call(on, "DELETE", "/setup/codex-images")).status).toBe(204);
  });
});
