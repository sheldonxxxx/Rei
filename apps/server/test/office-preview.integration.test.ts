import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { officePreview } from "../src/attachments/office-preview.ts";

// Explicit opt-in: exercises the actual installed LibreOffice, rather than making it a test prerequisite.
describe.skipIf(process.env.RUN_OFFICE_PREVIEW_TESTS !== "1")("real LibreOffice previews", () => {
  it.each([
    ["odt", "doc", "docx", "text", "<office:text><text:p>Preview document fixture</text:p></office:text>"],
    [
      "ods",
      "xls",
      "xlsx",
      "spreadsheet",
      '<office:spreadsheet><table:table table:name="Budget"><table:table-row><table:table-cell office:value-type="string"><text:p>Preview spreadsheet fixture</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>',
    ],
    [
      "odp",
      "ppt",
      "pptx",
      "presentation",
      '<office:presentation><draw:page draw:name="Slide 1"><draw:frame svg:width="20cm" svg:height="5cm" svg:x="2cm" svg:y="2cm"><draw:text-box><text:p>Preview presentation fixture</text:p></draw:text-box></draw:frame></draw:page></office:presentation>',
    ],
  ])(
    "renders %s and both old/new Office variants",
    async (odf, legacy, modern, kind, body) => {
      const dir = await mkdtemp(join(tmpdir(), "office-real-"));
      const ctx = BACKGROUND_CONTEXT;
      const env = new NodeExecutionEnv({ cwd: dir });
      const type = `application/vnd.oasis.opendocument.${kind}`;
      const xml = `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.2"><office:body>${body}</office:body></office:document-content>`;
      const manifest = `<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="${type}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
      const bytes = zipSync({
        mimetype: [strToU8(type), { level: 0 }],
        "content.xml": strToU8(xml),
        "META-INF/manifest.xml": strToU8(manifest),
      });
      try {
        await env.writeFile(`${dir}/fixture.${odf}`, bytes, ctx);
        for (const extension of [odf, legacy, modern]) {
          if (extension !== odf) {
            const converted = await env.exec(
              [
                "soffice",
                `-env:UserInstallation=file://${dir}/fixture-profile-${extension}`,
                "--headless",
                "--convert-to",
                extension,
                "--outdir",
                dir,
                `${dir}/fixture.${odf}`,
              ],
              { timeout: 40 },
              ctx,
            );
            expect(converted.ok && converted.value.exitCode === 0).toBe(true);
          }
          const source = extension === odf ? bytes : await readFile(`${dir}/fixture.${extension}`);
          const pdf = await officePreview(env, source, extension);
          expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
          expect(pdf.byteLength).toBeGreaterThan(500);
        }
      } finally {
        await env.cleanup(ctx);
        await rm(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
