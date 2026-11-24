import { fileURLToPath } from "node:url";
import { fileViewerRenderers } from "@file-viewer/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { APP_TITLE } from "./src/lib/brand.ts";

// The dev server proxies the API (including the SSE streams) to the app server. In production the app server serves dist/.
export default defineConfig({
  plugins: [
    {
      name: "rei-title",
      transformIndexHtml: (html) => html.replace(/<title>.*?<\/title>/, `<title>${APP_TITLE}</title>`),
    },
    react(),
    tailwindcss(),
    fileViewerRenderers({
      renderers: ["word", "spreadsheet", "presentation", "pdf"],
      inject: false,
      copyAssets: { baseDir: "file-viewer" },
      scan: false,
    }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: process.env.REI_API ?? "http://localhost:8787", changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
