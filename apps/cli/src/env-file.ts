// containers/.env, written so a deployment cannot be lost by a partial edit.

import { randomBytes } from "node:crypto";
import type { Ctx } from "./ctx.ts";
import { envKeys } from "./dotenv.ts";

/**
 * Replace the deployment's env file, verified.
 *
 * That file is the deployment: the data roots the containers mount, the model path, the signing key, the browser
 * origins. A writer that rebuilds it from the keys a command happens to know erases every other line, and a stack that
 * reads defaults (./data, a dev signing key, localhost origins) starts an empty deployment without complaining. So the
 * copy being replaced is kept, the new text is written beside it, read back, and required to carry every key the caller
 * says must survive, and only then is it moved into place. Anything less leaves the target alone and says where the
 * copy is.
 *
 * @param preserveKeys every key `path` currently declares that the new text must still declare.
 * @returns the path holding the bytes that were replaced, when there were any.
 */
export function writeEnvText(
  ctx: Ctx,
  path: string,
  next: string,
  preserveKeys: readonly string[],
): string | undefined {
  const tag = randomBytes(4).toString("hex");
  const current = ctx.host.readText(path) ?? "";
  const mode = ctx.host.stat(path)?.mode ?? 0o600;
  const backup = `${path}.bak-${tag}`;
  if (current === "") {
    // Nothing to protect: this is a new file, and the caller already asked before creating one.
  } else {
    ctx.host.writeText(backup, current, 0o600);
  }
  const tmp = `${path}.tmp-${tag}`;
  ctx.host.writeText(tmp, next, mode);
  const written = ctx.host.readText(tmp);
  if (written === undefined || written !== next) {
    ctx.host.remove(tmp);
    throw new Error(
      `${path} was not written: the new text did not read back. The file in place is unchanged${current === "" ? "" : `; the copy is at ${backup}`}`,
    );
  }
  const present = new Set(envKeys(written));
  const lost = preserveKeys.filter((key) => !present.has(key));
  if (lost.length > 0) {
    ctx.host.remove(tmp);
    throw new Error(
      `refusing to replace ${path}: the new text drops ${lost.length} key(s) the current file has (${lost.slice(0, 8).join(", ")}${lost.length > 8 ? ", …" : ""}). The file in place is unchanged${current === "" ? "" : `; the copy is at ${backup}`}`,
    );
  }
  ctx.host.rename(tmp, path);
  return current === "" ? undefined : backup;
}
