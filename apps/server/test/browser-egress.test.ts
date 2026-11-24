import { afterEach, describe, expect, it } from "vitest";
import { FakeBrowser } from "./helpers/browser.ts";
import { type ExecServer, postSocket, startExecServer } from "./helpers/exec.ts";
import { chat } from "./helpers/sessions.ts";
import { callTool } from "./helpers/web.ts";

// What the egress proxy's browser listener asks the control plane: the browser may go out only while it is in use.
let server: ExecServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});
const ask = (s: ExecServer, body: unknown) => postSocket(s.socket, JSON.stringify(body));
const BROWSER = (host: string, port = 443) => ({ source: "browser", host, port });

describe("browser traffic through the egress proxy", () => {
  it("is refused while the browser is idle, allowed while it is in use, and refused again after a minute", async () => {
    const fake = new FakeBrowser();
    const s = (server = await startExecServer({ browserDriver: fake }));
    expect(await ask(s, BROWSER("example.com"))).toMatchObject({
      status: 200,
      json: { decision: "deny", message: "The browser is not in use right now." },
    });
    const id = await chat(s);
    await callTool(s, id, "browser_open", { url: "https://example.com/" });
    expect((await ask(s, BROWSER("Example.COM"))).json).toEqual({ decision: "allow", localNetworks: "all" });
    expect((await ask(s, BROWSER("cdn.example.net", 80))).json).toEqual({ decision: "allow", localNetworks: "all" });
    s.clock.advance(61_000);
    expect((await ask(s, BROWSER("example.com"))).json).toMatchObject({ decision: "deny" });
    expect(s.logs.join("\n")).toContain('"event":"egress.denied"');
    expect(s.logs.join("\n")).toContain('"source":"browser"');
  });

  it("allows only ports 80 and 443, and refuses nonsense", async () => {
    const s = (server = await startExecServer({ browserDriver: new FakeBrowser() }));
    const id = await chat(s);
    await callTool(s, id, "browser_open", { url: "https://example.com/" });
    expect((await ask(s, BROWSER("example.com", 22))).json).toEqual({
      decision: "deny",
      message: "Only ports 80 and 443 are allowed.",
    });
    expect((await ask(s, BROWSER("", 443))).json).toMatchObject({ decision: "deny" });
    expect((await ask(s, { source: "browser", host: 5, port: 443 })).status).toBe(400);
    expect((await ask(s, { source: "other", host: "example.com", port: 443 })).status).toBe(400);
    expect((await ask(s, { host: "example.com", port: 443 })).status).toBe(400);
  });

  it("is allowed during a takeover, however long you stay", async () => {
    const s = (server = await startExecServer({ browserDriver: new FakeBrowser() }));
    const id = await chat(s);
    await callTool(s, id, "browser_open", { url: "https://example.com/" });
    await s.client.post(`/api/sessions/${id}/browser/takeover`, {});
    s.clock.advance(10 * 60_000);
    expect((await ask(s, BROWSER("example.com"))).json).toEqual({ decision: "allow", localNetworks: "all" });
  });

  it("is refused when no window is open", async () => {
    const s = (server = await startExecServer({ browserDriver: new FakeBrowser() }));
    expect((await ask(s, BROWSER("example.com"))).json).toMatchObject({ decision: "deny" });
  });

  it("does not need the browser to be on: the sandbox's own questions still work", async () => {
    const s = (server = await startExecServer());
    expect((await ask(s, BROWSER("example.com"))).json).toMatchObject({
      decision: "deny",
      message: "The browser is not in use right now.",
    });
    expect((await ask(s, { token: "nope", host: "example.com", port: 443 })).json).toMatchObject({ decision: "deny" });
  });
});
