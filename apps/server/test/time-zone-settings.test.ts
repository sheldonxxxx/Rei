import { afterEach, describe, expect, it } from "vitest";
import { startSignedIn, type TestServer } from "./helpers/server.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

describe("GET and PUT /api/settings/time-zone", () => {
  it("starts unset, saves a zone the server knows, and refuses one it does not", async () => {
    server = await startSignedIn();
    const get = () => server!.client.get("/api/settings/time-zone");
    const put = (body: unknown) => server!.client.call("PUT", "/api/settings/time-zone", { body });
    expect((await get()).body).toEqual({ timeZone: null });
    expect((await put({ timeZone: "Asia/Macau" })).body).toEqual({ timeZone: "Asia/Macau" });
    expect((await get()).body).toEqual({ timeZone: "Asia/Macau" });
    for (const body of [{}, { timeZone: "Not/AZone" }, { timeZone: 8 }, { timeZone: "" }]) {
      const res = await put(body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([400, "bad_request"]);
    }
    expect((await get()).body).toEqual({ timeZone: "Asia/Macau" });
    expect((await server!.client.raw("GET", "/api/settings/time-zone", { cookie: false })).status).toBe(401);
  });
});
