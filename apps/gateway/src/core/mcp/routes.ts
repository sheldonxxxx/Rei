// /mcp/*: connector registry, OAuth sign-in, tool listing and calls.
import type { Hono } from "hono";
import { errorResponse, jsonResponse, readJsonObject } from "../http.ts";
import type { ConnectorService } from "./connectors.ts";

/** Every /mcp route needs the admin scope; the app's one guard checks it (core/callers.ts). */
export function registerMcpRoutes(app: Hono, service: ConnectorService | null): void {
  app.use("/mcp/*", async (_c, next) => {
    if (!service)
      return errorResponse(503, {
        code: "connectors_unavailable",
        message: "MCP connectors are not configured on the gateway.",
      });
    await next(); // an HttpError thrown by a handler is answered by the app's onError
  });
  const svc = () => service!;

  app.get("/mcp/connectors", async () => jsonResponse({ connectors: await svc().list() }));
  app.post("/mcp/connectors", async (c) => {
    const body = await readJsonObject(c.req.raw);
    return jsonResponse({
      connector: await svc().create({
        name: body.name,
        url: body.url,
        token: body.token,
        tokenHeader: body.tokenHeader,
        ownerKey: body.ownerKey,
        auth: body.auth,
      }),
    });
  });
  app.patch("/mcp/connectors/:id", async (c) => {
    const body = await readJsonObject(c.req.raw);
    return jsonResponse({
      connector: await svc().patch(c.req.param("id"), {
        name: body.name,
        token: body.token,
        tokenHeader: body.tokenHeader,
      }),
    });
  });
  app.delete("/mcp/connectors/:id", async (c) => {
    await svc().remove(c.req.param("id"));
    return new Response(null, { status: 204 });
  });
  app.post("/mcp/connectors/:id/oauth/start", async (c) => {
    const body = await readJsonObject(c.req.raw);
    return jsonResponse({ authorizationUrl: await svc().oauthStart(c.req.param("id"), body) });
  });
  app.post("/mcp/oauth/callback", async (c) => {
    const body = await readJsonObject(c.req.raw);
    return jsonResponse({
      connector: await svc().oauthCallback({ state: body.state, code: body.code, iss: body.iss }),
    });
  });
  app.get("/mcp/connectors/:id/tools", async (c) =>
    jsonResponse(await svc().tools(c.req.param("id"), c.req.query("refresh") === "1")),
  );
  app.post("/mcp/connectors/:id/call", async (c) => {
    const body = await readJsonObject(c.req.raw, 1024 * 1024);
    return jsonResponse(
      await svc().call(c.req.param("id"), {
        tool: body.tool,
        arguments: body.arguments,
        stepId: body.stepId,
        expected: body.expected,
      }),
    );
  });
}
