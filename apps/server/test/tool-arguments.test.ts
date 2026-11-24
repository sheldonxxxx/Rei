import { afterEach, describe, expect, it } from "vitest";
import { withConciseArgumentErrors } from "../src/pi/policy-ext.ts";
import { conciseArgumentError, toolFields } from "../src/pi/tool-arguments.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat } from "./helpers/sessions.ts";
import { callTool } from "./helpers/web.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const fields = toolFields({
  type: "object",
  properties: { action: { type: "string" }, path: { type: "string" }, body: { type: "string" }, _activity: {} },
  required: ["action", "path"],
});

describe("argument errors the model sees", () => {
  const validation = [
    'Validation failed for tool "knowledge_write":',
    "  - action: missing",
    "  - _action: unknown field",
    "",
    "Received arguments:",
    JSON.stringify({ _action: "create", path: "p", body: "long ".repeat(500) }, null, 2),
  ].join("\n");

  it("drops the echoed arguments and names the accepted fields for a missing or unknown field", () => {
    const text = conciseArgumentError(validation, fields);
    expect(text).not.toContain("Received arguments");
    expect(text).not.toContain("long long");
    expect(text).toContain("  - action: missing");
    expect(text.split("\n").at(-1)).toBe("Accepted fields: action (required), path (required), body.");
  });

  it("gives no hint for a nested or type error, and cuts a JSON parse error's echo too", () => {
    const nested = 'Validation failed for tool "t":\n  - edits.0.oldText: missing\n\nReceived arguments:\n{}';
    expect(conciseArgumentError(nested, fields)).toBe('Validation failed for tool "t":\n  - edits.0.oldText: missing');
    const parse = 'Invalid arguments for tool "t": Unexpected end of JSON input\n\nReceived arguments:\n{"body": "abc';
    expect(conciseArgumentError(parse, fields)).toBe('Invalid arguments for tool "t": Unexpected end of JSON input');
  });

  it("rewrites only invalid_arguments diagnostics", () => {
    const result = {
      isError: true,
      diagnostics: [
        { severity: "error", code: "invalid_arguments", message: validation },
        { severity: "warn", code: "other", message: "x\n\nReceived arguments:\n{}" },
      ],
    };
    const out = withConciseArgumentErrors(result, fields);
    expect(out.diagnostics[0]!.message).not.toContain("Received arguments");
    expect(out.diagnostics[1]).toBe(result.diagnostics[1]);
    const untouched = { isError: false, diagnostics: [] };
    expect(withConciseArgumentErrors(untouched, fields)).toBe(untouched);
  });

  it("reports a missing field without echoing the call", async () => {
    server = await startSignedIn();
    const id = await chat(server);
    const big = "y".repeat(2_000);
    const failed = await callTool(server, id, "demo_read_web", { address: big });
    expect(failed.last!.isError).toBe(true);
    expect(failed.last!.text).toContain("url: missing");
    expect(failed.last!.text).toContain("Accepted fields: url (required).");
    expect(failed.last!.text).not.toContain(big);
    expect(failed.last!.text).not.toContain("Received arguments");
  });
});
