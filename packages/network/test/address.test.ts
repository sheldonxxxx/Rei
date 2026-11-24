import { describe, expect, it } from "vitest";
import { type Cidr, interfaceCidrs, isRefusedAddress, parseCidr, parseCidrList } from "../src/address.ts";

// Never reachable: loopback, link-local, 0/8, multicast and reserved, the VM's 198.18.0.0/15, and what does not parse.
const REFUSED = [
  // IPv4: each range's first and last address, plus a middle one
  "0.0.0.0",
  "0.1.2.3",
  "0.255.255.255",
  "127.0.0.1",
  "127.255.255.255",
  "169.254.0.1",
  "169.254.169.254",
  "169.254.255.255",
  "192.0.0.0",
  "192.0.0.8",
  "192.0.0.255",
  "198.18.0.0",
  "198.19.249.3",
  "198.19.255.255",
  "224.0.0.1",
  "239.255.255.255",
  "240.0.0.1",
  "255.255.255.255",
  // IPv6
  "::",
  "::1",
  "0:0:0:0:0:0:0:1",
  "fe80::1",
  "febf::1",
  "fec0::1",
  "feff::1",
  "fec0:ffff::1",
  "ff00::1",
  "ff02::1",
  "ff0e::1",
  // IPv4-mapped, dotted and hex forms
  "::ffff:127.0.0.1",
  "::ffff:169.254.169.254",
  "::ffff:7f00:1",
  "::ffff:a9fe:a9fe",
  "0:0:0:0:0:ffff:7f00:1",
  // NAT64 and 6to4 embedding a refused IPv4, local-use NAT64, IPv4-compatible
  "64:ff9b::127.0.0.1",
  "64:ff9b::7f00:1",
  "64:ff9b::a9fe:a9fe",
  "64:ff9b:1::1",
  "2002:7f00:1::",
  "2002:a9fe:a9fe::1",
  "::10.0.0.1",
  "::8.8.8.8",
  // not an address at all, or a zone id: refused
  "",
  "not-an-ip",
  "example.com",
  "1.2.3",
  "256.1.1.1",
  "1.2.3.4.5",
  "fe80::1%eth0",
  "::g",
  "1::2::3",
];

// The user's own network is reachable: the private ranges, carrier-grade NAT (Tailscale) and IPv6 unique local.
const ALLOWED = [
  "10.0.0.0",
  "10.0.0.5",
  "10.1.2.3",
  "10.255.255.255",
  "100.64.0.0",
  "100.100.1.1",
  "100.100.100.100",
  "100.127.255.255",
  "172.16.0.0",
  "172.20.1.1",
  "172.31.255.255",
  "192.168.0.1",
  "192.168.1.10",
  "192.168.255.255",
  "fc00::1",
  "fd12::1",
  "fd12:3456::1",
  "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  "::ffff:10.0.0.1",
  "::ffff:192.168.1.10",
  "::ffff:a00:1",
  "0:0:0:0:0:ffff:c0a8:1",
  "64:ff9b::10.0.0.1",
  "64:ff9b::a00:1",
  "2002:a00:1::",
  "2002:c0a8:101::1",
];

const PUBLIC = [
  "1.1.1.1",
  "8.8.8.8",
  "93.184.216.34",
  "223.255.255.255",
  "100.63.255.255",
  "100.128.0.0",
  "172.15.255.255",
  "172.32.0.0",
  "169.253.255.255",
  "169.255.0.0",
  "192.0.1.1",
  "192.0.2.1",
  "192.167.255.255",
  "192.169.0.0",
  "198.17.255.255",
  "198.20.0.0",
  "11.0.0.1",
  "9.255.255.255",
  "126.255.255.255",
  "128.0.0.1",
  "2606:4700:4700::1111",
  "2001:4860:4860::8888",
  "2a00:1450:4001::200e",
  "fbff::1",
  "::ffff:8.8.8.8",
  "::ffff:808:808",
  "64:ff9b::8.8.8.8",
  "64:ff9b::808:808",
  "2002:808:808::1",
];

const cidr = (text: string): Cidr => {
  const parsed = parseCidr(text);
  if (!parsed) throw new Error(`bad test CIDR ${text}`);
  return parsed;
};

