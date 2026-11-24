import { afterEach, describe, expect, it } from "vitest";
import { startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const s = (): TestServer => server!;
const network = () => s().client.get("/api/settings/sandbox-network");
const put = (body: unknown) => s().client.call("PUT", "/api/settings/sandbox-network", { body });

describe("the sandbox network whitelist", () => {
  it("starts with the repository and registry defaults", async () => {
    server = await startSignedIn();
    const res = await network();
    expect(res.status).toBe(200);
    expect(res.body.defaults).toEqual([
      "pypi.org",
      "files.pythonhosted.org",
      "registry.npmjs.org",
      "github.com",
      "objects.githubusercontent.com",
      "codeload.github.com",
    ]);
    expect(res.body.whitelist).toEqual(res.body.defaults);
  });

  it("saves a normalized list, keeps it across a restart, and resets to the defaults", async () => {
    server = await startSignedIn();
    const saved = await put({
      whitelist: ["  Internal.Example.COM. ", "internal.example.com", "*.Corp.example", "10.0.0.0/8", "192.168.1.5"],
    });
    expect(saved.status).toBe(200);
    const expected = ["internal.example.com", "*.corp.example", "10.0.0.0/8", "192.168.1.5"];
    expect(saved.body.whitelist).toEqual(expected);

    const { dir, totpSecret } = server;
    const cookie = s().client.cookie;
    await s().stop();
    server = Object.assign(await startTestServer({ dir }), { totpSecret });
    s().client.cookie = cookie;
    expect((await network()).body.whitelist).toEqual(expected);

    const reset = await put({ reset: true });
    expect(reset.status).toBe(200);
    expect(reset.body.whitelist).toEqual(reset.body.defaults);
    expect((await network()).body.whitelist).toEqual(reset.body.defaults);
  });

  it("refuses a bad list with a reason and leaves the saved one alone", async () => {
    server = await startSignedIn();
    expect((await put({ whitelist: ["ok.example"] })).status).toBe(200);
    const bad: unknown[] = [
      {},
      { whitelist: "x" },
      { whitelist: [1] },
      { whitelist: ["bad host"] },
      { whitelist: ["10.0.0.0/33"] },
      { whitelist: ["*"] },
      { whitelist: [""] },
      { whitelist: ["a..b"] },
      { whitelist: Array.from({ length: 201 }, (_, i) => `h${i}.example`) },
    ];
    for (const body of bad) {
      const res = await put(body);
      expect([res.status, res.body.error?.code], JSON.stringify(body).slice(0, 60)).toEqual([400, "bad_request"]);
    }
    expect((await network()).body.whitelist).toEqual(["ok.example"]);
  });
});
