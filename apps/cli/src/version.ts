// This CLI's version, and semantic-version order. The npm bundle has the version written in at build time
// (scripts/cli-package.mjs defines __REI_CLI_VERSION__); a checkout reads it from the root package.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";

declare const __REI_CLI_VERSION__: string | undefined;

export function cliVersion(root: string): string {
  if (typeof __REI_CLI_VERSION__ === "string") return __REI_CLI_VERSION__;
  try {
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export const isVersion = (text: string): boolean => SEMVER.test(text.trim());

/** Negative when a comes before b, 0 when equal, positive after (semver precedence; build metadata ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a.trim());
  const pb = SEMVER.exec(b.trim());
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  const [preA, preB] = [pa[4], pb[4]];
  if (preA === preB) return 0;
  // A pre-release comes before its release.
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  const ia = preA.split(".");
  const ib = preB.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
