// Skills as .zip files (fflate): import checks sizes before inflating anything, and export puts the files in one
// folder named after the skill. Core logic only: bytes in, bytes out.
import { SKILL_LIMITS, type SkillFile } from "@rei/protocol";
import { unzipSync, zipSync } from "fflate";
import { Invalid } from "../util/errors.ts";
import { bytesOf, checkPath, fileFromBytes, SKILL_MD } from "./parse.ts";

export const ZIP_MAX_COMPRESSED = 5_000_000;

/** The unix mode of every entry in the central directory, by name (fflate does not give it), to refuse symlinks. */
function symlinkNames(zip: Uint8Array): string[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out: string[] = [];
  for (let n = 0; n < count && p + 46 <= zip.length && view.getUint32(p, true) === 0x02014b50; n++) {
    const madeBy = view.getUint16(p + 4, true) >> 8;
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const mode = view.getUint32(p + 38, true) >>> 16;
    // Host 3 is unix: the high 16 bits of the external attributes are st_mode.
    if (madeBy === 3 && (mode & 0o170000) === 0o120000)
      out.push(new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const junk = (name: string): boolean =>
  name.startsWith("__MACOSX/") || name.includes("/__MACOSX/") || name === ".DS_Store" || name.endsWith("/.DS_Store");

/** The files of a skill zip: SKILL.md at the top or inside exactly one folder (which is dropped). Not yet validated as a skill. */
export function importZip(zip: Uint8Array, rootFile = SKILL_MD): SkillFile[] {
  if (zip.length > ZIP_MAX_COMPRESSED)
    throw new Invalid(`The zip is larger than ${Math.round(ZIP_MAX_COMPRESSED / 1_000_000)} MB.`);
  const links = symlinkNames(zip);
  if (links.length > 0) throw new Invalid(`The zip contains a symbolic link ("${links[0]}"), which is not allowed.`);
  let total = 0;
  let entries = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(zip, {
      // Sizes are in the directory: refuse before anything is inflated.
      filter: (file) => {
        if (file.name.endsWith("/") || junk(file.name)) return false;
        entries++;
        if (entries > SKILL_LIMITS.files) throw new Invalid(`A skill can have at most ${SKILL_LIMITS.files} files.`);
        total += file.originalSize;
        if (total > SKILL_LIMITS.totalBytes)
          throw new Invalid(
            `The zip is larger than ${Math.round(SKILL_LIMITS.totalBytes / 1_000_000)} MB when unpacked.`,
          );
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Invalid) throw error;
    throw new Invalid("That file is not a valid .zip.");
  }
  const names = Object.keys(raw);
  for (const name of names) {
    if (name.startsWith("/") || /^[a-zA-Z]:/.test(name))
      throw new Invalid(`The zip has an absolute path ("${name}"), which is not allowed.`);
  }
  let prefix = "";
  if (!names.includes(rootFile)) {
    const tops = new Set(names.map((n) => n.split("/")[0]!));
    const only = tops.size === 1 ? [...tops][0]! : undefined;
    if (only === undefined || !names.includes(`${only}/${rootFile}`) || names.some((n) => !n.startsWith(`${only}/`))) {
      throw new Invalid("The zip needs SKILL.md at the top or inside one folder, with nothing outside that folder.");
    }
    prefix = `${only}/`;
  }
  return names.map((name) => fileFromBytes(checkPath(name.slice(prefix.length)), raw[name]!));
}

/** The zip of a skill version: one folder named after the skill. `at` is the modified time of every entry. */
export function exportZip(name: string, files: readonly SkillFile[], at: number): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[`${name}/${f.path}`] = bytesOf(f);
  return zipSync(entries, { mtime: new Date(Math.max(at, Date.UTC(1980, 0, 1))) });
}
