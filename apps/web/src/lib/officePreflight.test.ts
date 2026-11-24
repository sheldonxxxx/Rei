import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { inspectSavedSpreadsheet, prepareOfficePreview } from "./officePreflight.ts";

const book = (cells: string) =>
  new Uint8Array(
    zipSync({
      "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="旅費" r:id="rId1"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": strToU8(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`),
    }),
  ).buffer;
describe("Office preview preflight", () => {
  it("offers a clear recovery for encrypted modern Office containers while accepting legacy binary formats", () => {
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).buffer;
    expect(() => prepareOfficePreview(bytes, "encrypted.docx")).toThrow("unencrypted copy");
    expect(prepareOfficePreview(bytes, "legacy.doc").bytes).toBe(bytes);
  });
  it("preserves stored zero results and marks missing formula results in a preview-only copy", () => {
    const bytes = book('<c r="A1"><f>1-1</f><v>0</v></c><c r="B1"><f>SUM(A1:A2)</f><v/></c>');
    const result = prepareOfficePreview(bytes, "budget.xlsx");
    expect(result.missingResults).toBe(1);
    expect(result.sheets[0]?.cells.A1).toEqual({ value: "0", formula: "1-1" });
    expect(result.sheets[0]?.cells.B1).toMatchObject({ missingResult: true, formula: "SUM(A1:A2)" });
    expect(strFromU8(unzipSync(new Uint8Array(result.bytes))["xl/worksheets/sheet1.xml"]!)).toContain('t="str"');
    expect(strFromU8(unzipSync(new Uint8Array(bytes))["xl/worksheets/sheet1.xml"]!)).not.toContain("Value unavailable");
  });
  it("keeps ordinary files byte-identical and handles inline/shared text safely", () => {
    const bytes = book('<c r="A1" t="inlineStr"><is><t>&lt;script&gt;&amp;旅費</t></is></c>');
    const result = prepareOfficePreview(bytes, "budget.xlsx");
    expect(result.bytes).toBe(bytes);
    expect(result.sheets[0]?.cells.A1?.value).toBe("<script>&旅費");
    const plain = new TextEncoder().encode("%PDF-1.7").buffer;
    expect(prepareOfficePreview(plain, "report.pdf").bytes).toBe(plain);
  });
  it("removes external Office relationships only from the preview copy", () => {
    const original = new Uint8Array(
      zipSync({
        "word/_rels/document.xml.rels": strToU8(
          '<Relationships><Relationship Id="r1" Type="image" Target="https://outside.example/tracker" TargetMode="External"/><Relationship Id="r2" Target="media/image.png"/></Relationships>',
        ),
      }),
    ).buffer;
    const result = prepareOfficePreview(original, "report.docx");
    expect(strFromU8(unzipSync(new Uint8Array(result.bytes))["word/_rels/document.xml.rels"]!)).not.toContain(
      "outside.example",
    );
    expect(strFromU8(unzipSync(new Uint8Array(original))["word/_rels/document.xml.rels"]!)).toContain(
      "outside.example",
    );
  });
  it("rejects oversized expanded documents before decompressing their contents", () => {
    const zip = zipSync({ "large.xml": new Uint8Array(33 * 1024 * 1024) });
    expect(() => prepareOfficePreview(new Uint8Array(zip).buffer, "bomb.docx")).toThrow("expands beyond");
  });
});

it("checks legacy saved formula values without recalculation", async () => {
  const { write } = await import("styled-exceljs");
  const create = (cell: object) =>
    new Uint8Array(
      write(
        { SheetNames: ["Budget"], Sheets: { Budget: { A1: cell, "!ref": "A1" } } },
        { type: "array", bookType: "biff8" },
      ),
    ).buffer;
  const saved = create({ t: "n", v: 0, f: "1-1" });
  const result = await inspectSavedSpreadsheet({ bytes: saved, sheets: [], missingResults: 0 });
  expect(result.bytes).toBe(saved);
  expect(result.sheets[0]?.cells.A1?.value).toBe("0");
  const zip = unzipSync(
    new Uint8Array(
      write(
        { SheetNames: ["Budget"], Sheets: { Budget: { A1: { t: "n", v: 3, f: "SUM(1,2)" }, "!ref": "A1" } } },
        { type: "array", bookType: "xlsx" },
      ),
    ),
  );
  zip["xl/worksheets/sheet1.xml"] = strToU8(strFromU8(zip["xl/worksheets/sheet1.xml"]!).replace(/<v>3<\/v>/, ""));
  const uncached = new Uint8Array(zipSync(zip)).buffer;
  await expect(inspectSavedSpreadsheet({ bytes: uncached, sheets: [], missingResults: 0 })).rejects.toThrow(
    "without saved results",
  );
});
