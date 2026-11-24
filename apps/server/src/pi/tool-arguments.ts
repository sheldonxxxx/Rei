// The error text the model sees when arguments fail validation.

/** The top-level fields a tool declares, read from its JSON Schema. */
export interface ToolFields {
  names: string[];
  required: Set<string>;
}

/** Meta fields Rei adds to every tool; never named in hints. */
const META_FIELDS = new Set(["_activity"]);

/** The declared top-level fields of an object schema, without Rei's meta fields. */
export function toolFields(parameters: unknown): ToolFields {
  const schema = (parameters ?? {}) as { properties?: Record<string, unknown>; required?: unknown };
  const names = Object.keys(schema.properties ?? {}).filter((name) => !META_FIELDS.has(name));
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === "string") : []);
  return { names, required };
}

/** pi-ai appends the whole argument JSON after this marker, to validation and JSON parse errors alike. */
const RECEIVED = "\n\nReceived arguments:";
/** A top-level field the model left out or invented, in pi-ai's `  - path: message` lines. */
const TOP_LEVEL_FIELD_ERROR = /^\s*- [^.\s]+: (missing|unknown field)\s*$/m;
const MAX_HINT_FIELDS = 30;

/**
 * The argument error without the echoed arguments: the model already has them in its own call, and echoing a long
 * body doubles it in context. When a top-level field is missing or unknown, one line names the accepted fields.
 */
export function conciseArgumentError(message: string, fields?: ToolFields): string {
  const cut = message.indexOf(RECEIVED);
  let text = (cut >= 0 ? message.slice(0, cut) : message).trimEnd();
  if (fields && fields.names.length > 0 && TOP_LEVEL_FIELD_ERROR.test(text)) {
    const shown = fields.names
      .slice(0, MAX_HINT_FIELDS)
      .map((name) => (fields.required.has(name) ? `${name} (required)` : name));
    const more = fields.names.length > MAX_HINT_FIELDS ? `, and ${fields.names.length - MAX_HINT_FIELDS} more` : "";
    text += `\nAccepted fields: ${shown.join(", ")}${more}.`;
  }
  return text;
}
