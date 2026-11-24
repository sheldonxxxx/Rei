// The client contract: every route and stream a client may use, described by runtime schemas (ADR 0008). The server
// registers converted routes through these definitions, validates requests against them, and checks its responses
// against them in tests; `npm run contract` turns them into OpenAPI and JSON Schema for clients that cannot import
// TypeScript.

import type { Schema, Static } from "@earendil-works/pi-schema";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** What a route answers with when it is not one JSON document. */
export type RawResponse =
  | { readonly kind: "binary"; readonly contentType: string }
  | { readonly kind: "event-stream"; readonly stream: string };

export interface RouteContract<B = unknown, Q = unknown, R = unknown> {
  readonly method: HttpMethod;
  /** Hono-style path: `/api/sessions/:id`. */
  readonly path: string;
  /** Groups routes in the generated document. */
  readonly tag: string;
  readonly summary: string;
  readonly description?: string;
  /** "open" routes need no device credential. Default: "device". */
  readonly auth?: "open" | "device";
  /** A JSON body, checked before the handler runs. */
  readonly body?: Schema<B>;
  /** A multipart form instead of JSON; its fields are described here and read by the handler. */
  readonly multipart?: Schema<B>;
  /** Query parameters, checked (and coerced from strings) before the handler runs. */
  readonly query?: Schema<Q>;
  /** The JSON answer; omitted when `raw` says the answer is something else. */
  readonly response?: Schema<R>;
  readonly raw?: RawResponse;
  /** Success status. Default: 200. A 204 answers no body. */
  readonly status?: number;
  /** Kept for older clients through the deprecation window (ADR 0009); a new client uses the route named here. */
  readonly deprecated?: string;
  /**
   * The error code of a body or query that fails its schema, by top-level field, for routes that had a code per field before
   * they were converted (a client may already branch on it). Other failures answer "bad_request".
   */
  readonly fieldCodes?: Readonly<Record<string, string>>;
}

export type BodyOf<C> = C extends RouteContract<infer B, unknown, unknown> ? B : never;
export type QueryOf<C> = C extends RouteContract<unknown, infer Q, unknown> ? Q : never;
export type ResponseOf<C> = C extends RouteContract<unknown, unknown, infer R> ? R : never;

/** Declares a route; the identity function, kept for inference of body, query and response types. */
export function defineRoute<B = undefined, Q = undefined, R = undefined>(
  route: RouteContract<B, Q, R>,
): RouteContract<B, Q, R> {
  return route;
}

/** One server-sent event stream: the JSON `data` of each named event. */
export interface StreamContract {
  readonly name: string;
  /** The GET route that opens it. */
  readonly path: string;
  readonly summary: string;
  /** Event name (the SSE `event:` field) → the schema of its `data`. */
  readonly events: Readonly<Record<string, Schema>>;
}

export function defineStream(stream: StreamContract): StreamContract {
  return stream;
}

export type { Schema, Static };

/**
 * Names a schema: the generated documents write it once as a named model (`#/components/schemas/<title>`) and refer to
 * it everywhere else, so native code generators get one type per entity.
 */
export function named<S extends Schema>(title: string, schema: S): S {
  return { ...schema, title } as S;
}
