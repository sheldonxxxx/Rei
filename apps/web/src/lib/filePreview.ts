/** Quoted CSV/TSV, including embedded newlines and escaped quotes. Bounded to keep previews responsive. */
export function previewRows(text: string, separator: string, maxRows = 200, maxColumns = 50) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    truncated = false;
  const pushCell = () => {
    if (row.length < maxColumns) row.push(cell);
    else truncated = true;
    cell = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted || cell === "") quoted = !quoted;
      else cell += c;
    } else if (!quoted && c === separator) pushCell();
    else if (!quoted && (c === "\n" || c === "\r")) {
      pushCell();
      rows.push(row);
      row = [];
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (rows.length >= maxRows) {
        truncated ||= i < text.length - 1;
        return { rows, truncated };
      }
    } else cell += c;
  }
  if (cell || row.length) {
    pushCell();
    rows.push(row);
  }
  return { rows, truncated };
}
export function decodePreview(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const encoding =
    view[0] === 0xff && view[1] === 0xfe ? "utf-16le" : view[0] === 0xfe && view[1] === 0xff ? "utf-16be" : "utf-8";
  return new TextDecoder(encoding).decode(view);
}

/** CSP comes first so a document cannot replace it with a weaker policy. Opaque-origin sandbox adds another boundary. */
export const htmlPreviewDocument = (text: string) =>
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer">${text}`;
