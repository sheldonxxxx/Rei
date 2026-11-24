// Writes the published client contract (docs/contract.md): OpenAPI for the REST routes and JSON Schema for the event
// streams, generated from packages/protocol/src/contract. `--check` fails when the committed files are stale.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openApiDocument, streamSchemaDocument } from "../packages/protocol/src/contract/generate.ts";
import { PROTOCOL_VERSION } from "../packages/protocol/src/contract/version.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "packages/protocol/generated");
const files = {
  "openapi.json": openApiDocument(PROTOCOL_VERSION),
  "stream.schema.json": streamSchemaDocument(PROTOCOL_VERSION),
};

const check = process.argv.includes("--check");
const stale = [];
mkdirSync(outDir, { recursive: true });
for (const [name, doc] of Object.entries(files)) {
  const path = join(outDir, name);
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {}
  if (current === text) continue;
  if (check) stale.push(name);
  else writeFileSync(path, text);
}
if (stale.length > 0) {
  console.error(`The generated contract is stale (${stale.join(", ")}). Run npm run contract and commit the result.`);
  process.exit(1);
}
if (!check) console.log(`Contract written to ${outDir}`);
