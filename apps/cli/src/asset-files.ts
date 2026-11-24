// The files an npm installation (rei-ai) carries in assets/ and writes into REI_HOME, with their modes. scripts/cli-package.mjs
// copies them from containers/ when it builds the package, so this list is the one place they are named. The compose
// files are the base files (no build overlay); the smoke scripts are what setup and doctor run against the sandbox and
// the browser. .env and .secrets/ are never among them: they belong to the installation.
export const ASSET_FILES: readonly { path: string; mode: number }[] = [
  { path: "compose.yaml", mode: 0o644 },
  { path: "compose.dodai.yaml", mode: 0o644 },
  { path: "edge/forward.mjs", mode: 0o644 },
  { path: "garage/garage.toml", mode: 0o644 },
  { path: "smoke-exec.sh", mode: 0o755 },
  { path: "smoke-browser.sh", mode: 0o755 },
];
