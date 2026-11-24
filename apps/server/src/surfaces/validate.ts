// Checks surface content twice: against the vendored official A2UI v1.0 JSON Schema with Rei's catalog (so Rei never
// accepts a message the spec rejects, ADR 0014), and against Rei's own rules the schema cannot express — unique ids, one
// root, references that resolve, no cycles, https images, safe check patterns, data that suits the components bound to
// it, and the size limits. Every error is one line the model can act on.

import { compile, type Validator } from "@earendil-works/pi-schema";
import { type A2uiComponent, type A2uiMessage, pointerGet, SURFACE_LIMITS, type SurfaceDataModel } from "@rei/protocol";
import { A2UI_BASE, a2uiSchemas, reiCatalog1 } from "@rei/protocol/surface-schemas";

type Json = Record<string, unknown>;

const CATALOG_URI = `${A2UI_BASE}catalog.json`;
const COMMON_URI = `${A2UI_BASE}common_types.json`;
const DATA_BINDING_REF = `${COMMON_URI}#/$defs/DataBinding`;

const catalog = reiCatalog1 as unknown as {
  components: Record<string, Json>;
  functions: Record<string, Json>;
  catalogId: string;
};
const documents = {
  [COMMON_URI]: a2uiSchemas.commonTypes,
  [CATALOG_URI]: reiCatalog1,
  [String((reiCatalog1 as { $id: string }).$id)]: reiCatalog1,
};

/** Component names in the catalog, in catalog order. */
export const CATALOG_COMPONENTS: readonly string[] = Object.keys(catalog.components);
export const CATALOG_FUNCTIONS: readonly string[] = Object.keys(catalog.functions);

let agentToRenderer: Validator | undefined;
let rendererToAgent: Validator | undefined;
const perComponent = new Map<string, Validator>();
const dataShapes = new Map<string, Validator>();

/** The official agent-to-renderer message schema, with Rei's catalog as `catalog.json`. */
export function messageValidator(): Validator {
  agentToRenderer ??= compile(a2uiSchemas.agentToRenderer, { schemas: documents });
  return agentToRenderer;
}

/** The official renderer-to-agent schema (a client's `action`). */
export function actionValidator(): Validator {
  rendererToAgent ??= compile(a2uiSchemas.rendererToAgent, { schemas: documents });
  return rendererToAgent;
}

function componentValidator(name: string): Validator {
  let v = perComponent.get(name);
  if (!v) {
    v = compile(
      {
        allOf: [{ $ref: `${COMMON_URI}#/$defs/ComponentCommon` }, { $ref: `${CATALOG_URI}#/components/${name}` }],
        unevaluatedProperties: false,
      },
      { schemas: documents },
    );
    perComponent.set(name, v);
  }
  return v;
}

/** For each component, the properties that take a literal array or a binding, with a validator for the array. */
function arrayProps(name: string): [string, Json][] {
  const props = (catalog.components[name]?.properties ?? {}) as Record<string, Json>;
  const out: [string, Json][] = [];
  for (const [prop, schema] of Object.entries(props)) {
    const branches = schema.oneOf as Json[] | undefined;
    if (branches?.length === 2 && branches[0]?.type === "array" && branches[1]?.$ref === DATA_BINDING_REF)
      out.push([prop, branches[0]]);
  }
  return out;
}

function dataShape(name: string, prop: string, schema: Json): Validator {
  const key = `${name}.${prop}`;
  let v = dataShapes.get(key);
  if (!v) {
    v = compile(schema, { schemas: documents });
    dataShapes.set(key, v);
  }
  return v;
}

const label = (c: A2uiComponent | undefined, index: number): string =>
  c && typeof c.id === "string" ? `component "${c.id}"` : `components[${index}]`;

const describe = (errors: readonly { path: string; message: string }[], max = Number.POSITIVE_INFINITY): string =>
  errors
    .slice(0, max)
    .map((e) => (e.path ? `${e.path}: ${e.message}` : e.message))
    .join("; ");

/** The object schema a JSON pointer inside a component points at, following `$ref`, `oneOf` and array items. */
function schemaAt(root: Json, segments: readonly string[]): Json | undefined {
  const objectLike = (s: Json | undefined): Json | undefined => {
    if (!s) return undefined;
    if (typeof s.$ref === "string") {
      const [uri, frag] = s.$ref.split("#");
      const doc = (uri ? (documents as Record<string, unknown>)[uri] : root) as Json | undefined;
      let cur: unknown = doc;
      for (const part of (frag ?? "").split("/").filter(Boolean)) cur = (cur as Json | undefined)?.[part];
      return objectLike(cur as Json | undefined);
    }
    if (Array.isArray(s.oneOf))
      for (const b of s.oneOf as Json[]) if (b.type === "array" || b.properties) return objectLike(b);
    return s;
  };
  let cur: Json | undefined = objectLike(root);
  for (const seg of segments) {
    if (!cur) return undefined;
    cur = objectLike(
      /^\d+$/.test(seg)
        ? (cur.items as Json | undefined)
        : ((cur.properties as Json | undefined)?.[seg] as Json | undefined),
    );
  }
  return cur;
}

