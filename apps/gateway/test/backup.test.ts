// GET /backup: the gateway's state as files, for the control plane's backups. Admin scope only, never on the shared app.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "@rei/logging";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayBackup } from "../src/core/backup.ts";
import { createGatewayApps } from "../src/core/proxy.ts";
import { createRedactor } from "../src/core/redact.ts";
import { gatewayBackup } from "../src/node/backup.ts";
import { SqliteCallLog } from "../src/node/calllog.ts";
import { dataPaths } from "../src/node/config.ts";

const REI = "rei-token-0123456789abcdef";

let dir: string;
let calls: SqliteCallLog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gateway-backup-"));
  calls = new SqliteCallLog(dataPaths(dir).callsDb);
});
afterEach(() => {
  calls.close();
  rmSync(dir, { recursive: true, force: true });
});

function apps(withBackup: boolean) {
  const paths = dataPaths(dir);
  mkdirSync(paths.secretDir, { recursive: true });
  writeFileSync(join(paths.secretDir, "credentials.json"), '{"openai":{"access":"a"}}');
  writeFileSync(join(paths.secretDir, "gateway-state.json"), '{"callers":[]}');
  writeFileSync(join(paths.secretDir, "notes.txt"), "not state");
  writeFileSync(paths.modelsFile, '{"accepted":["m"]}');
  return createGatewayApps({
    standin: REI,
    tokens: { accessToken: async () => "x", status: async () => ({ signedIn: false, accessExpiresInS: null }) },
    calls,
    models: () => [],
    version: "0.0.0-test",
    upstreams: [],
    redactor: createRedactor(),
    log: createLogger({ service: "gateway", level: "error", write: () => {} }),
    ...(withBackup
      ? {
          backup: gatewayBackup({
            dataDir: dir,
            secretDir: paths.secretDir,
            modelsFile: paths.modelsFile,
            calls,
            version: "0.0.0-test",
          }),
        }
      : {}),
  });
}

const get = (app: { fetch: (r: Request) => Response | Promise<Response> }, token?: string) =>
  app.fetch(new Request("http://gateway/backup", token ? { headers: { authorization: `Bearer ${token}` } } : {}));

describe("GET /backup", () => {
  it("returns the secret files, models.json and a consistent copy of calls.sqlite", async () => {
    calls.insert({
      caller: "rei",
      stepId: "s1",
      model: "m",
      startedAt: Date.now(),
      status: 200,
    } as unknown as Parameters<typeof calls.insert>[0]);
    const res = await get(apps(true).internal, REI);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GatewayBackup;
    expect(body.files.map((f) => f.path)).toEqual([
      "secret/credentials.json",
      "secret/gateway-state.json",
      "models.json",
      "calls.sqlite",
    ]);
    for (const file of body.files) {
      const bytes = Buffer.from(file.data, "base64");
      expect(bytes.byteLength).toBe(file.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    }
    expect(readFileSync(join(dataPaths(dir).secretDir, "credentials.json"), "utf8")).toBe(
      Buffer.from(body.files[0]!.data, "base64").toString("utf8"),
    );
    // The database copy opens and holds the row.
    const copy = join(dir, "copy.sqlite");
    writeFileSync(copy, Buffer.from(body.files.find((f) => f.path === "calls.sqlite")!.data, "base64"));
    const db = new DatabaseSync(copy);
    expect((db.prepare("SELECT COUNT(*) AS n FROM calls").get() as { n: number }).n).toBe(1);
    db.close();
    // No scratch files are left in the data directory.
    expect(readFileSync(join(dir, "models.json"), "utf8")).toContain("accepted");
  });

  it("needs the admin scope and does not exist on the shared app", async () => {
    const both = apps(true);
    expect((await get(both.internal)).status).toBe(401);
    expect((await get(both.internal, "wrong-token-0123456789")).status).toBe(401);
    expect((await get(both.shared, REI)).status).toBe(404);
  });

  it("answers 503 when the gateway has no backup source", async () => {
    const res = await get(apps(false).internal, REI);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("backup_unavailable");
  });
});
