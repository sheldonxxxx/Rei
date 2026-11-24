import { describe, expect, it } from "vitest";
import { compareFindings, fingerprint } from "../../scripts/lint.mjs";

const diagnostic = (line = 2, path = "example.ts") => ({
  severity: "warning",
  category: "lint/suspicious/noExplicitAny",
  message: "Unexpected any.",
  location: { path, start: { line, column: 1 }, end: { line, column: 20 } },
});
const read = () => "// before\nlet value: any;\n// after";

describe("lint baseline", () => {
  it("allows an existing finding to move without allowing a new occurrence", () => {
    const d = diagnostic();
    const baseline = { [fingerprint(d, read)]: 1 };
    const moved = diagnostic(3);
    const movedSource = () => `// added header\n${read()}`;
    expect(compareFindings([moved], baseline, movedSource).added).toEqual([]);
    expect(compareFindings([moved, moved], baseline, movedSource).added).toEqual([moved]);
  });

  it("fails for changed source, different files, and new rules", () => {
    const d = diagnostic();
    const baseline = { [fingerprint(d, read)]: 1 };
    expect(compareFindings([d], baseline, () => read().replace("value", "other")).added).toEqual([d]);
    const other = diagnostic(2, "other.ts");
    expect(compareFindings([other], baseline, read).added).toEqual([other]);
    const rule = { ...d, category: "lint/suspicious/noDebugger" };
    expect(compareFindings([rule], baseline, read).added).toEqual([rule]);
  });

  it("never accepts parser errors, even if an exemption is supplied", () => {
    const d = { ...diagnostic(), severity: "error", category: "parse" };
    expect(compareFindings([d], { [fingerprint(d, read)]: 1 }, read).added).toEqual([d]);
  });

  it("pruning only retains findings that still exist and does not mutate the input", () => {
    const d = diagnostic();
    const key = fingerprint(d, read);
    const baseline = { [key]: 2, removed: 1 };
    expect(compareFindings([d], baseline, read)).toEqual({ added: [], current: { [key]: 1 } });
    expect(baseline).toEqual({ [key]: 2, removed: 1 });
  });
});
