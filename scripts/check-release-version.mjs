// The release workflow's version gate: `node scripts/check-release-version.mjs <tag> [--root <dir>]`.
//
// Fails unless the tag is `vX.Y.Z` or `vX.Y.Z-suffix` and its version, without the `v`, equals the `version` of the
// root package.json and of every workspace package.json. On success it prints `version=…`, `minor=…` and
// `prerelease=true|false` lines, which the workflow appends to $GITHUB_OUTPUT.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAG = /^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)$/;

const args = process.argv.slice(2);
const rootFlag = args.indexOf("--root");
const root =
  rootFlag === -1 ? join(dirname(fileURLToPath(import.meta.url)), "..") : resolve(args.splice(rootFlag, 2)[1] ?? ".");
const tag = args[0] ?? "";

function fail(message) {
  console.error(`check-release-version: ${message}`);
  process.exit(1);
}

const match = TAG.exec(tag);
if (!match) fail(`tag "${tag}" is not vX.Y.Z or vX.Y.Z-suffix.`);
const [, version, major, minor, , suffix] = match;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const rootManifest = readJson(join(root, "package.json"));

// Workspaces are `dir/*` patterns (`packages/*`, `apps/*`) or plain directories.
const manifests = [{ name: rootManifest.name ?? "(root)", path: "package.json", version: rootManifest.version }];
for (const pattern of rootManifest.workspaces ?? []) {
  const parent = pattern.endsWith("/*") ? pattern.slice(0, -2) : null;
  const dirs = parent
    ? existsSync(join(root, parent))
      ? readdirSync(join(root, parent), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(parent, entry.name))
      : []
    : [pattern];
  for (const dir of dirs.sort()) {
    const path = join(dir, "package.json");
    if (!existsSync(join(root, path))) continue;
    const manifest = readJson(join(root, path));
    manifests.push({ name: manifest.name ?? dir, path, version: manifest.version });
  }
}

const wrong = manifests.filter((manifest) => manifest.version !== version);
if (wrong.length > 0) {
  const lines = wrong.map((manifest) => `  ${manifest.path} (${manifest.name}): ${manifest.version ?? "no version"}`);
  fail(`tag ${tag} needs version ${version}, but these manifests differ:\n${lines.join("\n")}`);
}

console.log(`version=${version}`);
console.log(`minor=${major}.${minor}`);
console.log(`prerelease=${suffix ? "true" : "false"}`);
