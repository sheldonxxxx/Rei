#!/usr/bin/env node
// Builds the npm package rei-ai from apps/cli: `npx rei-ai setup`, or `npm i -g rei-ai` and then `rei setup`.
//
//   node scripts/cli-package.mjs [--out <dir>] [--version <x.y.z>] [--tag <vX.Y.Z>] [--images <prefix>]
//                                [--refs <dir>] [--require-digests]
//
// It writes two things:
//   apps/cli/dist/rei.mjs   the CLI as one file (Clack bundled; no runtime dependencies), with the version written in
//                           (with --out, only the package's copy is written).
//   <out>                   the package (default apps/cli/dist/npm): package.json, dist/rei.mjs, assets/ (the compose
//                           files without the build overlays, the smoke scripts, edge/forward.mjs, garage/garage.toml,
//                           the list is apps/cli/src/asset-files.ts), README.md and LICENSE. `npm publish <out>` or
//                           `npm pack <out>` takes it from there.
//
// The compose files name each image as ${REI_IMAGES:-<prefix>}/rei-<name>:<version>, so a package runs the images of its
// own release; REI_IMAGES still points it at another registry. --images changes the default prefix. --refs reads the
// image-ref files the release's images-merge job writes (one per image, `name|registry/rei-name:version|sha256:…`) and
// pins each image to its digest (`…:<version>@sha256:…`), so what a package pulls cannot change after it is published.
// --require-digests fails unless every image is pinned. --tag fails unless the version equals the tag without its v.
//
// apps/cli stays a private workspace (@rei/cli) that ./rei runs as TypeScript; this folder is generated, never committed.
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { ASSET_FILES } from "../apps/cli/src/asset-files.ts";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const CLI = join(ROOT, "apps/cli");
const IMAGE_LINE = /^(\s*image:\s*)\$\{REI_IMAGES:-([^}]+)\}\/rei-([a-z]+):\$\{REI_VERSION:-dev\}\s*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const fail = (message) => {
  console.error(`cli-package: ${message}`);
  process.exit(1);
};

const { values: opts } = parseArgs({
  options: {
    out: { type: "string" },
    version: { type: "string" },
    tag: { type: "string" },
    images: { type: "string" },
    refs: { type: "string" },
    "require-digests": { type: "boolean", default: false },
  },
});

const rootManifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = opts.version ?? rootManifest.version;
if (!SEMVER.test(version)) fail(`not a release version: ${version}`);
if (opts.tag !== undefined && opts.tag !== `v${version}`)
  fail(`the version ${version} does not match the tag ${opts.tag}`);

/** name → { prefix, digest } from the release's image-ref files. */
function readRefs(dir) {
  const refs = new Map();
  for (const file of readdirSync(dir, { recursive: true })) {
    if (!String(file).endsWith(".txt")) continue;
    for (const line of readFileSync(join(dir, String(file)), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const [name, ref, digest] = line.trim().split("|");
      const match = /^(.+)\/rei-([a-z]+):(.+)$/.exec(ref ?? "");
      if (!match || match[2] !== name || !/^sha256:[0-9a-f]{64}$/.test(digest ?? ""))
        fail(`unexpected image ref in ${file}: ${line}`);
      if (match[3] !== version) fail(`${name} was pushed as ${match[3]}, but the package is ${version}`);
      refs.set(name, { prefix: match[1], digest });
    }
  }
  return refs;
}
const refs = opts.refs ? readRefs(resolve(opts.refs)) : new Map();

/** The base compose file with every Rei image named for this release (and pinned, when its digest is known). */
function pinImages(text, file, seen) {
  return text
    .split("\n")
    .map((line) => {
      const match = IMAGE_LINE.exec(line);
      if (!match) {
        if (/\$\{REI_VERSION/.test(line) && !line.trimStart().startsWith("#"))
          fail(`${file}: an image line this script does not understand: ${line.trim()}`);
        return line;
      }
      const [, lead, defaultPrefix, name] = match;
      const ref = refs.get(name);
      const prefix = ref?.prefix ?? opts.images ?? defaultPrefix;
      seen.add(name);
      if (opts["require-digests"] && !ref) fail(`no digest for rei-${name} (--refs)`);
      return `${lead}\${REI_IMAGES:-${prefix}}/rei-${name}:${version}${ref ? `@${ref.digest}` : ""}`;
    })
    .join("\n");
}

const out = resolve(opts.out ?? join(CLI, "dist/npm"));
// The folder is emptied first, so it must not hold the repository.
const above = relative(out, ROOT);
if (!above.startsWith("..") && !isAbsolute(above))
  fail("--out must be a folder of its own, not the repository or above it");

// ---- the bundle
const bundle = opts.out ? join(out, "dist/rei.mjs") : join(CLI, "dist/rei.mjs");
rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: [join(CLI, "src/main.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  legalComments: "eof",
  define: { __REI_CLI_VERSION__: JSON.stringify(version) },
  // Clack's dependencies are CommonJS; a bundled `require` of a Node built-in needs a real one.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __reiCreateRequire } from "node:module";\nconst require = __reiCreateRequire(import.meta.url);',
  },
  logLevel: "warning",
});
chmodSync(bundle, 0o755);

// ---- the package
mkdirSync(join(out, "dist"), { recursive: true });
if (!opts.out) copyFileSync(bundle, join(out, "dist/rei.mjs"));
chmodSync(join(out, "dist/rei.mjs"), 0o755);

const seen = new Set();
for (const asset of ASSET_FILES) {
  const target = join(out, "assets", asset.path);
  mkdirSync(dirname(target), { recursive: true });
  let text = readFileSync(join(ROOT, "containers", asset.path), "utf8");
  if (asset.path.endsWith(".yaml")) text = pinImages(text, asset.path, seen);
  writeFileSync(target, text);
  chmodSync(target, asset.mode);
}
const expected = ["browser", "control", "egress", "exec", "gateway", "reader"];
if ([...seen].sort().join() !== expected.join()) fail(`the compose files name images ${[...seen].sort().join(", ")}`);
for (const name of refs.keys()) if (!seen.has(name)) fail(`a digest for rei-${name}, which no compose file uses`);

copyFileSync(join(ROOT, "LICENSE"), join(out, "LICENSE"));
copyFileSync(join(CLI, "README.npm.md"), join(out, "README.md"));
const repository = rootManifest.repository ?? "https://github.com/sheldonxxxx/Rei";
const repoUrl = typeof repository === "string" ? repository : repository.url;
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "rei-ai",
      version,
      description:
        "Rei レイ, a personal AI workspace you run on your own computer: set it up and upgrade it with Docker.",
      license: "MIT",
      type: "module",
      bin: { rei: "dist/rei.mjs" },
      files: ["dist/", "assets/"],
      engines: { node: ">=26" },
      repository: { type: "git", url: `git+${repoUrl.replace(/^git\+/, "").replace(/(\.git)?$/, ".git")}` },
      homepage: repoUrl.replace(/^git\+/, "").replace(/\.git$/, ""),
      bugs: { url: `${repoUrl.replace(/^git\+/, "").replace(/\.git$/, "")}/issues` },
      keywords: ["ai", "agent", "self-hosted", "docker", "cli"],
    },
    null,
    2,
  )}\n`,
);
const pinned = refs.size ? `, ${refs.size} images pinned by digest` : "";
console.log(`rei-ai ${version} → ${relative(process.cwd(), out) || "."}${pinned}`);
