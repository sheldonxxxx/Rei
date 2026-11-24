// Structured results (code mode): what a script receives from a tool that declares `structuredOutputSchema`. The schemas
// are exact because Pi rejects a nested call whose `structuredOutput` is missing or does not match (`invalid_structured_
// output`), and objects are closed unless marked open. The model-facing `output` of these tools is unchanged.

import type { JsonValue } from "@earendil-works/chord/json";

/** A value as plain JSON: `undefined` fields dropped, as `JSON.stringify` does (and as the text output already shows it). */
export const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
