// containers/.env: read the way compose does (KEY=VALUE, later lines win), and edited keeping every other line.

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

const unquote = (value: string): string => {
  const v = value.trim();
  if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/\\'/g, "'");
  return v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0]!)
    ? v.slice(1, -1)
    : v.replace(/\s+#.*$/, "");
};

export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) out.set(m[1]!, unquote(m[2]!));
  }
  return out;
}

/** The keys a dotenv text declares, in order, first occurrence first. */
export function envKeys(text: string): string[] {
  const seen: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m && !seen.includes(m[1]!)) seen.push(m[1]!);
  }
  return seen;
}

/** Sets KEY=value: the first line for the key is replaced, further ones dropped, a missing key is appended. */
export function setDotenv(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => LINE.exec(l)?.[1] === key);
  if (at < 0) {
    const body = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    return `${body}${key}=${value}\n`;
  }
  return lines
    .filter((l, i) => i <= at || LINE.exec(l)?.[1] !== key)
    .map((l, i) => (i === at ? `${key}=${value}` : l))
    .join("\n");
}

/** Takes `item` out of a comma-separated value (COMPOSE_PROFILES); an emptied list stays as `KEY=`. Unchanged text if it is not there. */
export function removeFromList(text: string, key: string, item: string): string {
  const lines = text.split("\n");
  let changed = false;
  const out = lines.map((l) => {
    const m = LINE.exec(l);
    if (m?.[1] !== key) return l;
    const items = unquote(m[2]!)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!items.includes(item)) return l;
    changed = true;
    return `${key}=${items.filter((s) => s !== item).join(",")}`;
  });
  return changed ? out.join("\n") : text;
}

/** Literal Compose .env value, including profile templates containing ${...}. */
export function literalDotenv(value: string): string {
  if (!/[\s'"$\\]/.test(value)) return value;
  return "'" + value.replace(/'/g, "\\'") + "'";
}
