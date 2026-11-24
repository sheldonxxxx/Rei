import { fileURLToPath } from "node:url";
import { build, mergeConfig } from "vite";
import web from "../../web/vite.config.ts";

const viewer = fileURLToPath(new URL(".", import.meta.url));
const webDir = fileURLToPath(new URL("../../web/", import.meta.url));
const output = fileURLToPath(new URL("../app/build/generated/documentViewer/viewer/", import.meta.url));
// Build from the web workspace so the renderer plugin resolves its installed runtime assets.
process.chdir(webDir);
await build(
  mergeConfig(web, {
    root: viewer,
    configFile: false,
    publicDir: false,
    build: { outDir: output, emptyOutDir: true, target: "es2022" },
  }),
);
