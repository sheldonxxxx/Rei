import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_MANIFEST_FORMAT, type BackupManifest } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { ResticSnapshot } from "../src/backup/restic.ts";
import { SCHEMA_VERSION } from "../src/db/schema.ts";
import { includesFor, parseParts, pickSnapshot, run, verifyBundle } from "../src/node/backup-cli.ts";
import { sha256Hex } from "../src/storage/file-object-store.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const snap = (id: string, time: string): ResticSnapshot => ({
  id,
  shortId: id.slice(0, 8),
  time,
  hostname: "rei",
  paths: ["/b"],
  tags: [],
});

describe("parseParts", () => {
  it("defaults to everything, keeps canonical order and rejects unknown parts", () => {
    expect(parseParts(undefined)).toEqual(["db", "files", "gateway", "objects"]);
    expect(parseParts("objects, db")).toEqual(["db", "objects"]);
    expect(() => parseParts("db,mail")).toThrow(/"mail"/);
  });
});

describe("includesFor", () => {
  it("asks restic for everything when every part is wanted, else the manifest and the parts", () => {
    expect(includesFor(["db", "files", "gateway", "objects"])).toBeUndefined();
    expect(includesFor(["db", "gateway"])).toEqual(["/manifest.json", "/db", "/gateway"]);
  });
});

describe("pickSnapshot", () => {
  const list = [
    snap("a1".repeat(32), "2026-01-01T00:00:00Z"),
    snap("b2".repeat(32), "2026-01-03T00:00:00Z"),
    snap("a9".repeat(32), "2026-01-02T00:00:00Z"),
  ];
  it("takes the newest for latest, and an id by prefix", () => {
    expect(pickSnapshot(list, "latest").id).toBe("b2".repeat(32));
    expect(pickSnapshot(list, "b2b2").id).toBe("b2".repeat(32));
    expect(pickSnapshot(list, "a1a1a1a1").id).toBe("a1".repeat(32));
  });
  it("explains an empty repository, an unknown id and an ambiguous one", () => {
    expect(() => pickSnapshot([], "latest")).toThrow(/no snapshots/);
    expect(() => pickSnapshot(list, "zz")).toThrow(/No snapshot "zz"/);
    expect(() => pickSnapshot(list, "a")).toThrow(/more than one/);
  });
});

describe("verifyBundle", () => {
  async function bundle(over: Partial<BackupManifest> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "rei-verify-"));
    cleanup.push(dir);
    mkdirSync(join(dir, "db"));
    const bytes = new TextEncoder().encode("database") as Uint8Array<ArrayBuffer>;
    writeFileSync(join(dir, "db", "app.sqlite"), bytes);
    const manifest: BackupManifest = {
      format: BACKUP_MANIFEST_FORMAT,
      app: "rei",
      appVersion: "1.0.0",
      schemaVersion: SCHEMA_VERSION,
      gatewayVersion: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      host: "rei",
      trigger: "manual",
      files: [{ path: "db/app.sqlite", size: bytes.byteLength, sha256: await sha256Hex(bytes) }],
      counts: {},
      ...over,
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    return dir;
  }

  it("accepts an intact bundle", async () => {
    expect((await verifyBundle(await bundle(), ["db"])).app).toBe("rei");
  });
  it("rejects something that is not a Rei backup, or one from a newer schema", async () => {
    const empty = mkdtempSync(join(tmpdir(), "rei-verify-"));
    cleanup.push(empty);
    await expect(verifyBundle(empty, ["db"])).rejects.toThrow(/not a Rei backup/);
    await expect(verifyBundle(await bundle({ app: "other" as "rei" }), ["db"])).rejects.toThrow(
      /not a Rei backup this version/,
    );
    await expect(verifyBundle(await bundle({ schemaVersion: SCHEMA_VERSION + 1 }), ["db"])).rejects.toThrow(
      /newer than this release/,
    );
  });
  it("catches a missing, resized or altered file, but only in the parts asked for", async () => {
    const dir = await bundle();
    writeFileSync(join(dir, "db", "app.sqlite"), "tampered!");
    await expect(verifyBundle(dir, ["db"])).rejects.toThrow(/wrong size|checksum/);
    await expect(verifyBundle(dir, ["files"])).resolves.toBeTruthy();
    const same = await bundle();
    writeFileSync(join(same, "db", "app.sqlite"), "dataXXXX");
    await expect(verifyBundle(same, ["db"])).rejects.toThrow(/checksum/);
    rmSync(join(same, "db"), { recursive: true });
    await expect(verifyBundle(same, ["db"])).rejects.toThrow(/missing/);
  });
});

describe("run", () => {
  it("prints usage and fails on an unknown command", async () => {
    const lines: string[] = [];
    expect(await run(["nope"], {}, (l) => lines.push(l))).toBe(2);
    expect(lines.join("\n")).toContain("usage");
    expect(await run([], {}, () => undefined)).toBe(0);
  });
  it("says what is wrong without a password, and for a bad --only", async () => {
    const lines: string[] = [];
    expect(await run(["snapshots", "--repo", "/nowhere"], {}, (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).toMatch(/password/);
    lines.length = 0;
    expect(await run(["fetch", "--only", "mail"], { RESTIC_PASSWORD: "x" }, (l) => lines.push(l))).toBe(1);
    expect(lines.join("\n")).toContain("--only takes");
  });
});
