import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselinePath = new URL("../lint-baseline.json", import.meta.url);

/** Match exact source findings, allowing line shifts but never extra occurrences. */
export function fingerprint(diagnostic, readSource) {
  const path = diagnostic.location?.path;
  if (typeof path !== "string" || !diagnostic.location.start || !diagnostic.location.end) {
    throw new Error(`Cannot baseline diagnostic without a source location: ${diagnostic.category}`);
  }
  const source = readSource(path).split(/\r?\n/);
  const { start, end } = diagnostic.location;
  // Include surrounding lines so identical tokens in unrelated code cannot consume an old exemption.
  const context = source.slice(Math.max(0, start.line - 2), end.line + 1).join("\n");
  const hash = createHash("sha256").update(`${diagnostic.message}\n${context}`).digest("hex").slice(0, 24);
  return `${path}:${diagnostic.category}:${hash}`;
}

export function compareFindings(diagnostics, baseline, readSource) {
  const remaining = { ...baseline };
  const current = {};
  const added = [];
  for (const diagnostic of diagnostics) {
    if (!["warning", "error", "fatal"].includes(diagnostic.severity)) continue;
    // Parsing, configuration and tool failures must never become accepted debt.
    if (!diagnostic.category.startsWith("lint/")) {
      added.push(diagnostic);
      continue;
    }
    const key = fingerprint(diagnostic, readSource);
    current[key] = (current[key] ?? 0) + 1;
    if ((remaining[key] ?? 0) > 0) remaining[key]--;
    else added.push(diagnostic);
  }
  return { added, current };
}

function main(args) {
  const prune = args.includes("--prune");
  const paths = args.filter((arg) => arg !== "--prune");
  if (paths.some((path) => path.startsWith("-"))) throw new Error("Expected file paths, not Biome options");
  if (prune && paths.length) throw new Error("Pruning requires a full repository scan");
  const biome = resolve(root, "node_modules/@biomejs/biome/bin/biome");
  const result = spawnSync(
    process.execPath,
    [
      biome,
      "lint",
      "--reporter=json",
      "--max-diagnostics=none",
      "--no-errors-on-unmatched",
      "--",
      ...(paths.length ? paths : ["."]),
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    throw result.error ?? new Error(result.stderr || `Biome failed (${result.signal ?? result.status})`);
  }
  const report = JSON.parse(result.stdout);
  if (!Array.isArray(report.diagnostics) || !report.summary || report.summary.diagnosticsNotPrinted > 0) {
    throw new Error("Biome did not return a complete diagnostic report");
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const sources = new Map();
  const readSource = (path) => {
    if (!sources.has(path)) sources.set(path, readFileSync(resolve(root, path), "utf8"));
    return sources.get(path);
  };
  const { added, current } = compareFindings(report.diagnostics, baseline.findings, readSource);
  for (const diagnostic of added) {
    const location = diagnostic.location;
    console.error(
      `${location?.path ?? "biome"}:${location?.start?.line ?? 1} ${diagnostic.category}: ${diagnostic.message}`,
    );
  }
  if (added.length) {
    console.error(`${added.length} new lint finding(s). Fix them or add a narrowly explained inline suppression.`);
    process.exitCode = 1;
    return;
  }
  // Nonzero exit with no diagnostics means an execution failure, not a clean scan.
  if (result.status !== 0 && report.summary.errors === 0)
    throw new Error(result.stderr || "Biome failed without diagnostics");
  if (prune) {
    baseline.findings = current;
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  }
  const accepted = Object.values(current).reduce((sum, count) => sum + count, 0);
  console.log(`Lint passed; ${accepted} existing finding(s) matched the adoption baseline. See docs/code-quality.md.`);
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    // lint-staged passes absolute paths; normalize them for stable baseline keys.
    main(process.argv.slice(2).map((arg) => (isAbsolute(arg) ? relative(root, arg).split(sep).join("/") : arg)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
