import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { HttpError } from "../util/errors.ts";

// Runs only inside the execution sandbox. No shell interpolation of document names or contents.
const CONVERT = `import os, pathlib, signal, subprocess, sys
root = pathlib.Path(sys.argv[1])
profile = root / 'profile'
(profile / 'user').mkdir(parents=True)
(profile / 'user' / 'registrymodifications.xcu').write_text('''<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item></oor:items>''')
p = subprocess.Popen(['soffice', '-env:UserInstallation=' + profile.as_uri(), '--headless', '--norestore', '--nodefault', '--convert-to', 'pdf', '--outdir', str(root), str(root / sys.argv[2])], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
try:
    code = p.wait(timeout=40)
except subprocess.TimeoutExpired:
    os.killpg(p.pid, signal.SIGKILL)
    p.wait()
    sys.exit(1)
output = root / 'document.pdf'
if code != 0 or not output.is_file() or output.stat().st_size > 25 * 1024 * 1024:
    sys.exit(1)
`;

/**
 * The largest document a preview converts. LibreOffice gets 40 seconds, which a larger document rarely fits, and the
 * file is copied into the sandbox first; past this the original download is the answer.
 */
export const OFFICE_PREVIEW_MAX_BYTES = 100 * 1024 * 1024;
export const officePreviewTooLarge = () =>
  new HttpError(
    413,
    "preview_too_large",
    "This file is too large to preview (over 100 MiB). It is still stored, and you can download the original.",
  );

/**
 * Converts a document to PDF in the sandbox. `source` is the document's bytes, or a function that writes them to the
 * path it is given (so a stored file can be streamed there) and answers whether it could.
 */
export async function officePreview(
  env: ExecutionEnv,
  source: Uint8Array | ((path: string) => Promise<boolean>),
  extension: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const ctx = BACKGROUND_CONTEXT;
  const temp = await env.createTempDir("rei-preview-", ctx);
  if (!temp.ok)
    throw new HttpError(
      503,
      "preview_unavailable",
      "The preview sandbox is unavailable. You can still download the original.",
    );
  const dir = temp.value;
  try {
    const name = `document.${extension}`;
    const staged =
      source instanceof Uint8Array
        ? (await env.writeFile(`${dir}/${name}`, source, ctx)).ok
        : await source(`${dir}/${name}`);
    if (!staged || !(await env.writeFile(`${dir}/convert.py`, CONVERT, ctx)).ok) throw new Error("stage");
    const converted = await env.exec(["python3", `${dir}/convert.py`, dir, name], { timeout: 50 }, ctx);
    if (!converted.ok || converted.value.exitCode !== 0) throw new Error("convert");
    const pdf = await env.readBinaryFile(`${dir}/document.pdf`, ctx);
    if (!pdf.ok || pdf.value.length > 25 * 1024 * 1024 || new TextDecoder().decode(pdf.value.slice(0, 5)) !== "%PDF-")
      throw new Error("output");
    return new Uint8Array(pdf.value);
  } catch {
    throw new HttpError(
      422,
      "preview_failed",
      "This Office file could not be previewed. It may be protected, damaged, or the sandbox may need LibreOffice installed. You can still download the original.",
    );
  } finally {
    await env.remove(dir, { recursive: true, force: true }, ctx);
  }
}
