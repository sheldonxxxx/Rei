// A fake gateway for the connectors' routes (/mcp/*): connectors, their tools, and calls, recorded.
import type { GatewayConnector, McpCallResult, McpToolInfo } from "@rei/protocol";

export interface McpCallSeen {
  connector: string;
  tool: string;
  args: unknown;
  stepId: string | undefined;
  auth: string | null;
}

export const tool = (
  name: string,
  description: string,
  annotations: McpToolInfo["annotations"] = {},
  title: string | null = null,
): McpToolInfo => ({
  name,
  title,
  description,
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
  annotations,
});

export class FakeMcpGateway {
  connectors: GatewayConnector[] = [];
  tools = new Map<string, McpToolInfo[]>();
  calls: McpCallSeen[] = [];
  requests: { method: string; path: string; body: any }[] = [];
  down = false;
  toolsDown = new Set<string>();
  /** What a call answers: a result, or an HTTP error. */
  callReply: (c: McpCallSeen) => { status?: number; json: unknown } = () => ({
    json: { isError: false, text: "ok", structured: null, truncated: false } satisfies McpCallResult,
  });

  add(
    id: string,
    name: string,
    tools: McpToolInfo[],
    status: GatewayConnector["status"] = "connected",
  ): GatewayConnector {
    const c: GatewayConnector = {
      id,
      name,
      url: `https://${name.toLowerCase().replace(/\W+/g, "")}.example/mcp`,
      auth: "oauth",
      status,
      error: status === "error" ? "boom" : null,
      toolCount: tools.length,
      createdAt: 1,
    };
    this.connectors.push(c);
    this.tools.set(id, tools);
    return c;
  }

  fetch: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError("fetch failed");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, path: url.pathname, body });
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    const err = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
    const auth = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/mcp/connectors" && method === "GET") return json({ connectors: this.connectors });
    if (url.pathname === "/mcp/connectors" && method === "POST") {
      const c = this.add(
        `con_${this.requests.filter((r) => r.method === "POST" && r.path === "/mcp/connectors").length}`,
        body.name,
        [],
        "needs_auth",
      );
      return json({ connector: c });
    }
    if (url.pathname === "/mcp/oauth/callback") {
      if (body.state === "bad") return err(400, "invalid_state", "That sign-in link is not valid.");
      return json({ connector: this.connectors[0] });
    }
    const m = /^\/mcp\/connectors\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (m) {
      const id = m[1]!;
      const c = this.connectors.find((x) => x.id === id);
      if (!c) return err(404, "connector_not_found", "No such connector.");
      if (!m[2] && method === "PATCH") {
        Object.assign(c, { ...(body.name !== undefined ? { name: body.name } : {}) });
        return json({ connector: c });
      }
      if (!m[2] && method === "DELETE") {
        this.connectors = this.connectors.filter((x) => x.id !== id);
        return new Response(null, { status: 204 });
      }
      if (m[2] === "/oauth/start")
        return body.clientId === "none"
          ? err(400, "client_id_required", "This server needs a client ID.")
          : json({
              authorizationUrl: `https://auth.example/authorize?redirect=${encodeURIComponent(body.redirectUri)}`,
            });
      if (m[2] === "/tools") {
        if (c.status === "needs_auth") return err(409, "needs_auth", "Sign in again.");
        if (this.toolsDown.has(id)) {
          Object.assign(c, { status: "error", error: "It did not answer." });
          return err(502, "mcp_error", "It did not answer.");
        }
        if (c.status === "error") Object.assign(c, { status: "connected", error: null });
        return json({ tools: this.tools.get(id) ?? [], fetchedAt: 5 });
      }
      if (m[2] === "/call") {
        const seen: McpCallSeen = { connector: id, tool: body.tool, args: body.arguments, stepId: body.stepId, auth };
        this.calls.push(seen);
        const r = this.callReply(seen);
        return json(r.json, r.status ?? 200);
      }
    }
    return err(404, "not_found", "no");
  };
}
