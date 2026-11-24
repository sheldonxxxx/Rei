// Discovery in the Trace (issue 07): a search step's details, each model call's offered tools and their change with the
// search that caused it, and a "capabilities changed" step on a run that sees a connector change.

import type { StepDetailResponse } from "@rei/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeMcpGateway, tool } from "./helpers/fake-mcp.ts";
import { startSignedIn, type TestServer } from "./helpers/server.ts";
import { chat, settled } from "./helpers/sessions.ts";
import { callTool } from "./helpers/web.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const NOTES = [
  tool("search_notes", "Search the user's notes by text.", { readOnlyHint: true }),
  tool("add_note", "Create a new note."),
];

interface StepRow {
  id: string;
  type: string;
  tool_name: string | null;
  summary: string | null;
}
const steps = (s: TestServer, id: string) =>
  s.host.plane.store.db.all<StepRow>(
    "SELECT id, type, tool_name, summary FROM steps WHERE session_id = ? ORDER BY started_at, id",
    id,
  );
const detail = async (s: TestServer, stepId: string) =>
  (await s.client.get(`/api/steps/${stepId}`)).body as StepDetailResponse;

describe("discovery in the Trace", () => {
  it("records what a search searched, ranked and loaded, and why", async () => {
    server = await startSignedIn();
    const s = server;
    const id = await chat(s);
    await callTool(s, id, "search_capabilities", { query: "schedule a weekly reminder" });
    const search = steps(s, id).find((r) => r.tool_name === "search_capabilities")!;
    const d = await detail(s, search.id);
    expect(d.tool?.discovery?.query).toBe("schedule a weekly reminder");
    expect(d.tool?.discovery?.loaded).toContainEqual({ name: "create_trigger", reason: "group", group: "triggers" });
    expect(d.tool?.discovery?.candidates[0]).toMatchObject({ kind: "tool" });
  });

  it("shows each model call's offered tools, and attributes a load to the search step that made it", async () => {
    server = await startSignedIn();
    const s = server;
    const id = await chat(s);
    await callTool(s, id, "search_capabilities", { load: ["triggers"] });
    const rows = steps(s, id);
    const calls = rows.filter((r) => r.type === "llm.call");
    const search = rows.find((r) => r.tool_name === "search_capabilities")!;
    const first = await detail(s, calls[0]!.id);
    expect(first.llm?.tools?.previousStepId).toBeUndefined();
    expect(first.llm?.tools?.offered).toContain("search_capabilities");
    expect(first.llm?.tools?.offered).not.toContain("create_trigger");
    const second = await detail(s, calls[1]!.id);
    expect(second.llm?.tools?.previousStepId).toBe(calls[0]!.id);
    expect(second.llm?.tools?.offered).toContain("create_trigger");
    expect(second.llm?.tools?.added).toContainEqual({
      name: "create_trigger",
      loadedBy: search.id,
      reason: "load",
      group: "triggers",
    });
    expect(second.llm?.tools?.removed).toEqual([]);
    // Each call records which of its tools were loaded, so the context breakdown can tell them from the core tools.
    const loaded = (stepId: string) =>
      JSON.parse(
        s.host.plane.store.db.get<{ loaded_tools: string }>("SELECT loaded_tools FROM steps WHERE id = ?", stepId)!
          .loaded_tools,
      ) as string[];
    expect(loaded(calls[0]!.id)).toEqual([]);
    expect(loaded(calls[1]!.id)).toContain("create_trigger");
    expect(loaded(calls[1]!.id)).not.toContain("search_capabilities");
  });

  it("puts a capabilities-changed step on a run that sees a connector change, and the next call shows the tool gone", async () => {
    const gw = new FakeMcpGateway();
    gw.add("con_notes", "Notes", structuredClone(NOTES));
    gw.add("con_mail", "Mail", [tool("send_mail", "Send an email.")]);
    // Holds the Notes call open, so the change lands while the run is going.
    let reached!: () => void;
    const atCall = new Promise<void>((r) => {
      reached = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input instanceof Request ? input.url : input).endsWith("/call")) {
        reached();
        await gate;
      }
      return gw.fetch(input, init);
    };
    server = await startSignedIn({ fetchImpl, mcp: { gatewayUrl: "http://gateway.test" } });
    const s = server;
    // Read-only Notes calls run without asking, so the call reaches the gateway.
    const notes = (await s.host.plane.mcp.list()).find((c) => c.id === "con_notes")!;
    await s.host.plane.mcp.setProfile(
      "con_notes",
      "read_only",
      notes.providerIdentity!,
      notes.mcpProfileRevision!,
      false,
    );
    const id = await chat(s);
    await callTool(s, id, "search_capabilities", { load: ["mail__send_mail", "notes__search_notes"] });
    const before = (await s.client.get(`/api/sessions/${id}`)).body.runs.length as number;
    await s.client.post(`/api/sessions/${id}/messages`, {
      requestId: crypto.randomUUID(),
      text: `[tool: notes__search_notes {}]`,
    });
    await Promise.race([
      atCall,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("the Notes call never reached the gateway")), 10_000),
      ),
    ]);
    await s.host.plane.mcp.remove("con_mail");
    gw.connectors = gw.connectors.filter((c) => c.id !== "con_mail");
    await s.host.plane.adapter.trees.syncConnectors();
    release();
    await settled(s, id, before + 1);

    const change = steps(s, id).find((r) => r.type === "capabilities.changed")!;
    expect(change.summary).toBe("Mail: tools 1 removed");
    const d = await detail(s, change.id);
    expect(d.change).toEqual({ connectors: ["Mail"], added: [], removed: ["mail__send_mail"], changed: [] });
    expect(d.step.type).toBe("capabilities.changed");

    const trace = (await s.client.get(`/api/sessions/${id}/trace`)).body as {
      runs: { steps: { id: string; type: string }[]; totals: { toolCalls: number } }[];
    };
    const run = trace.runs.find((r) => r.steps.some((x) => x.id === change.id))!;
    expect(run.totals.toolCalls).toBe(run.steps.filter((x) => x.type === "tool.call").length);

    const calls = steps(s, id).filter((r) => r.type === "llm.call");
    const last = await detail(s, calls.at(-1)!.id);
    expect(last.llm?.tools?.offered).not.toContain("mail__send_mail");
    // The loaded connector tool still offered is recorded as loaded; the removed one is gone from the record too.
    const lastLoaded = s.host.plane.store.db.get<{ loaded_tools: string }>(
      "SELECT loaded_tools FROM steps WHERE id = ?",
      calls.at(-1)!.id,
    )!.loaded_tools;
    expect(JSON.parse(lastLoaded)).toEqual(["notes__search_notes"]);
    const removedAt = await Promise.all(calls.map((c) => detail(s, c.id)));
    expect(removedAt.some((c) => c.llm?.tools?.removed.includes("mail__send_mail"))).toBe(true);
  });
});
