import type { Context } from "@earendil-works/chord/context";
import type { WorkspaceManager } from "../exec/workspaces.ts";
import type { LibraryService } from "../library/service.ts";
import type { AppStore, SessionRow } from "../store/store.ts";
import { fromBase64Url } from "../util/encoding.ts";
import type { BrowserUploadFile } from "./driver.ts";

export type UploadSource = { type: "library"; fileId: string; versionId: string } | { type: "sandbox"; path: string };

/**
 * The largest file the agent can hand to a website. The file is read whole into memory and passed to the browser over
 * DevTools, so this stays well under the 1 GiB upload limit; a larger Library file is still stored and downloadable.
 */
export const BROWSER_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const SIZE_ERROR = "Files uploaded to a website can be at most 25 MiB.";

// Open relative to directory descriptors. realpath followed by open can race a workspace directory being replaced
// with a symlink. No filename is interpolated into this program, and it emits at most one bounded base64 snapshot.
const READ_WORKSPACE_FILE = `
import base64, os, stat, sys

root, path, limit = sys.argv[1:]
limit = int(limit)
parts = path.split("/")
directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
directory = os.open(root, directory_flags)
try:
    for part in parts[:-1]:
        child = os.open(part, directory_flags, dir_fd=directory)
        os.close(directory)
        directory = child
    fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            sys.exit(2)
        if info.st_size > limit:
            sys.exit(3)
        data = file.read(limit + 1)
        if len(data) > limit:
            sys.exit(3)
        sys.stdout.buffer.write(base64.b64encode(data))
finally:
    os.close(directory)
`;

export async function readUploadSource(
  source: UploadSource,
  session: SessionRow,
  deps: { store?: AppStore; library?: LibraryService; workspaces?: WorkspaceManager },
  context: Context,
): Promise<BrowserUploadFile> {
  const caps = deps.store?.agentCapabilities(session.agent_id);
  if (source.type === "library") {
    if (caps && caps.library === "off") throw new Error("File Library access is disabled for this agent.");
    const library = deps.library;
    if (!library) throw new Error("The Library is unavailable.");
    const file = library.resolve(source);
    const row = library.attachments.row(file.id);
    if (!row) throw new Error("That file version is unavailable.");
    if (file.size > BROWSER_UPLOAD_MAX_BYTES) throw new Error(SIZE_ERROR);
    const bytes = await library.attachments.bytes(row, BROWSER_UPLOAD_MAX_BYTES);
    if (bytes.length !== file.size) throw new Error("The Library file has an unexpected size.");
    return { name: file.name, mediaType: file.mediaType, bytes };
  }

  if (caps && !caps.sandbox) throw new Error("Sandbox access is disabled for this agent.");
  const parts = source.path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\\0]/.test(part)))
    throw new Error("Use a relative path inside this agent's sandbox workspace.");
  const name = parts.at(-1)!;
  const backend = deps.workspaces?.forTree(session.tree_id);
  if (!backend) throw new Error("The execution sandbox is unavailable.");
  await backend.ready(session.tree_id);
  const env = backend.env(session.tree_id);
  const encodedLimit = Math.ceil(BROWSER_UPLOAD_MAX_BYTES / 3) * 4;
  const chunks: string[] = [];
  let length = 0;
  const result = await env.exec(
    ["/usr/bin/python3", "-I", "-c", READ_WORKSPACE_FILE, env.cwd, source.path, String(BROWSER_UPLOAD_MAX_BYTES)],
    {
      inheritEnv: false,
      timeout: 15,
      onOutput: (text, _context, { stream }) => {
        if (stream !== "stdout") return;
        length += text.length;
        if (length <= encodedLimit) chunks.push(text);
      },
    },
    context,
  );
  context.abortSignal?.throwIfAborted();
  if (length > encodedLimit || (result.ok && result.value.exitCode === 3)) throw new Error(SIZE_ERROR);
  if (!result.ok || result.value.exitCode !== 0)
    throw new Error("The sandbox file could not be opened. Use a regular workspace file without links.");
  const bytes = fromBase64Url(chunks.join(""));
  if (bytes.length > BROWSER_UPLOAD_MAX_BYTES) throw new Error(SIZE_ERROR);
  return { name, mediaType: "application/octet-stream", bytes };
}
