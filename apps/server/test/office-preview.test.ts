import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { officePreview } from "../src/attachments/office-preview.ts";

const ok = <T>(value: T) => ({ ok: true as const, value });
function mockEnv() {
  return {
    createTempDir: vi.fn(async () => ok("/tmp/preview")),
    writeFile: vi.fn(async (_path: string, _content: string | Uint8Array, _ctx: unknown) => ok(undefined)),
    exec: vi.fn(async (_args: readonly string[], _options: unknown, _ctx: unknown) => ok({ exitCode: 0 })),
    readBinaryFile: vi.fn(async () => ok(new TextEncoder().encode("%PDF-1.7\n"))),
    remove: vi.fn(async () => ok(undefined)),
  };
}
afterEach(() => vi.restoreAllMocks());
describe("sandbox Office conversion", () => {
  it("passes arguments without a shell, uses a private profile, and cleans temporary files", async () => {
    const env = mockEnv();
    const bytes = await officePreview(env as unknown as ExecutionEnv, new Uint8Array([1, 2]), "docx");
    expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.7\n");
    expect(env.exec.mock.calls[0]![0]).toEqual(["python3", "/tmp/preview/convert.py", "/tmp/preview", "document.docx"]);
    expect(env.writeFile.mock.calls[1]![1]).toContain("DisableMacrosExecution");
    expect(env.writeFile.mock.calls[1]![1]).toContain("timeout=40");
    expect(env.remove).toHaveBeenCalledWith("/tmp/preview", { recursive: true, force: true }, expect.anything());
  });
  it("cleans up after a failed conversion and reports a readable error", async () => {
    const env = mockEnv();
    env.exec.mockResolvedValue(ok({ exitCode: 1 }));
    await expect(officePreview(env as unknown as ExecutionEnv, new Uint8Array(), "doc")).rejects.toMatchObject({
      status: 422,
      code: "preview_failed",
    });
    expect(env.readBinaryFile).not.toHaveBeenCalled();
    expect(env.remove).toHaveBeenCalled();
  });
  it("rejects a non-PDF converter output", async () => {
    const env = mockEnv();
    env.readBinaryFile.mockResolvedValue(ok(new TextEncoder().encode("<html>error</html>")));
    await expect(officePreview(env as unknown as ExecutionEnv, new Uint8Array(), "xls")).rejects.toMatchObject({
      status: 422,
    });
    expect(env.remove).toHaveBeenCalled();
  });
});
