import { afterEach, describe, expect, it } from "vitest";
import { startSignedIn, type TestServer } from "./helpers/server.ts";

let server: (TestServer & { totpSecret: string }) | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

describe("GET and PUT /api/settings/first-time-setup", () => {
  it('is not dismissed by default, saves "Don\'t show again" on the instance, and refuses anything but a boolean', async () => {
    server = await startSignedIn();
    const get = () => server!.client.get("/api/settings/first-time-setup");
    const put = (body: unknown) => server!.client.call("PUT", "/api/settings/first-time-setup", { body });
    expect((await get()).body).toEqual({ dismissed: false });
    expect((await put({ dismissed: true })).body).toEqual({ dismissed: true });
    expect((await get()).body).toEqual({ dismissed: true });
    expect((await put({ dismissed: false })).body).toEqual({ dismissed: false });
    for (const body of [{}, { dismissed: "yes" }, { dismissed: 1 }]) {
      const res = await put(body);
      expect([res.status, res.body.error.code], JSON.stringify(body)).toEqual([400, "bad_request"]);
    }
    expect((await server!.client.raw("GET", "/api/settings/first-time-setup", { cookie: false })).status).toBe(401);
  });
});
