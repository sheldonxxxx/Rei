// File helpers the backup bundle and the restore share: hashing, a one-way directory mirror and the walk that lists a
// tree. Everything is by streams and renames, so a crash leaves a `.partial` file at worst, never a half-written one
// under its real name.
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

export const PARTIAL = ".partial";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** Every regular file under `root` as a path relative to it, with forward slashes, sorted. Skips `.partial` leftovers. */
export function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (directory: string, relative: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), name);
      else if (entry.isFile() && !entry.name.endsWith(PARTIAL)) out.push(name);
    }
  };
  walk(root, "");
  return out.sort();
}

/** Removes empty directories below `root` (not `root` itself). */
export function pruneEmptyDirs(root: string): void {
  const walk = (directory: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    let empty = true;
    for (const entry of entries) {
      if (entry.isDirectory() && walk(join(directory, entry.name)))
        rmSync(join(directory, entry.name), { recursive: true });
      else empty = false;
    }
    return empty;
  };
  walk(root);
}

/**
 * Makes `to` hold what `from` holds, except the top-level names in `skip` and, at any depth, the names `exclude` picks
 * (neither copied nor deleted): a file is copied
 * when it is missing or its size or modification time differ, and a file only `to` has is removed when `deleteExtra`.
 * Symbolic links, sockets and the like are not followed or copied. Returns how many files were copied and removed.
 */
export async function mirrorTree(
  from: string,
  to: string,
  options: { skip?: ReadonlySet<string>; deleteExtra?: boolean; exclude?: (name: string) => boolean } = {},
): Promise<{ copied: number; removed: number }> {
  const skip = options.skip ?? new Set<string>();
  let copied = 0;
  let removed = 0;
  mkdirSync(to, { recursive: true });
  const walk = async (source: string, target: string, top: boolean): Promise<void> => {
    mkdirSync(target, { recursive: true });
    const entries = readdirSync(source, { withFileTypes: true }).filter(
      (e) => !(top && skip.has(e.name)) && !options.exclude?.(e.name),
    );
    const names = new Set(entries.map((e) => e.name));
    for (const entry of entries) {
      const s = join(source, entry.name);
      const t = join(target, entry.name);
      if (entry.isDirectory()) {
        if (existsSync(t) && !statSync(t).isDirectory()) rmSync(t, { force: true });
        await walk(s, t, false);
      } else if (entry.isFile()) {
        let info: ReturnType<typeof statSync>;
        try {
          info = statSync(s);
        } catch {
          continue; // gone since the listing
        }
        const have = existsSync(t) ? statSync(t) : undefined;
        if (have?.isFile() && have.size === info.size && Math.floor(have.mtimeMs) === Math.floor(info.mtimeMs))
          continue;
        if (have && !have.isFile()) rmSync(t, { recursive: true, force: true });
        const partial = `${t}${PARTIAL}`;
        try {
          await copyFile(s, partial);
        } catch {
          rmSync(partial, { force: true });
          continue; // removed while copying
        }
        utimesSync(partial, info.atime, info.mtime);
        renameSync(partial, t);
        copied++;
      }
    }
    if (options.deleteExtra) {
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        if (
          (top && skip.has(entry.name)) ||
          options.exclude?.(entry.name) ||
          names.has(entry.name) ||
          entry.name.endsWith(PARTIAL)
        )
          continue;
        rmSync(join(target, entry.name), { recursive: true, force: true });
        removed++;
      }
    }
  };
  await walk(from, to, true);
  return { copied, removed };
}

/** Writes a stream to `path` through a `.partial` file and a rename. */
export async function writeThrough(path: string, source: AsyncIterable<Uint8Array>): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}${PARTIAL}`;
  try {
    await pipeline(source as NodeJS.ReadableStream, createWriteStream(partial));
    renameSync(partial, path);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}
