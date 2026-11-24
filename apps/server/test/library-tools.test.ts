import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tool } from "./helpers/approvals.ts";
import { until } from "./helpers/client.ts";
import { type ExecServer, startExecServer } from "./helpers/exec.ts";
import { chat, detail, homeChat, say, settled, stepPayloads, workspaceOf } from "./helpers/sessions.ts";

let server: ExecServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
describe("Library native tools", () => {
  it("publishes a workspace deliverable, attaches it to the assistant, and stages it in another chat", async () => {
    const s = (server = await startExecServer({ socket: false, proxy: false }));
    const id = await chat(s);
    const cwd = join(s.root, workspaceOf(s, id));
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "report.html"), "<h1>Delivered report</h1>");
    await say(s, id, tool("publish_files", { files: [{ path: "report.html", mediaType: "text/html" }] }));
    const done = await settled(s, id);
    expect(done.runs[0]?.status).toBe("completed");
    const a = done.messages.find((m) => m.role === "assistant")?.attachments?.[0];
    expect(a).toMatchObject({ name: "report.html", mediaType: "text/html" });
    expect(a?.fileId).toBeTruthy();
    const library = s.host.plane.adapter.attachments!.library!;
    expect(library.detail(a!.fileId!).file.origin).toBe("agent");
    const target = await chat(s);
    await say(s, target, tool("read_library_file", { fileId: a!.fileId, versionId: a!.versionId }));
    await settled(s, target);
    expect(stepPayloads(s, target).join()).toContain("Delivered report");
    await s.client.raw("DELETE", `/api/sessions/${id}`);
    expect(library.detail(a!.fileId!).file.current.versionId).toBe(a!.versionId);
  });
  it("reads only the start of a large text file and streams a large binary into the sandbox", async () => {
    server = await startExecServer({ socket: false, proxy: false });
    const s = server;
    const id = await chat(s);
    const cwd = join(s.root, workspaceOf(s, id));
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "log.txt"), `${"line of a long log\n".repeat(20_000)}THE END`);
    // Over several of the copy's chunks, so the staged file is assembled from appends.
    const binary = new Uint8Array(9 * 1024 * 1024 + 123);
    for (let i = 0; i < binary.length; i += 4096) binary[i] = i % 251;
    writeFileSync(join(cwd, "data.bin"), binary);
    await say(s, id, tool("publish_files", { files: [{ path: "log.txt" }, { path: "data.bin" }] }));
    const done = await settled(s, id);
    const [log, data] = done.messages.find((m) => m.role === "assistant")!.attachments!;

    const target = await chat(s);
    await say(s, target, tool("read_library_file", { fileId: log!.fileId, versionId: log!.versionId }));
    await settled(s, target);
    const text = stepPayloads(s, target).join();
    expect(text).toContain('\\"truncated\\":true');
    expect(text).not.toContain("THE END");

    const other = await chat(s);
    await say(s, other, tool("read_library_file", { fileId: data!.fileId, versionId: data!.versionId }));
    await settled(s, other);
    const staged = /\.library\/[^"\\]+data\.bin/.exec(stepPayloads(s, other).join())![0];
    const copy = readFileSync(join(s.root, workspaceOf(s, other), staged));
    expect(copy.length).toBe(binary.length);
    expect(createHash("sha256").update(copy).digest("hex")).toBe(createHash("sha256").update(binary).digest("hex"));
  });
  it("delivers worker-published files to the parent report", async () => {
    const s = (server = await startExecServer({ socket: false, proxy: false }));
    const id = homeChat(s);
    const cwd = join(s.root, workspaceOf(s, id));
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "worker.txt"), "Worker deliverable");
    await say(s, id, `[spawn: ${tool("publish_files", { files: [{ path: "worker.txt" }] })}]`);
    const report = await until(
      async () => (await detail(s, id)).messages.find((m) => m.role === "report" && m.report?.files?.length),
      20_000,
      "report with published file",
    );
    const file = report.report!.files![0]!;
    expect(report.attachments?.[0]?.fileId).toBe(file.fileId);
    expect(await (await s.client.raw("GET", `/api/sessions/${id}/attachments/${file.id}`)).text()).toBe(
      "Worker deliverable",
    );
  });
  it("rejects paths and symlinks outside the workspace", async () => {
    const s = (server = await startExecServer({ socket: false, proxy: false }));
    const id = await chat(s);
    const cwd = join(s.root, workspaceOf(s, id));
    mkdirSync(cwd, { recursive: true });
    const outside = join(s.dir, "outside.txt");
    writeFileSync(outside, "not a deliverable");
    symlinkSync(outside, join(cwd, "escape.txt"));
    await say(s, id, tool("publish_files", { files: [{ path: join(cwd, "escape.txt") }] }));
    await settled(s, id);
    expect(stepPayloads(s, id).join()).toContain("inside this agent's workspace");
    expect(s.host.plane.adapter.attachments!.library!.list().files).toHaveLength(0);
  });
});
