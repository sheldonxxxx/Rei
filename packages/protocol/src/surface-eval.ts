// Evaluates A2UI dynamic values and checks against a surface's data model: bindings (`{"@path": ...}`), Rei's catalog
// functions (required, regex, length, numeric, email, formatString, and, or, not) and the `@index` system function.
// Pure and renderer-local, so the web renderer and the server's action check give the same answer.

export type SurfaceData = Record<string, unknown>;

export interface EvalContext {
  data: SurfaceData;
  /** The data path of the template item being drawn; relative paths resolve against it. */
  scope?: string;
  /** The template item's index, for `@index`. */
  index?: number;
}

type Json = Record<string, unknown>;

const unescapeToken = (k: string) => k.replace(/~1/g, "/").replace(/~0/g, "~");

/** The absolute path of `path` in `scope` (a path inside a template is relative to its item). */
export function absolutePath(path: string, scope?: string): string {
  if (path.startsWith("/")) return path;
  if (path === "" || path === ".") return scope ?? "/";
  return `${scope && scope !== "/" ? scope : ""}/${path}`;
}

/** The value at a JSON Pointer, or undefined. */
export function pointerGet(data: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return data;
  if (!pointer.startsWith("/")) return undefined;
  let node: unknown = data;
  for (const raw of pointer.slice(1).split("/")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[unescapeToken(raw)];
  }
  return node;
}

/** A copy of `data` with `value` at `pointer` (intermediate objects are created). */
export function pointerSet(data: SurfaceData, pointer: string, value: unknown): SurfaceData {
  if (pointer === "" || pointer === "/")
    return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as SurfaceData) } : data;
  const keys = pointer.slice(1).split("/").map(unescapeToken);
  if (keys.some((k) => k === "__proto__" || k === "constructor" || k === "prototype")) return data;
  const copy = (node: unknown, i: number): unknown => {
    const key = keys[i] as string;
    const base: Record<string, unknown> | unknown[] = Array.isArray(node)
      ? [...node]
      : node && typeof node === "object"
        ? { ...(node as Record<string, unknown>) }
        : /^\d+$/.test(key)
          ? []
          : {};
    (base as Record<string, unknown>)[key] =
      i === keys.length - 1 ? value : copy((node as Record<string, unknown> | undefined)?.[key], i + 1);
    return base;
  };
  return copy(data, 0) as SurfaceData;
}

const isBinding = (v: unknown): v is { "@path": string } =>
  !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as Json)["@path"] === "string";
const isCall = (v: unknown): v is { "@call": string; args?: Json } =>
  !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as Json)["@call"] === "string";

export interface CheckResult {
  valid: boolean;
  message?: string;
}

const asResult = (v: unknown): CheckResult => {
  if (v && typeof v === "object" && typeof (v as Json).valid === "boolean")
    return {
      valid: (v as Json).valid as boolean,
      ...(typeof (v as Json).message === "string" ? { message: (v as Json).message as string } : {}),
    };
  return { valid: v === true };
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** formatString's `${...}` interpolation: data paths only (a nested function call yields nothing). */
export function interpolate(template: string, ctx: EvalContext): string {
  return template.replace(/(\\)?\$\{([^}]*)\}/g, (match, escaped: string | undefined, expr: string) => {
    if (escaped) return match.slice(1);
    const path = expr.trim();
    if (/^[A-Za-z_@][\w]*\(/.test(path)) return "";
    return toText(pointerGet(ctx.data, absolutePath(path, ctx.scope)));
  });
}

/** Resolves a dynamic value: a literal as it is, a binding looked up, a function called. */
export function resolveDynamic(value: unknown, ctx: EvalContext): unknown {
  if (isBinding(value)) return pointerGet(ctx.data, absolutePath(value["@path"], ctx.scope));
  if (isCall(value)) return callFunction(value["@call"], value.args ?? {}, ctx);
  return value;
}

export function resolveText(value: unknown, ctx: EvalContext): string {
  return toText(resolveDynamic(value, ctx));
}

function callFunction(name: string, args: Json, ctx: EvalContext): unknown {
  const arg = (k: string) => resolveDynamic(args[k], ctx);
  switch (name) {
    case "required": {
      const v = arg("value");
      return !(v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0));
    }
    case "regex": {
      const v = toText(arg("value"));
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      try {
        return new RegExp(pattern, "u").test(v);
      } catch {
        return false;
      }
    }
    case "length": {
      const n = toText(arg("value")).length;
      const min = typeof args.min === "number" ? args.min : undefined;
      const max = typeof args.max === "number" ? args.max : undefined;
      return (min === undefined || n >= min) && (max === undefined || n <= max);
    }
    case "numeric": {
      const raw = arg("value");
      const n =
        typeof raw === "number" ? raw : raw === "" || raw === undefined || raw === null ? Number.NaN : Number(raw);
      if (Number.isNaN(n)) return false;
      const min = typeof args.min === "number" ? args.min : undefined;
      const max = typeof args.max === "number" ? args.max : undefined;
      return (min === undefined || n >= min) && (max === undefined || n <= max);
    }
    case "email":
      return EMAIL.test(toText(arg("value")));
    case "formatString": {
      const raw = arg("value");
      return typeof raw === "string" ? interpolate(raw, ctx) : "";
    }
    case "and":
      return Array.isArray(args.values) && args.values.every((v) => asResult(resolveDynamic(v, ctx)).valid);
    case "or":
      return Array.isArray(args.values) && args.values.some((v) => asResult(resolveDynamic(v, ctx)).valid);
    case "not":
      return !asResult(arg("value")).valid;
    case "@index":
      return (ctx.index ?? 0) + (typeof args.offset === "number" ? args.offset : 0);
    default:
      return undefined;
  }
}

/** The messages of a component's failing `@checks` (empty when it passes). */
export function failingChecks(component: Json, ctx: EvalContext): string[] {
  const checks = component["@checks"];
  if (!Array.isArray(checks)) return [];
  const out: string[] = [];
  for (const rule of checks as Json[]) {
    const result = asResult(resolveDynamic(rule.condition, ctx));
    if (!result.valid)
      out.push(typeof rule.message === "string" ? rule.message : (result.message ?? "This value is not valid."));
  }
  return out;
}

/** Resolves an action event's context: each value resolved against the data model. */
export function resolveContext(context: unknown, ctx: EvalContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!context || typeof context !== "object") return out;
  for (const [k, v] of Object.entries(context as Json)) out[k] = resolveDynamic(v, ctx);
  return out;
}
