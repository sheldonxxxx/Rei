import { int, obj, opt, str } from "@earendil-works/pi-schema";
import {
  CONTRACT_ROUTES,
  defineRoute,
  healthRoute,
  MIN_CLIENT_PROTOCOL,
  openApiDocument,
  PROTOCOL_VERSION,
  parseClientId,
} from "@rei/protocol";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ContractViolation, mountedRoutes, mountRoute } from "../src/http/contract.ts";
import { HttpError } from "../src/util/errors.ts";
import { startTestServer, type TestServer } from "./helpers/server.ts";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.destroy();
  server = undefined;
});

const echoRoute = defineRoute({
  method: "POST",
  path: "/echo/:id",
  tag: "test",
  summary: "Echo",
  body: obj({ name: str({ minLength: 1 }), count: opt(int({ minimum: 1 })) }),
  query: obj({ times: opt(int({ minimum: 1 })) }),
  response: obj({ id: str(), name: str(), times: int() }),
});

function testApp(answer?: unknown): Hono {
  const app = new Hono();
  mountRoute(app, echoRoute, { checkResponses: true }, (c, { body, query }) =>
    answer !== undefined
      ? (answer as { id: string; name: string; times: number })
      : { id: c.req.param("id") ?? "", name: body.name, times: query.times ?? 1 },
  );
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.info() }, error.status as 400);
    if (error instanceof ContractViolation) return c.json({ error: { code: "contract_violation" } }, 500);
    throw error;
  });
  return app;
}

const post = (app: Hono, path: string, body: string) =>
  app.request(path, { method: "POST", body, headers: { "content-type": "application/json" } });

describe("contract routes", () => {
  it("hands the handler a checked body and a coerced query", async () => {
    const res = await post(testApp(), "/echo/a1?times=3", JSON.stringify({ name: "Rei" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "a1", name: "Rei", times: 3 });
  });

  it("refuses an invalid body with one issue per field", async () => {
    const res = await post(testApp(), "/echo/a1", JSON.stringify({ name: "", extra: true, count: 0 }));
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { code: string; message: string; issues: unknown[] } };
    expect(error.code).toBe("bad_request");
    expect(error.message).toMatch(/^The request body is invalid: /);
    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/name" }),
        expect.objectContaining({ path: "/count" }),
        expect.objectContaining({ path: "/extra" }),
      ]),
    );
  });

  it("refuses a body that is not JSON and an invalid query", async () => {
    expect((await post(testApp(), "/echo/a1", "{nope")).status).toBe(400);
    const res = await post(testApp(), "/echo/a1?times=zero", JSON.stringify({ name: "Rei" }));
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { message: string; issues: { path: string }[] } };
    expect(error.message).toMatch(/^The request query is invalid/);
    expect(error.issues[0]?.path).toBe("/times");
  });

  it("fails an answer that drifts from its response schema", async () => {
    const res = await post(testApp({ id: "a1", name: "Rei" }), "/echo/a1", JSON.stringify({ name: "Rei" }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("contract_violation");
  });
});

describe("generated contract", () => {
  it("turns route definitions into OpenAPI paths with parameters and error answers", () => {
    const doc = openApiDocument(7, [echoRoute, healthRoute]) as {
      info: { version: string };
      paths: Record<string, Record<string, { parameters?: { name: string; in: string }[]; security: unknown[] }>>;
    };
    expect(doc.info.version).toBe("7");
    const echo = doc.paths["/echo/{id}"]?.post;
    expect(echo?.parameters?.map((p) => `${p.in}:${p.name}`)).toEqual(["path:id", "query:times"]);
    expect(echo?.security).toEqual([{ cookie: [] }, { bearer: [] }]);
    expect(doc.paths["/api/health"]?.get?.security).toEqual([]);
  });

  it("refuses a route defined twice", () => {
    expect(() => openApiDocument(1, [echoRoute, echoRoute])).toThrow(/defined twice/);
  });
});

describe("protocol handshake", () => {
  it("reads client ids and ignores anything else", () => {
    expect(parseClientId("ios/3")).toEqual({ kind: "ios", protocol: 3 });
    expect(parseClientId("toaster/1")).toBeUndefined();
    expect(parseClientId("ios")).toBeUndefined();
    expect(parseClientId(undefined)).toBeUndefined();
  });

  it("advertises the protocol on the open health route", async () => {
    server = await startTestServer();
    const res = await server.client.get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, protocolVersion: PROTOCOL_VERSION, minClientProtocol: MIN_CLIENT_PROTOCOL });
  });

  it("refuses an outdated client everywhere but health, and serves current and unnamed clients", async () => {
    server = await startTestServer();
    const outdated = { headers: { "x-rei-client": `ios/${MIN_CLIENT_PROTOCOL - 1}` } };
    const refused = await server.client.call("GET", "/api/auth/state", outdated);
    expect(refused.status).toBe(426);
    expect(refused.body.error.code).toBe("client_outdated");
    expect((await server.client.call("GET", "/api/health", outdated)).status).toBe(200);
    const current = { headers: { "x-rei-client": `ios/${PROTOCOL_VERSION}` } };
    expect((await server.client.call("GET", "/api/auth/state", current)).status).toBe(200);
    expect((await server.client.get("/api/auth/state")).status).toBe(200);
    const viaQuery = await server.client.get(`/api/auth/state?client=web/${MIN_CLIENT_PROTOCOL - 1}`);
    expect(viaQuery.status).toBe(426);
  });
});

describe("stream frames", () => {
  it("rejects frames outside the stream contract", async () => {
    const { frameViolation } = await import("./helpers/client.ts");
    const { CONTRACT_STREAMS } = await import("@rei/protocol");
    expect(frameViolation(CONTRACT_STREAMS, "ping", {})).toBeUndefined();
    expect(frameViolation(CONTRACT_STREAMS, "nope", {})).toMatch(/not in the/);
    expect(frameViolation(CONTRACT_STREAMS, "session.upserted", { type: "session.upserted" })).toMatch(
      /breaks its schema/,
    );
  });
});

describe("the served contract", () => {
  it("mounts every contract route through its schemas", async () => {
    server = await startTestServer();
    const served = mountedRoutes(server.host.plane.app);
    const missing = CONTRACT_ROUTES.map((r) => `${r.method} ${r.path}`).filter((r) => !served.has(r));
    expect(missing).toEqual([]);
  });
});
