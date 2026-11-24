// Which local-network addresses a read may reach (ADR 0020): the agent's sandbox network setting, the same verdict the
// egress proxy gives the sandbox, is sent to the reader as `localNetworks`; the reader's proxy enforces it on the
// addresses it resolves. web_fetch never decides this itself.
import { afterEach, describe, expect, it } from "vitest";
import { approve, askApproval, setProfile, tool } from "./helpers/approvals.ts";
import { chat } from "./helpers/sessions.ts";
import { callTool, html, startWebServer, type WebServer } from "./helpers/web.ts";

let server: WebServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const agentOf = (s: WebServer, id: string): string => s.host.plane.store.getSessionRow(id)!.agent_id;
const setMode = (s: WebServer, id: string, networkMode: string) =>
  s.client.call("PATCH", `/api/agents/${agentOf(s, id)}`, { body: { networkMode } });
const sent = (s: WebServer) => s.search.reads.map((r) => (r.body as { localNetworks?: unknown }).localNetworks);

describe("web_fetch and the local network", () => {
  it("sends no local-network scope unless the agent's network setting opens the destination", async () => {
    server = await startWebServer();
    const s = server;
    s.web.page("https://example.com/p", html("<html><body><p>hi</p></body></html>"));
    const id = await chat(s);
    await callTool(s, id, "web_fetch", { url: "https://example.com/p" });
    expect(sent(s)).toEqual([undefined]);
  });

  it("Any sends all", async () => {
    server = await startWebServer();
    const s = server;
    s.web.page("https://example.com/p", html("<html><body><p>hi</p></body></html>"));
    const id = await chat(s);
    expect((await setMode(s, id, "any")).status).toBe(200);
    await callTool(s, id, "web_fetch", { url: "https://example.com/p" });
    expect(sent(s)).toEqual(["all"]);
  });

  it("an all-web grant uses public network scope even when the agent can reach private networks", async () => {
    server = await startWebServer();
    const s = server;
    s.web.page("https://example.com/p", html("<html><body><p>hi</p></body></html>"));
    const id = await chat(s);
    await setMode(s, id, "any");
    await setProfile(s, id, "strict");
    await askApproval(s, id, tool("web_fetch", { url: "https://example.com/p" }));
    await approve(s, id, { length: "web_session" });
    expect(sent(s)).toEqual([undefined]);
  });

  it("Whitelist sends the address entries for a listed name, and none for a name that is not listed", async () => {
    server = await startWebServer();
    const s = server;
    s.web.page("https://nas.lan/p", html("<html><body><p>hi</p></body></html>"));
    s.web.page("https://example.com/p", html("<html><body><p>hi</p></body></html>"));
    const id = await chat(s);
    expect((await setMode(s, id, "whitelist")).status).toBe(200);
    const { defaults } = (await s.client.get("/api/settings/sandbox-network")).body;
    const put = await s.client.call("PUT", "/api/settings/sandbox-network", {
      body: { whitelist: [...defaults, "10.0.0.0/8", "nas.lan"] },
    });
    expect(put.status).toBe(200);
    await callTool(s, id, "web_fetch", { url: "https://nas.lan/p" });
    await callTool(s, id, "web_fetch", { url: "https://example.com/p" });
    expect(sent(s)[0]).toEqual(["10.0.0.0/8"]);
    expect(sent(s)[1]).toBeUndefined();
  });

  it("keeps the scope across a redirect to another host the setting opens the same way", async () => {
    server = await startWebServer();
    const s = server;
    s.web
      .page("https://nas.lan/s", { status: 302, location: "https://example.com/f" })
      .page("https://example.com/f", html("<html><body><p>b</p></body></html>"));
    const id = await chat(s);
    expect((await setMode(s, id, "whitelist")).status).toBe(200);
    const { defaults } = (await s.client.get("/api/settings/sandbox-network")).body;
    await s.client.call("PUT", "/api/settings/sandbox-network", {
      body: { whitelist: [...defaults, "10.0.0.0/8", "nas.lan", "example.com"] },
    });
    await callTool(s, id, "web_fetch", { url: "https://nas.lan/s" });
    expect(sent(s)).toEqual([["10.0.0.0/8"], ["10.0.0.0/8"]]);
  });
});
