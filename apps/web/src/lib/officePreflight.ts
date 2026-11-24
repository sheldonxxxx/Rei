import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
export interface CellInfo {
  value: string;
  formula?: string;
  missingResult?: boolean;
}
export interface SheetInfo {
  name: string;
  cells: Record<string, CellInfo>;
}
export interface OfficePreflight {
  bytes: ArrayBuffer;
  sheets: SheetInfo[];
  missingResults: number;
}
const xmlText = (s: string) =>
  s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const names: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (names[entity]) return names[entity];
    try {
      return String.fromCodePoint(
        entity.startsWith("&#x") ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10),
      );
    } catch {
      return entity;
    }
  });
const attribute = (tag: string, name: string) =>
  xmlText(new RegExp(`(?:^|\\s)${name}=["']([^"']*)["']`).exec(tag)?.[1] ?? "");
export function prepareOfficePreview(input: ArrayBuffer, name: string): OfficePreflight {
  const bytes = new Uint8Array(input);
  if (
    /\.(docx|dotx|xlsx|xltx|xlsm|xltm|pptx|ppsx|potx)$/i.test(name) &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  )
    throw new Error(
      "This Office file is encrypted or uses an unsupported container. Download it and save an unencrypted copy to preview it.",
    );
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { bytes: input, sheets: [], missingResults: 0 };
  let total = 0,
    entries = 0;
  const zip = unzipSync(bytes, {
    filter: (file) => {
      total += file.originalSize;
      entries++;
      if (total > 100 * 1024 * 1024 || entries > 10_000 || file.originalSize > 32 * 1024 * 1024)
        throw new Error(
          "This document expands beyond the preview limits. Download the original or try compatibility preview.",
        );
      return true;
    },
  });
  let changed = false;
  // OOXML external relationships must never cause a preview to fetch remote content.
  for (const path of Object.keys(zip))
    if (path.endsWith(".rels")) {
      const xml = strFromU8(zip[path]!);
      const stripped = xml.replace(/<Relationship\b[^>]*\bTargetMode=["']External["'][^>]*\/\s*>/gi, "");
      if (stripped !== xml) {
        zip[path] = strToU8(stripped);
        changed = true;
      }
    }
  if (!/\.(xlsx|xltx|xlsm|xltm)$/i.test(name))
    return { bytes: changed ? new Uint8Array(zipSync(zip)).buffer : input, sheets: [], missingResults: 0 };
  const workbook = strFromU8(zip["xl/workbook.xml"] ?? new Uint8Array()),
    rels = strFromU8(zip["xl/_rels/workbook.xml.rels"] ?? new Uint8Array());
  const relationships = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) {
    const target = attribute(match[1]!, "Target");
    relationships.set(
      attribute(match[1]!, "Id"),
      target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`,
    );
  }
  const strings = strFromU8(zip["xl/sharedStrings.xml"] ?? new Uint8Array());
  const shared = Array.from(strings.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g), (m) =>
    Array.from(m[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g), (v) => xmlText(v[1]!)).join(""),
  );
  const sheets: SheetInfo[] = [];
  let missingResults = 0,
    count = 0;
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/g)) {
    const path = relationships.get(attribute(match[1]!, "r:id"));
    if (!path || !zip[path]) continue;
    const sheet: SheetInfo = { name: attribute(match[1]!, "name"), cells: {} };
    const xml = strFromU8(zip[path]!);
    const prepared = xml.replace(/<c\b([^>]*)>([\s\S]*?)<\/c>/g, (whole, attrs: string, body: string) => {
      if (++count > 200_000)
        throw new Error(
          "This workbook has too many cells for an interactive preview. Download the original or try compatibility preview.",
        );
      const address = attribute(attrs, "r"),
        type = attribute(attrs, "t");
      const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1];
      const hasFormula = /<f\b/.test(body),
        rawValue = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const missing = hasFormula && (rawValue === undefined || rawValue === "");
      const value =
        type === "s"
          ? (shared[Number(rawValue)] ?? "")
          : type === "inlineStr"
            ? Array.from(body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g), (m) => xmlText(m[1]!)).join("")
            : xmlText(rawValue ?? "");
      if (address)
        sheet.cells[address] = {
          value: missing ? "Value unavailable: no saved formula result" : value,
          ...(hasFormula ? { formula: xmlText(formula ?? "(shared formula)") } : {}),
          ...(missing ? { missingResult: true } : {}),
        };
      if (!missing) return whole;
      missingResults++;
      // Preview-only copy: a cached text marker prevents the engine from recalculating missing results.
      const updated = attrs.replace(/\s+t=["'][^"']*["']/g, "");
      return `<c${updated} t="str">${body.replace(/<v\b[^>]*>[\s\S]*?<\/v>|<v\s*\/>/g, "")}<v>Value unavailable: no saved formula result</v></c>`;
    });
    if (prepared !== xml) zip[path] = strToU8(prepared);
    sheets.push(sheet);
  }
  return { bytes: missingResults || changed ? new Uint8Array(zipSync(zip)).buffer : input, sheets, missingResults };
}

/** Legacy spreadsheet bytes stay unchanged. Reject uncached formulas before the renderer's recovery evaluator can run. */
export async function inspectSavedSpreadsheet(prepared: OfficePreflight): Promise<OfficePreflight> {
  const { read, utils } = await import("styled-exceljs");
  const workbook = read(prepared.bytes, { type: "array", cellFormula: true, sheetStubs: true });
  const sheets: SheetInfo[] = [];
  let count = 0;
  for (const name of workbook.SheetNames) {
    const cells: SheetInfo["cells"] = {};
    for (const [address, cell] of Object.entries(workbook.Sheets[name] ?? {})) {
      if (address.startsWith("!")) continue;
      if (++count > 200_000)
        throw new Error("This workbook has too many cells for direct preview. Try compatibility preview.");
      if (cell.f && (cell.t === "z" || cell.v === undefined || cell.v === null))
        throw new Error(
          "This workbook contains formulas without saved results. Direct preview cannot safely show them. Try compatibility preview or download the original.",
        );
      cells[address] = {
        value: cell.v === undefined ? "" : utils.format_cell(cell),
        ...(cell.f ? { formula: cell.f } : {}),
      };
    }
    sheets.push({ name, cells });
  }
  return { ...prepared, sheets };
}
