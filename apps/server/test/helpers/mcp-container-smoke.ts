// Offline smoke entry point for a disposable container with the current src/test mounts.
// Uses only generated fixture state and the in-process fake gateway; never a live MCP account.
import assert from "node:assert/strict";
import type { McpProfile } from "@rei/protocol";
import { approve } from "./approvals.ts";
import { FakeMcpGateway, tool } from "./fake-mcp.ts";
import { startSignedIn } from "./server.ts";
import { chat } from "./sessions.ts";
import { callTool } from "./web.ts";

const gw = new FakeMcpGateway();
gw.add("con_smoke", "Smoke", [
  tool("read", "Fixture read", { readOnlyHint: true }),
  tool("write", "Fixture write"),
  tool("delete", "Fixture delete", { destructiveHint: true }),
]);
const server = await startSignedIn({ fetchImpl: gw.fetch, mcp: { gatewayUrl: "http://gateway.test" } });
try {
  const profile = async (value: McpProfile) => {
    const c = (await server.host.plane.mcp.list())[0]!;
    await server.host.plane.mcp.setProfile(c.id, value, c.providerIdentity!, c.mcpProfileRevision!, value === "yolo");
  };
  const first = await chat(server);
  assert.match((await callTool(server, first, "smoke__read", {})).last!.text, /Blocked:/);
  assert.equal(gw.calls.length, 0);
  await approve(server, first);
  assert.equal(gw.calls.length, 1);
  await profile("read_only");
  const second = await chat(server);
  assert.equal((await callTool(server, second, "smoke__read", {})).last!.isError, false);
  assert.match((await callTool(server, second, "smoke__write", {})).last!.text, /Blocked:/);
  assert.equal(gw.calls.length, 2);
  await approve(server, second);
  assert.equal(gw.calls.length, 3);
  await profile("yolo");
  assert.equal((await callTool(server, await chat(server), "smoke__delete", {})).last!.isError, false);
  assert.equal(gw.calls.length, 4);
  assert.equal(server.host.plane.approvals.listGrants().length, 0);
  console.log(
    "MCP offline container smoke passed: Always Ask, Read-only approval, YOLO destructive fixture; 4 exact effects, no standing grants.",
  );
} finally {
  await server.destroy();
}
