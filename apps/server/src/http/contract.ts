// Registers contract routes (packages/protocol/src/contract) on the Hono app: the request is checked against the
// route's schemas before the handler runs, and in tests the handler's answer is checked against the response schema,
// so the published contract and the server cannot drift apart (ADR 0008).

import { compile, type Validator } from "@earendil-works/pi-schema";
import {
  type BodyOf,
  CLIENT_QUERY,
  type ErrorIssue,
  type QueryOf,
  type ResponseOf,
  type RouteContract,
  type Schema,
} from "@rei/protocol";
import type { Context, Hono } from "hono";
import { badRequest, HttpError } from "../util/errors.ts";

const validators = new WeakMap<object, Validator>();
const coercing = new WeakMap<object, ReturnType<typeof compileCoercing>>();

function compileCoercing(schema: Schema) {
  return compile(schema, { coerce: true });
}

function validator(schema: Schema): Validator {
  let v = validators.get(schema);
  if (!v) {
    v = compile(schema);
    validators.set(schema, v);
  }
  return v;
}

/** Validation errors as issues, with one sentence that names the first few. */
function invalid(
  where: "body" | "query",
  issues: ErrorIssue[],
  fieldCodes?: Readonly<Record<string, string>>,
): HttpError {
  const shown = issues
    .slice(0, 3)
    .map((i) => `${i.path || "(root)"} ${i.message}`)
    .join("; ");
  const more = issues.length > 3 ? ` (and ${issues.length - 3} more)` : "";
  const field = (path: string) => path.split("/")[1] ?? "";
  const code = (fieldCodes && issues.map((i) => fieldCodes[field(i.path)]).find(Boolean)) ?? "bad_request";
  return new HttpError(400, code, `The request ${where} is invalid: ${shown}${more}.`, issues);
}

const toIssues = (errors: readonly { path: string; message: string }[]): ErrorIssue[] =>
  errors.map(({ path, message }) => ({ path, message }));

/** Checks a value against a schema; the value typed, or a 400 with issues. */
export function checkBody<T>(schema: Schema<T>, value: unknown, fieldCodes?: Readonly<Record<string, string>>): T {
  const v = validator(schema);
  if (v.check(value)) return value as T;
  throw invalid("body", toIssues(v.errors(value)), fieldCodes);
}

/**
 * Checks query parameters, coercing numbers and booleans from their string form. An empty value (`?from=`) counts as
 * absent, as a form leaves it.
 */
export function checkQuery<T>(
  schema: Schema<T>,
  query: Record<string, string>,
  fieldCodes?: Readonly<Record<string, string>>,
): T {
  let v = coercing.get(schema);
  if (!v) {
    v = compileCoercing(schema);
    coercing.set(schema, v);
  }
  const present = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== ""));
  // Coercion would truncate "1.5" to 1; an integer parameter must be written as one.
  const properties = (schema as { properties?: Record<string, { type?: unknown }> }).properties ?? {};
  const fractional = Object.entries(present)
    .filter(([key, value]) => properties[key]?.type === "integer" && !/^[+-]?\d+$/.test(value.trim()))
    .map(([key]) => ({ path: `/${key}`, message: "expected integer" }));
  if (fractional.length > 0) throw invalid("query", fractional, fieldCodes);
  const result = v.parse(present);
  if (result.ok) return result.value as T;
  throw invalid("query", toIssues(result.errors), fieldCodes);
}

/** The client id may ride in the query of any request (an EventSource cannot set headers); it is not a route's parameter. */
function withoutClient(query: Record<string, string>): Record<string, string> {
  const { [CLIENT_QUERY]: _client, ...rest } = query;
  return rest;
}

async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("bad_request", "The request body must be JSON.");
  }
}

export interface ContractInput<C> {
  body: BodyOf<C>;
  query: QueryOf<C>;
}

export type ContractHandler<C> = (
  c: Context,
  input: ContractInput<C>,
) => Promise<ResponseOf<C> | Response> | ResponseOf<C> | Response;

export interface ContractOptions {
  /** Check every JSON answer against the route's response schema (tests only: it costs a validation per answer). */
  checkResponses: boolean;
}

/** A response that broke its own contract: a server bug, reported as a 500 so the test that caused it fails. */
export class ContractViolation extends Error {
  constructor(route: string, issues: ErrorIssue[]) {
    super(
      `${route} answered outside its contract: ${issues
        .slice(0, 5)
        .map((i) => `${i.path || "(root)"} ${i.message}`)
        .join("; ")}`,
    );
    this.name = "ContractViolation";
  }
}

/** Checks an answer against a schema; throws ContractViolation when it does not match. */
export function checkAnswer(route: string, schema: Schema, value: unknown): void {
  const v = validator(schema);
  if (!v.check(value)) throw new ContractViolation(route, toIssues(v.errors(value)));
}

const mounted = new WeakMap<Hono, Set<string>>();

/** "METHOD /path" of every contract route mounted on an app, so a test can prove the whole contract is served. */
export function mountedRoutes(app: Hono): ReadonlySet<string> {
  return mounted.get(app) ?? new Set();
}

export function mountRoute<C extends RouteContract<unknown, unknown, unknown>>(
  app: Hono,
  route: C,
  options: ContractOptions,
  handler: ContractHandler<C>,
): void {
  const label = `${route.method} ${route.path}`;
  let seen = mounted.get(app);
  if (!seen) {
    seen = new Set();
    mounted.set(app, seen);
  }
  seen.add(label);
  app.on(route.method, route.path, async (c) => {
    const body = route.body ? checkBody(route.body, await readJson(c), route.fieldCodes) : undefined;
    const query = route.query ? checkQuery(route.query, withoutClient(c.req.query()), route.fieldCodes) : undefined;
    const answer = await handler(c, { body, query } as ContractInput<C>);
    if (answer instanceof Response) return answer;
    if (route.status === 204) return c.body(null, 204);
    if (options.checkResponses && route.response) checkAnswer(label, route.response, answer);
    return c.json(answer as object, (route.status ?? 200) as 200);
  });
}
