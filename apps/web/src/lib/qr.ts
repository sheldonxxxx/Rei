import { create } from "qrcode";

export interface QrSvg {
  /** Side length in modules, including the quiet zone. */
  size: number;
  /** SVG path data: one 1x1 square per dark module. */
  path: string;
}

/** Builds a QR code as SVG path data (no canvas needed, so it works in the browser and in tests). */
export function qrSvg(text: string, quietZone = 2): QrSvg {
  const qr = create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  let path = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) path += `M${c + quietZone} ${r + quietZone}h1v1h-1z`;
    }
  }
  return { size: n + quietZone * 2, path };
}