/** Spells out each error, and for a wrong or missing field says which fields that object accepts. */
function describeFor(name: string, errors: readonly { path: string; message: string }[]): string {
  const root = catalog.components[name] as Json;
  return errors
    .map((e) => {
      const segments = e.path.split("/").filter(Boolean);
      const field = segments.pop() ?? "";
      const where =
        segments.length === 0
          ? ""
          : segments
              .map((x) => (/^\d+$/.test(x) ? `[${x}]` : `.${x}`))
              .join("")
              .replace(/^\./, "");
      const parent = schemaAt(root, segments);
      const props = Object.keys((parent?.properties ?? {}) as Json).filter((k) => k !== "component");
      const fields = segments.length === 0 ? ["id", ...props] : props;
      const hint = e.message === "unknown field" || e.message === "missing" ? `; fields: ${fields.join(", ")}` : "";
      const msg =
        e.message === "unknown field"
          ? `unknown field "${field}"`
          : e.message === "missing"
            ? `"${field}" is required`
            : e.message;
      if (!hint) return e.path ? `${e.path}: ${e.message}` : e.message;
      return `${where ? `${where}: ` : ""}${msg}${hint}`;
    })
    .join("; ");
}

/** Checks one component against the catalog: its name, then its properties. */
export function checkComponent(c: unknown, index: number): string | undefined {
  if (typeof c !== "object" || c === null || Array.isArray(c)) return `components[${index}] is not an object.`;
  const loose = c as Json;
  if (typeof loose.id !== "string" || loose.id === "") return `components[${index}] needs a string "id".`;
  if (typeof loose.component !== "string")
    return `component "${loose.id}" needs "component", one of: ${CATALOG_COMPONENTS.join(", ")}.`;
  const comp = c as A2uiComponent;
  if (!Object.hasOwn(catalog.components, comp.component))
    return `${label(comp, index)}: unknown component "${comp.component}". The catalog has: ${CATALOG_COMPONENTS.join(", ")}.`;
  const name = comp.component;
  const v = componentValidator(name);
  if (v.check(c)) return undefined;
  return `component "${loose.id}" (${name}): ${describeFor(name, v.errors(c))}`;
}

/** Checks A2UI messages against the official schema (the conformance gate). */
export function checkMessages(messages: readonly A2uiMessage[]): string[] {
  const v = messageValidator();
  const errors: string[] = [];
  for (const m of messages) if (!v.check(m)) errors.push(`A2UI v1.0 schema: ${describe(v.errors(m), 3)}`);
  return errors;
}

