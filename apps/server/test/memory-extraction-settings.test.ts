import { afterEach, describe, expect, it } from "vitest";
import { startSignedIn, type TestServer } from "./helpers/server.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

describe("GET and PUT /api/settings/memory-extraction", () => {
  it("is off by default, turns on and off, and refuses anything but true or false", async () => {
    server = await startSignedIn();
    const get = () => server!.client.get("/api/settings/memory-extraction");
    const put = (body: unknown) => server!.client.call("PUT", "/api/settings/memory-extraction", { body });
    expect((await get()).body).toEqual({ enabled: false, everyNTurns: 5 });
    expect((await put({ enabled: true })).body).toEqual({ enabled: true, everyNTurns: 5 });
    expect((await get()).body).toEqual({ enabled: true, everyNTurns: 5 });
    expect((await put({ enabled: false })).body).toEqual({ enabled: false, everyNTurns: 5 });
    for (const body of [
      { everyNTurns: 1 },
      { everyNTurns: 101 },
      { everyNTurns: 2.5 },
      { enabled: "yes" },
      { enabled: 1 },
    ]) {
      const res = await put(body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([400, "bad_request"]);
    }
    expect((await server!.client.raw("GET", "/api/settings/memory-extraction", { cookie: false })).status).toBe(401);
  });
});
