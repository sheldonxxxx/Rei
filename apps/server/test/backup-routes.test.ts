import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeRestic } from "./helpers/backup.ts";
import { startSignedIn, startTestServer, type TestServer } from "./helpers/server.ts";

let server: TestServer | undefined;
let scratch: string | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

async function start(withFolder: boolean) {
  scratch = mkdtempSync(join(tmpdir(), "rei-backup-route-"));
  const repositoryDir = join(scratch, "repo");
  const stagingDir = join(scratch, "staging");
  mkdirSync(repositoryDir);
  mkdirSync(stagingDir);
  const restic = new FakeRestic();
  server = await startSignedIn({
    backup: {
      ...(withFolder ? { repositoryDir, stagingDir } : {}),
      restic: (o) => {
        restic.password = o.password;
        return restic;
      },
    },
  });
  return { server, restic };
}

describe("backup settings routes", () => {
  it("need a signed-in session", async () => {
    server = await startTestServer({});
    const response = await server.client.raw("GET", "/api/settings/backups", { cookie: false });
    expect(response.status).toBe(401);
  });

  it("report that backups are not available when the stack has no backup folder", async () => {
    const { server } = await start(false);
    const read = await server.client.get("/api/settings/backups");
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ available: false, repository: "none" });
    expect((await server.client.call("PUT", "/api/settings/backups", { body: { enabled: true } })).status).toBe(409);
    expect((await server.client.post("/api/settings/backups/run")).status).toBe(409);
  });

  it("set up a repository, run a backup and show it in the history", async () => {
    const { server, restic } = await start(true);
    const client = server.client;
    const password = await client.post("/api/settings/backups/password");
    expect(password.status).toBe(200);
    expect(password.body.password).toMatch(/^[a-z2-7-]+$/);
    const created = await client.post("/api/settings/backups/repository", { mode: "create", confirmed: true });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ available: true, repository: "ready" });
    expect(JSON.stringify(created.body)).not.toContain(password.body.password);
    expect(restic.password).toBe(password.body.password);

    const saved = await client.call("PUT", "/api/settings/backups", {
      body: { enabled: true, time: "04:15", retention: { daily: 5, weekly: 3, monthly: 2 } },
    });
    expect(saved.body).toMatchObject({ enabled: true, time: "04:15", retention: { daily: 5, weekly: 3, monthly: 2 } });
    expect(saved.body.nextRunAt).toBeGreaterThan(Date.now());
    expect((await client.call("PUT", "/api/settings/backups", { body: { time: "4pm" } })).status).toBe(400);

    const started = await client.post("/api/settings/backups/run");
    expect(started.status).toBe(200);
    await server.host.plane.backup.idle();
    const after = await client.get("/api/settings/backups");
    expect(after.body.lastRun).toMatchObject({ status: "ok", trigger: "manual", bytesAdded: 1234 });
    expect(after.body.history).toHaveLength(1);
    expect(restic.retentions[0]).toEqual({ daily: 5, weekly: 3, monthly: 2 });

    const forgotten = await client.call("DELETE", "/api/settings/backups/repository");
    expect(forgotten.body).toMatchObject({ repository: "none", enabled: false });
  });

  it("explain a repository that cannot be opened", async () => {
    const { server, restic } = await start(true);
    restic.failOn = "snapshots";
    const response = await server.client.post("/api/settings/backups/repository", {
      mode: "connect",
      password: "nope",
    });
    expect(response.status).toBe(422);
    expect(response.body.error?.code ?? response.body.code).toBe("repository_failed");
  });
});