describe("isRefusedAddress", () => {
  it.each(REFUSED)("refuses %j", (address) => {
    expect(isRefusedAddress(address)).toBe(true);
  });
  it.each([...ALLOWED, ...PUBLIC])("allows %s", (address) => {
    expect(isRefusedAddress(address)).toBe(false);
  });

  describe("with the stack's own networks", () => {
    const stack = [cidr("10.89.232.0/24"), cidr("172.18.0.0/16"), cidr("fd00:abcd::/48")];
    it.each(["10.89.232.2", "10.89.232.255", "172.18.0.1", "172.18.255.254", "fd00:abcd::1", "fd00:abcd:0:ffff::1"])(
      "refuses %s",
      (address) => {
        expect(isRefusedAddress(address, stack)).toBe(true);
      },
    );
    it.each(["10.89.233.1", "10.89.231.10", "172.19.0.1", "172.17.255.255", "192.168.1.10", "fd00:abce::1", "8.8.8.8"])(
      "still allows %s",
      (address) => {
        expect(isRefusedAddress(address, stack)).toBe(false);
      },
    );
    it("applies the IPv4 rule to IPv4-mapped, NAT64 and 6to4 forms", () => {
      for (const address of [
        "::ffff:10.89.232.2",
        "::ffff:a59:e802",
        "64:ff9b::10.89.232.2",
        "2002:a59:e802::1",
        "::ffff:172.18.0.9",
      ]) {
        expect(isRefusedAddress(address, stack), address).toBe(true);
      }
      expect(isRefusedAddress("::ffff:10.89.233.2", stack)).toBe(false);
    });
    it("matches by prefix length, not by octet", () => {
      const narrow = [cidr("192.168.1.128/25"), cidr("100.64.0.0/10")];
      expect(isRefusedAddress("192.168.1.200", narrow)).toBe(true);
      expect(isRefusedAddress("192.168.1.127", narrow)).toBe(false);
      expect(isRefusedAddress("100.100.1.1", narrow)).toBe(true);
      expect(isRefusedAddress("100.128.0.1", narrow)).toBe(false);
      expect(isRefusedAddress("10.1.2.3", [cidr("10.1.2.3/32")])).toBe(true);
      expect(isRefusedAddress("10.1.2.4", [cidr("10.1.2.3/32")])).toBe(false);
    });
  });
});

describe("CIDR parsing", () => {
  it("parses IPv4 and IPv6 networks", () => {
    expect(parseCidr("10.89.232.0/24")).toEqual({ bytes: [10, 89, 232, 0], prefix: 24 });
    expect(parseCidr("0.0.0.0/0")).toEqual({ bytes: [0, 0, 0, 0], prefix: 0 });
    expect(parseCidr("fd00::/8")?.prefix).toBe(8);
    expect(parseCidr("fd00::/8")?.bytes).toHaveLength(16);
  });
  it.each([
    "10.0.0.0",
    "10.0.0.0/",
    "10.0.0.0/33",
    "fd00::/129",
    "10.0.0/24",
    "example.com/24",
    "/24",
    "10.0.0.0/-1",
    "10.0.0.0/2x",
    "fe80::1%eth0/64",
  ])("rejects %j", (text) => {
    expect(parseCidr(text)).toBeNull();
  });
  it("parses a comma-separated list and throws on a bad entry", () => {
    expect(parseCidrList("")).toEqual([]);
    expect(parseCidrList("10.89.231.0/24, 10.89.232.0/24,")).toHaveLength(2);
    expect(() => parseCidrList("10.89.231.0/24,nope")).toThrow("Not a CIDR: nope");
  });
  it("takes the subnets of network interfaces and skips internal ones", () => {
    const cidrs = interfaceCidrs({
      lo: [{ cidr: "127.0.0.1/8", internal: true }],
      eth0: [
        { cidr: "10.89.232.3/24", internal: false },
        { cidr: "fe80::1/64", internal: false },
      ],
      eth1: [{ cidr: null, internal: false }],
      eth2: undefined,
    });
    expect(cidrs.map((c) => c.prefix)).toEqual([24, 64]);
    expect(isRefusedAddress("10.89.232.2", cidrs)).toBe(true);
    expect(isRefusedAddress("10.89.233.2", cidrs)).toBe(false);
  });
});
