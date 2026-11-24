import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The control plane must be portable to Cloudflare Workers (D29/D31): outside src/node (and the Node entry point),
// only Web APIs, Hono and the Pi / protocol packages (and pure-JS parsers: linkedom, yaml, fflate) may be used.
// js-tiktoken joins that list for the token counting in pi/home-context.ts and usage/context-breakdown.ts, for the two
// entry points named in TIKTOKEN_ENTRIES below. Scope of that allowance, stated exactly: the last test here reads the
// files reachable through relative imports from those two entry points in the installed package and finds no node:
// import, no require(), no Buffer./process., no __dirname/__filename. That is not a proof about the whole package: it
// covers what these entry points actually pull in, on the locked version, and nothing about Workers bundle limits
// (the o200k rank table alone is ~2.3 MB) or the package's unused code paths. Adding a rank means adding it here, and
// the last test then inspects it, because the guard is driven by the same list.
const SRC = fileURLToPath(new URL("../src", import.meta.url));

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

const portable = files(SRC).filter((f) => {
  const rel = relative(SRC, f);
  return !rel.startsWith("node/") && rel !== "main.ts";
});

const importsOf = (text: string): string[] =>
  [
    ...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => (m[1] ?? m[2])!);

/** The exact js-tiktoken entry points the portable sources may import; the allowance and the guard below share this list. */
const TIKTOKEN_ENTRIES = ["js-tiktoken/lite", "js-tiktoken/ranks/o200k_base"];

describe("Workers-safety", () => {
  it("finds the portable sources", () => {
    expect(portable.length).toBeGreaterThan(15);
  });

  it("imports no node: built-in and no Node-only package outside src/node", () => {
    const bad: string[] = [];
    const allowed = (spec: string) =>
      spec.startsWith(".") ||
      spec === "hono" ||
      spec.startsWith("hono/") ||
      spec.startsWith("@rei/") ||
      spec.startsWith("@earendil-works/") ||
      spec === "linkedom" ||
      spec === "@mozilla/readability" ||
      spec === "yaml" ||
      spec === "fflate" ||
      TIKTOKEN_ENTRIES.includes(spec);
    for (const file of portable) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        if (spec.startsWith("node:") || !allowed(spec)) bad.push(`${relative(SRC, file)} imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps relative imports inside the portable part, except through src/node by interface", () => {
    const bad: string[] = [];
    for (const file of portable) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        if (spec.startsWith(".") && /(^|\/)node\//.test(spec)) bad.push(`${relative(SRC, file)} imports ${spec}`);
        if (spec.startsWith(".") && !spec.endsWith(".ts"))
          bad.push(`${relative(SRC, file)}: import ${spec} lacks the .ts extension`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("does not reach for Node globals", () => {
    const bad: string[] = [];
    const globals =
      /\b(process\.(env|cwd|pid|on|exit|nextTick|hrtime|stdout|stderr)|Buffer\.|__dirname|__filename|require\()/;
    for (const file of portable) {
      const text = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      const m = globals.exec(text);
      if (m) bad.push(`${relative(SRC, file)}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });

  it("limits the Pi storage opener (the one place Pi's SQLite binding is chosen) to src/node", () => {
    const text = readFileSync(join(SRC, "node", "pi-storage.ts"), "utf8");
    expect(text).toMatch(/node:sqlite|openStorage|sqlite/i);
  });

  it("keeps the js-tiktoken allowance honest: the files those entry points reach stay free of Node", () => {
    // What the portable sources import must be exactly the listed entry points: no extra rank slips in, and the guard
    // below always covers the code that is really used.
    const used = [
      ...new Set(
        portable.flatMap((f) => importsOf(readFileSync(f, "utf8")).filter((s) => s.startsWith("js-tiktoken/"))),
      ),
    ].sort();
    expect(used).toEqual([...TIKTOKEN_ENTRIES].sort());
    // Walk up to the installed package, then follow its own exports map to the ESM file each entry point resolves to,
    // and keep walking the relative imports from there: lite.js re-exports a shared chunk, so the entry files alone
    // would not be the whole graph. Chunk names are build hashes, so they are discovered, never hard-coded.
    let root = "";
    for (let dir = fileURLToPath(new URL(".", import.meta.url)); ; dir = dirname(dir)) {
      const manifest = join(dir, "node_modules", "js-tiktoken", "package.json");
      if (existsSync(manifest)) {
        root = dirname(manifest);
        break;
      }
      if (dirname(dir) === dir) throw new Error("js-tiktoken is not installed");
    }
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      exports: Record<string, { default?: string } | string>;
    };
    const nodeOnly = /(?:from\s+["']|require\(["']|import\(["'])node:|\bBuffer\.|\bprocess\.|__dirname|__filename/;
    const seen = new Set<string>();
    const queue = TIKTOKEN_ENTRIES.map((spec) => {
      const target = pkg.exports[spec.replace("js-tiktoken", ".")];
      expect(target, `${spec} is missing from the package exports map`).toBeDefined();
      return join(root, typeof target === "string" ? target : target!.default!);
    });
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      expect(nodeOnly.test(text), `${relative(root, file)} reached for Node`).toBe(false);
      for (const m of text.matchAll(/from\s+["'](\.\/[^"']+)["']/g)) queue.push(join(dirname(file), m[1]!));
    }
    expect(seen.size, "the entry points pull in more than themselves").toBeGreaterThan(TIKTOKEN_ENTRIES.length);
  });
});
