// Which addresses the proxy must never connect to. The user's own network is reachable (10/8, 172.16/12, 192.168/16,
// 100.64/10 where Tailscale lives, fc00::/7): the agent is meant to work with the router, the NAS and the tailnet.
// Refused: loopback, link-local (169.254.0.0/16 holds cloud metadata services), 0/8, multicast and reserved ranges, the
// VM's own 198.18.0.0/15, anything that does not parse, and the stack's own networks, given as CIDRs, because from there a
// page in the browser could reach Chromium's DevTools port or another container through the proxy. Those CIDRs are the
// subnets of the proxy's own interfaces plus the ones in EGRESS_REFUSE_CIDRS (see main.ts).
// Pure, so it has its own table tests.

function parseIPv4(text: string): number[] | null {
  const parts = text.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

/** 4 for an IPv4 address, 6 for an IPv6 address, 0 for text that is neither (the same answer as node:net's isIP). */
export function ipFamily(text: string): 0 | 4 | 6 {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return parseIPv4(text) ? 4 : 0;
  if (text.includes(":")) return parseIPv6(text) ? 6 : 0;
  return 0;
}

/** Eight 16-bit groups of an IPv6 address, or null when it does not parse. */
function parseIPv6(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    const out: number[] = [];
    if (part === "") return out;
    for (const piece of part.split(":")) {
      if (piece.includes(".")) {
        const v4 = parseIPv4(piece);
        if (!v4) return null;
        out.push(v4[0]! * 256 + v4[1]!, v4[2]! * 256 + v4[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
        out.push(parseInt(piece, 16));
      }
    }
    return out;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill >= 1 ? [...head, ...new Array<number>(fill).fill(0), ...tail] : null;
}

/** A network: 4 bytes (IPv4) or 16 bytes (IPv6) and a prefix length in bits. */
export interface Cidr {
  bytes: number[];
  prefix: number;
}

const v6Bytes = (groups: number[]): number[] => groups.flatMap((g) => [g >> 8, g & 255]);

/** "10.89.232.0/24" or "fd00::/8", or null when it does not parse. The address bits past the prefix are ignored. */
export function parseCidr(text: string): Cidr | null {
  const slash = text.indexOf("/");
  if (slash < 1 || !/^\d{1,3}$/.test(text.slice(slash + 1))) return null;
  const address = text.slice(0, slash);
  const family = ipFamily(address);
  const parsed = family === 4 ? parseIPv4(address) : family === 6 ? parseIPv6(address) : null;
  if (!parsed) return null;
  const bytes = family === 4 ? parsed : v6Bytes(parsed);
  const prefix = Number(text.slice(slash + 1));
  return prefix <= bytes.length * 8 ? { bytes, prefix } : null;
}

/** A comma-separated list of CIDRs; an entry that does not parse throws, so a typo cannot silently drop a refusal. */
export function parseCidrList(text: string): Cidr[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const cidr = parseCidr(entry);
      if (!cidr) throw new Error(`Not a CIDR: ${entry}`);
      return cidr;
    });
}

/** The subnets the given network interfaces (os.networkInterfaces()) are on; loopback and other internal ones are skipped. */
export function interfaceCidrs(
  interfaces: Record<string, { cidr?: string | null; internal: boolean }[] | undefined>,
): Cidr[] {
  const out: Cidr[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const cidr = entry.internal || !entry.cidr ? null : parseCidr(entry.cidr);
      if (cidr) out.push(cidr);
    }
  }
  return out;
}

function inside({ bytes, prefix }: Cidr, address: number[]): boolean {
  if (bytes.length !== address.length) return false;
  for (let i = 0; i * 8 < prefix; i++) {
    const bits = Math.min(8, prefix - i * 8);
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((bytes[i]! & mask) !== (address[i]! & mask)) return false;
  }
  return true;
}

// The IPv4 ranges that are never reachable. The private ones (10/8, 172.16/12, 192.168/16, 100.64/10) are not here.
function specialIPv4(address: number[], extra: readonly Cidr[]): boolean {
  const [a, b, c] = address as [number, number, number];
  return (
    a === 0 || // 0.0.0.0/8
    a === 127 ||
    (a === 169 && b === 254) || // link-local, including the cloud metadata address
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15: OrbStack's own VM network
    a >= 224 || // multicast 224/4 and reserved 240/4
    extra.some((cidr) => inside(cidr, address))
  );
}

const v4Of = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255];

/** True when the proxy must refuse to connect to this IP address (also for text that is not an IP address). */
export function isRefusedAddress(address: string, extra: readonly Cidr[] = []): boolean {
  const family = ipFamily(address);
  if (family === 4) return specialIPv4(parseIPv4(address) ?? [0, 0, 0, 0], extra);
  if (family !== 6) return true;
  const g = parseIPv6(address);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  // The forms that carry an IPv4 address follow the IPv4 rule.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff) return specialIPv4(v4Of(g6, g7), extra); // IPv4-mapped
    if (g5 === 0) return true; // ::/96: unspecified, loopback, IPv4-compatible
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return specialIPv4(v4Of(g6, g7), extra); // NAT64
    if (g2 === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  }
  if (g0 === 0x2002) return specialIPv4(v4Of(g1, g2), extra); // 6to4 embeds an IPv4 address
  return (
    (g0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g0 & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (g0 & 0xff00) === 0xff00 || // ff00::/8 multicast
    extra.some((cidr) => inside(cidr, v6Bytes(g)))
  );
}

const PRIVATE_IPV4 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"].map((text) => parseCidr(text)!);

const privateIPv4 = (address: number[]): boolean => PRIVATE_IPV4.some((cidr) => inside(cidr, address));

/**
 * True when the address is on the user's own network: 10/8, 172.16/12, 192.168/16, 100.64/10 (Tailscale), fc00::/7, and an
 * IPv4 address carried inside an IPv6 one (mapped, NAT64, 6to4). Text that is not an IP address is not private.
 */
export function isPrivateAddress(address: string): boolean {
  const family = ipFamily(address);
  if (family === 4) return privateIPv4(parseIPv4(address) ?? [0, 0, 0, 0]);
  if (family !== 6) return false;
  const g = parseIPv6(address);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return privateIPv4(v4Of(g6, g7)); // IPv4-mapped and IPv4-compatible
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return privateIPv4(v4Of(g6, g7));
  if (g0 === 0x2002) return privateIPv4(v4Of(g1, g2)); // 6to4
  return (g0 & 0xfe00) === 0xfc00; // fc00::/7 unique local
}

/** True when the address (an IP literal) is inside the network. A different family is never inside. */
export function addressInCidr(address: string, cidr: Cidr): boolean {
  const family = ipFamily(address);
  if (family === 4) return cidr.bytes.length === 4 && inside(cidr, parseIPv4(address) ?? [0, 0, 0, 0]);
  if (family === 6) {
    const groups = parseIPv6(address);
    return groups !== null && cidr.bytes.length === 16 && inside(cidr, v6Bytes(groups));
  }
  return false;
}
