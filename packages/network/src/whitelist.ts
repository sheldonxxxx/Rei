// The sandbox whitelist: destinations a restricted agent may reach without asking, and the local-network addresses it may
// reach. An entry is an exact host name ("pypi.org"), a wildcard for subdomains ("*.github.com"), an IP address
// ("192.168.1.20") or a network ("10.0.0.0/24"). Pure, so it has its own tests.
import { addressInCidr, ipFamily, parseCidr } from "./address.ts";

/** The package registries and repository hosts every new install starts with. The user may edit the list. */
export const DEFAULT_SANDBOX_WHITELIST: readonly string[] = [
  "pypi.org",
  "files.pythonhosted.org",
  "registry.npmjs.org",
  "github.com",
  "objects.githubusercontent.com",
  "codeload.github.com",
];

export const MAX_WHITELIST_ENTRIES = 200;

/**
 * Which local-network addresses a destination may reach: "all", "none", or the entries (IP addresses and networks) that
 * name them. Decided by name in the control plane; the egress proxy checks each resolved address against it.
 */
export type LocalScope = "all" | "none" | string[];

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A host name as a destination compares it: lower case, no brackets, no trailing dot. */
export function normalizeDestination(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/** The entry in its stored form, or null when it is not a host name, a wildcard, an IP address or a network. */
export function normalizeWhitelistEntry(text: string): string | null {
  const entry = text.trim().toLowerCase().replace(/\.$/, "");
  if (entry === "" || entry.length > 253) return null;
  if (entry.includes("/")) return parseCidr(entry) ? entry : null;
  if (ipFamily(entry) !== 0) return entry;
  const wildcard = entry.startsWith("*.");
  const name = wildcard ? entry.slice(2) : entry;
  if (name === "" || name.length > 253) return null;
  return name.split(".").every((label) => LABEL.test(label)) ? entry : null;
}

/**
 * The whitelist as it is stored: every entry normalized, duplicates dropped, order kept. Null when an entry is not valid
 * or there are too many, so the caller can refuse the whole list.
 */
export function normalizeWhitelist(entries: readonly string[]): string[] | null {
  if (entries.length > MAX_WHITELIST_ENTRIES) return null;
  const out: string[] = [];
  for (const text of entries) {
    const entry = normalizeWhitelistEntry(text);
    if (entry === null) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** The entries that name addresses rather than host names: IP addresses and networks. */
export function addressEntries(entries: readonly string[]): string[] {
  return entries.filter((entry) => entry.includes("/") || ipFamily(entry) !== 0);
}

/** True when a local-network address is inside the scope. */
export function addressInScope(address: string, scope: LocalScope): boolean {
  if (scope === "all") return true;
  if (scope === "none") return false;
  return scope.some((entry) => {
    if (entry.includes("/")) {
      const cidr = parseCidr(entry);
      return cidr !== null && addressInCidr(address, cidr);
    }
    return normalizeDestination(entry) === normalizeDestination(address);
  });
}

/**
 * True when a host name is on the whitelist by name: an exact name entry, or a wildcard entry for its subdomains. Network
 * entries never match a name, and neither does a name entry match an address. A local-network address needs both: its
 * name on the whitelist, and the address itself named by an address entry (see addressEntries and addressInScope).
 */
export function nameWhitelisted(entries: readonly string[], host: string): boolean {
  const name = normalizeDestination(host);
  return entries.some((entry) => {
    if (entry.includes("/")) return false;
    if (entry === name) return true;
    return entry.startsWith("*.") && name.endsWith(`.${entry.slice(2)}`);
  });
}