/** Child ids a component refers to statically (children, child, tabs, steps, templates). */
export function childRefs(c: A2uiComponent): string[] {
  const out: string[] = [];
  const children = c.children;
  if (Array.isArray(children)) for (const id of children) if (typeof id === "string") out.push(id);
  if (children && typeof children === "object" && !Array.isArray(children)) {
    const t = (children as Json).componentId;
    if (typeof t === "string") out.push(t);
  }
  if (typeof c.child === "string") out.push(c.child);
  for (const key of ["tabs", "steps"] as const) {
    const list = c[key];
    if (Array.isArray(list))
      for (const t of list) if (typeof (t as Json)?.child === "string") out.push((t as Json).child as string);
  }
  return out;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

const BAD_PATTERN = /\\k<|\(\?<[=!]|\(\?<[A-Za-z]|\\[pP]\{/;

function walkValues(value: unknown, visit: (v: Json) => void): void {
  if (Array.isArray(value)) for (const v of value) walkValues(v, visit);
  else if (value && typeof value === "object") {
    visit(value as Json);
    for (const v of Object.values(value)) walkValues(v, visit);
  }
}

/**
 * Rei's rules over a whole surface: what A2UI's schema cannot express. `components` is the full set after a change.
 * Returns errors (empty when fine).
 */
export function checkSurface(components: readonly A2uiComponent[], data: SurfaceDataModel): string[] {
  const errors: string[] = [];
  if (components.length === 0) return ['A surface needs at least one component, with id "root".'];
  if (components.length > SURFACE_LIMITS.components)
    errors.push(`Too many components: ${components.length} (at most ${SURFACE_LIMITS.components}).`);
  const componentBytes = JSON.stringify(components).length;
  if (componentBytes > SURFACE_LIMITS.componentBytes)
    errors.push(`Components are too large: ${componentBytes} bytes (at most ${SURFACE_LIMITS.componentBytes}).`);
  const dataBytes = JSON.stringify(data).length;
  if (dataBytes > SURFACE_LIMITS.dataBytes)
    errors.push(`Data is too large: ${dataBytes} bytes (at most ${SURFACE_LIMITS.dataBytes}).`);
  const byId = new Map<string, A2uiComponent>();
  for (const c of components) {
    if (!ID.test(c.id)) errors.push(`Component id "${c.id}" must match [A-Za-z0-9_-]{1,64}.`);
    if (byId.has(c.id)) errors.push(`Component id "${c.id}" is used twice.`);
    byId.set(c.id, c);
  }
  if (!byId.has("root")) errors.push('One component must have id "root".');
  for (const c of components)
    for (const ref of childRefs(c))
      if (!byId.has(ref)) errors.push(`component "${c.id}" refers to "${ref}", which does not exist.`);
  // No cycles: a depth-first walk from root never meets a component on its own path.
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      errors.push(`Components form a cycle: ${[...path, id].join(" → ")}.`);
      return;
    }
    state.set(id, 1);
    const c = byId.get(id);
    if (c) for (const ref of childRefs(c)) if (byId.has(ref)) visit(ref, [...path, id]);
    state.set(id, 2);
  };
  if (byId.has("root")) visit("root", []);
  for (const c of components) {
    // Images load straight from their URL in the reader's browser: https only.
    if (c.component === "Image" && typeof c.url === "string" && !c.url.startsWith("https://"))
      errors.push(`component "${c.id}": an image url must start with https://.`);
    if (c.component === "Gallery" && Array.isArray(c.images))
      for (const img of c.images as Json[])
        if (typeof img?.url === "string" && !img.url.startsWith("https://"))
          errors.push(`component "${c.id}": gallery image ${img.url} must start with https://.`);
    if (c.component === "Links" && Array.isArray(c.links))
      for (const link of c.links as Json[])
        if (typeof link?.image === "string" && !link.image.startsWith("https://"))
          errors.push(`component "${c.id}": a link image must start with https://.`);
    if (c.component === "Chart" && c.variant === "pie" && Array.isArray(c.series) && c.series.length !== 1)
      errors.push(`component "${c.id}": a pie chart takes exactly one series.`);
    if (c.component === "Table" && Array.isArray(c.columns) && Array.isArray(c.rows)) {
      const keys = new Set((c.columns as Json[]).map((col) => col.key));
      for (const row of c.rows as Json[])
        for (const k of Object.keys(row ?? {}))
          if (!keys.has(k)) {
            errors.push(`component "${c.id}": row key "${k}" is not a column.`);
            break;
          }
    }
    // Check patterns follow A2UI's portable regex dialect.
    walkValues(c, (v) => {
      if (v["@call"] !== "regex") return;
      const pattern = (v.args as Json | undefined)?.pattern;
      if (typeof pattern !== "string") return;
      if (pattern.length > 256 || BAD_PATTERN.test(pattern)) {
        errors.push(`component "${c.id}": regex pattern uses syntax outside A2UI's dialect or is over 256 characters.`);
        return;
      }
      try {
        new RegExp(pattern, "u");
      } catch {
        errors.push(`component "${c.id}": regex pattern ${JSON.stringify(pattern)} does not compile.`);
      }
    });
    // Data bound to a data component must suit it when present (a feed may fill it later).
    for (const [prop, schema] of arrayProps(c.component)) {
      const value = c[prop] as Json | undefined;
      const path = value && typeof value === "object" && !Array.isArray(value) ? value["@path"] : undefined;
      if (typeof path !== "string" || !path.startsWith("/")) continue;
      const bound = pointerGet(data, path);
      if (bound === undefined) continue;
      const v = dataShape(c.component, prop, schema);
      if (!v.check(bound))
        errors.push(`component "${c.id}": data at ${path} does not suit "${prop}": ${describe(v.errors(bound), 2)}`);
    }
  }
  return errors.slice(0, 20);
}

/** Ids reachable from root (static references, templates included). */
export function reachable(components: readonly A2uiComponent[]): Set<string> {
  const byId = new Map(components.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const stack = ["root"];
  while (stack.length) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    const c = byId.get(id);
    if (!c) continue;
    seen.add(id);
    stack.push(...childRefs(c));
  }
  return seen;
}
