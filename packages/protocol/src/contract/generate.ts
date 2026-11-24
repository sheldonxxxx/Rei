// Builds the published contract documents from the route and stream definitions. Pure: the script that writes them
// to disk is `scripts/contract.mjs`.

import type { RouteContract, Schema, StreamContract } from "./define.ts";
import { ErrorBodySchema } from "./errors.ts";
import { CONTRACT_ROUTES, CONTRACT_STREAMS } from "./registry.ts";

type Json = Record<string, unknown>;

/** `/api/sessions/:id` → `/api/sessions/{id}`. */
function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function pathParams(path: string): Json[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}

function queryParams(schema: Schema | undefined): Json[] {
  if (!schema) return [];
  const properties = (schema.properties ?? {}) as Record<string, Json>;
  const required = new Set((schema.required ?? []) as string[]);
  return Object.entries(properties).map(([name, value]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: value,
  }));
}

function operation(route: RouteContract<unknown, unknown, unknown>, protocolVersion: number): Json {
  const parameters = [...pathParams(route.path), ...queryParams(route.query)];
  const status = String(route.status ?? 200);
  let success: Json;
  if (route.raw?.kind === "binary") success = { description: "File bytes.", content: { [route.raw.contentType]: {} } };
  else if (route.raw?.kind === "event-stream")
    success = {
      description: `Server-sent events; see the "${route.raw.stream}" stream in stream.schema.json.`,
      content: { "text/event-stream": {} },
    };
  else if (route.response) success = { description: "OK", content: { "application/json": { schema: route.response } } };
  else success = { description: route.status === 204 ? "No content." : route.status === 302 ? "A redirect." : "OK" };
  const op: Json = {
    tags: [route.tag],
    summary: route.summary,
    ...(route.description || route.deprecated
      ? {
          description: [route.description, route.deprecated ? `Deprecated: use ${route.deprecated}.` : undefined]
            .filter(Boolean)
            .join("\n\n"),
        }
      : {}),
    ...(route.deprecated ? { deprecated: true } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    responses: {
      [status]: success,
      default: { description: "Error", content: { "application/json": { schema: ErrorBodySchema } } },
    },
    security: route.auth === "open" ? [] : [{ cookie: [] }, { bearer: [] }],
    "x-rei-protocol": protocolVersion,
  };
  if (route.body) op.requestBody = { required: true, content: { "application/json": { schema: route.body } } };
  if (route.multipart)
    op.requestBody = { required: true, content: { "multipart/form-data": { schema: route.multipart } } };
  return op;
}

/**
 * Moves every schema with a `title` into `defs` and points at it with a `$ref` under `prefix`, so a named model (a
 * Session, a Message) is written once and native code generators name their types after it. Two different schemas may
 * not share a title.
 */
function hoist(value: unknown, defs: Record<string, unknown>, prefix: string): unknown {
  if (Array.isArray(value)) return value.map((v) => hoist(v, defs, prefix));
  if (value === null || typeof value !== "object") return value;
  const inner = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hoist(v, defs, prefix)]));
  const title = (value as { title?: unknown }).title;
  if (typeof title !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(title)) return inner;
  const known = defs[title];
  if (known !== undefined && JSON.stringify(known) !== JSON.stringify(inner))
    throw new Error(`Two different schemas are named ${title}.`);
  defs[title] = inner;
  return { $ref: `${prefix}${title}` };
}

const sortKeys = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

export function openApiDocument(
  protocolVersion: number,
  routes: readonly RouteContract<unknown, unknown, unknown>[] = CONTRACT_ROUTES,
): Json {
  const paths: Record<string, Json> = {};
  for (const route of routes) {
    const key = openApiPath(route.path);
    const entry = paths[key] ?? {};
    paths[key] = entry;
    const method = route.method.toLowerCase();
    if (entry[method]) throw new Error(`Route ${route.method} ${route.path} is defined twice.`);
    entry[method] = operation(route, protocolVersion);
  }
  const schemas: Record<string, unknown> = {};
  const sorted = hoist(sortKeys(paths), schemas, "#/components/schemas/");
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Rei client API",
      version: String(protocolVersion),
      description:
        "The published contract every Rei client uses. It only grows (docs/adr/0009): clients ignore fields they do not know.",
    },
    components: {
      schemas: sortKeys(schemas),
      securitySchemes: {
        cookie: { type: "apiKey", in: "cookie", name: "rei_session" },
        bearer: { type: "http", scheme: "bearer" },
      },
    },
    paths: sorted,
  };
}

export function streamSchemaDocument(
  protocolVersion: number,
  streams: readonly StreamContract[] = CONTRACT_STREAMS,
): Json {
  const defs: Record<string, unknown> = {};
  const body = hoist(
    Object.fromEntries(
      streams.map((s) => [
        s.name,
        { summary: s.summary, path: s.path, events: Object.fromEntries(Object.entries(s.events)) },
      ]),
    ),
    defs,
    "#/$defs/",
  );
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Rei event streams",
    description:
      "The JSON data of every server-sent event, by stream and event name. The SSE framing is described in docs/contract.md.",
    "x-rei-protocol": protocolVersion,
    streams: body,
    $defs: sortKeys(defs),
  };
}
