import { describe, expect, it } from "vitest";
import { flattenResult } from "../src/core/mcp/flatten.ts";

describe("typed MCP media", () => {
  it("retains embedded bytes and text, keeps resource links as references, and never fetches", () => {
    const result = flattenResult({
      content: [
        { type: "text", text: "result" },
        { type: "resource", resource: { uri: "file:///report.html", mimeType: "text/html", text: "<h1>Report</h1>" } },
        { type: "resource", resource: { uri: "file:///data.bin", mimeType: "application/octet-stream", blob: "YWJj" } },
        { type: "resource_link", uri: "https://private.example/file" },
      ],
    });
    expect(result.media).toEqual([
      { type: "resource", mimeType: "text/html", text: "<h1>Report</h1>", uri: "file:///report.html" },
      { type: "resource", mimeType: "application/octet-stream", data: "YWJj", uri: "file:///data.bin" },
    ]);
    expect(result.text).toContain("https://private.example/file");
    expect(result.text).not.toContain("<h1>");
  });
  it("separates binary limits from text limits, caps media count, and flags omissions", () => {
    const image = { type: "image", mimeType: "image/png", data: "YWJj".repeat(40_000) };
    const result = flattenResult({ content: [image] });
    expect(result.media?.[0]?.data).toBe(image.data);
    expect(result.truncated).toBe(false);
    const many = flattenResult({ content: Array(11).fill(image) });
    expect(many.media).toHaveLength(10);
    expect(many.truncated).toBe(true);
    const huge = flattenResult({ content: [{ ...image, data: "A".repeat(35_000_000) }] });
    expect(huge.media).toBeUndefined();
    expect(huge.truncated).toBe(true);
  });
});
