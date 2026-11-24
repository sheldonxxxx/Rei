# Knowledge frontmatter is an interchange format

Knowledge keeps canonical page properties and the Markdown body separately in SQLite, consistent with ADR 0001; YAML frontmatter is parsed on explicit source input and generated for source editing and export. This avoids competing editable representations while preserving portable Markdown: round-tripping preserves the meaning of Rei's supported properties, not YAML comments, key order, quoting or formatting. V1 rejects unsupported frontmatter fields with actionable validation errors rather than retaining arbitrary properties.
