/**
 * Text for a prompt section that may be empty now but fill in later in the same session.
 *
 * pi-durable re-sends every section (a remove-all and re-add-all pair) when a section first appears before ones already
 * shown, which breaks the provider's prompt cache and leaves two prompt copies in context. Rendering a short placeholder
 * keeps the section's place, so its first content becomes a small value patch.
 */
export const steadyText = (text: string | undefined, empty: string): string =>
  text === undefined || text.trim() === "" ? empty : text;
