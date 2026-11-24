// containers/.env is a deployment: data roots, model path, signing key, origins. These tests pin that a CLI write can
// only land when the whole file survives, and that a file the run cannot read is never silently replaced.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envKeys, setDotenv } from "../src/dotenv.ts";
import { writeEnvText } from "../src/env-file.ts";
import { realHost } from "../src/real.ts";
import { makeRig, ROOT } from "./fakes.ts";

const ENV = `${ROOT}/containers/.env`;

/** A real deployment's file, in miniature: keys the CLI has no idea about. */
const DEPLOY =
  [
    "COMPOSE_PROFILES=searxng",
    "REI_DATA_ROOT=/srv/rei-data",
    "REI_BACKUP_ROOT=/srv/rei-data/backups",
    "REI_MODELS_PATH=/srv/omlx",
    "REI_PROJECT=rei",
    "REI_CONTROL_ORIGIN=https://mac.example:18443",
    "REI_TRUSTED_PROXIES=192.168.65.0/28",
    "REI_MODEL_MODE=faux",
    "REI_SECRET_KEY=signing-key-value",
    "REI_TZ=Asia/Macau",
  ].join("\n") + "\n";

const failure = (run: () => unknown): string => {
  try {
    run();
    return "";
  } catch (error) {
    return String((error as Error).message);
  }
};

const tempFiles = (paths: Iterable<string>) => [...paths].filter((p) => p.includes(".tmp-"));

describe("env file filesystem security", () => {
  it.each([0o600, 0o640, 0o644, undefined])("preserves mode %s, defaulting new files to 0600", (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "rei-env-test-"));
    try {
      const { ctx } = makeRig();
      ctx.host = realHost();
      const path = join(dir, ".env");
      if (mode !== undefined) ctx.host.writeText(path, DEPLOY, mode);
      const backup = writeEnvText(ctx, path, DEPLOY, envKeys(DEPLOY));
      expect(ctx.host.stat(path)?.mode).toBe(mode ?? 0o600);
      if (backup) expect(ctx.host.stat(backup)?.mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores backup and temporary env files at root and in nested directories", () => {
    const paths = [
      ".env.bak-abcd",
      ".env.tmp-abcd",
      "containers/.env.bak-abcd",
      "containers/.env.tmp-abcd",
      "containers/local.env.bak-abcd",
      "containers/local.env.tmp-abcd",
    ];
    const ignored = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: new URL("../../../", import.meta.url),
      input: paths.join("\n") + "\n",
      encoding: "utf8",
    });
    expect(ignored.trim().split("\n")).toEqual(paths);
  });
});

describe("the env file is replaced only when the whole file survives", () => {
  it("keeps every key it was not told to change, and keeps a copy of what it replaced", () => {
    const { ctx, host } = makeRig();
    host.writeText(ENV, DEPLOY, 0o644);
    let next = setDotenv(DEPLOY, "REI_PUBLISH", "127.0.0.1:8788");
    next = setDotenv(next, "REI_LOG_LEVEL", "debug");
    const backup = writeEnvText(ctx, ENV, next, envKeys(DEPLOY));
    expect(backup).toBeTruthy();
    const written = host.readText(ENV)!;
    for (const key of envKeys(DEPLOY)) expect(written, `lost ${key}`).toContain(`${key}=`);
    expect(written).toContain("REI_SECRET_KEY=signing-key-value");
    expect(written).toContain("REI_DATA_ROOT=/srv/rei-data");
    expect(written).toContain("REI_PUBLISH=127.0.0.1:8788");
    expect(host.files.get(backup!)!.text).toBe(DEPLOY);
    expect(host.files.get(backup!)!.mode).toBe(0o600);
    expect(tempFiles(host.files.keys())).toEqual([]);
  });

  it("refuses a write that drops keys, leaves the file it protects alone, and says where the copy is", () => {
    const { ctx, host } = makeRig();
    host.writeText(ENV, DEPLOY, 0o644);
    const stub = "COMPOSE_PROFILES=searxng\n";
    const message = failure(() => writeEnvText(ctx, ENV, stub, envKeys(DEPLOY)));
    expect(message).toContain("drops 9 key(s)");
    expect(message).toContain("REI_SECRET_KEY");
    expect(message).toContain(ENV);
    expect(message).toContain(".bak-");
    expect(host.readText(ENV)).toBe(DEPLOY);
    expect(tempFiles(host.files.keys())).toEqual([]);
  });

  it("refuses when the bytes it wrote do not read back", () => {
    const { ctx, host } = makeRig();
    host.writeText(ENV, DEPLOY, 0o644);
    const real = host.writeText.bind(host);
    host.writeText = (path: string, text: string, mode?: number) =>
      real(path, path.includes(".tmp-") ? text.slice(0, 40) : text, mode);
    const message = failure(() => writeEnvText(ctx, ENV, setDotenv(DEPLOY, "REI_LOG_LEVEL", "debug"), envKeys(DEPLOY)));
    expect(message).toContain("did not read back");
    expect(host.readText(ENV)).toBe(DEPLOY);
    expect(tempFiles(host.files.keys())).toEqual([]);
  });
});
