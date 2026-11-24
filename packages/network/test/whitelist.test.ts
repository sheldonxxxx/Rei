import { describe, expect, it } from "vitest";
import { addressInCidr, isPrivateAddress, parseCidr } from "../src/address.ts";
import {
  addressEntries,
  addressInScope,
  DEFAULT_SANDBOX_WHITELIST,
  MAX_WHITELIST_ENTRIES,
  nameWhitelisted,
  normalizeWhitelist,
  normalizeWhitelistEntry,
} from "../src/whitelist.ts";

describe("isPrivateAddress", () => {
  it("is true for the user's own network", () => {
    for (const address of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.20", "100.100.1.1", "fd7a:115c::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("::ffff:192.168.1.20")).toBe(true);
    expect(isPrivateAddress("64:ff9b::c0a8:0101")).toBe(true);
    expect(isPrivateAddress("2002:c0a8:0101::1")).toBe(true);
  });
  it("is false for public addresses, edges of the private ranges, and text that is not an address", () => {
    for (const address of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "example.com"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe("addressInCidr", () => {
  it("matches inside the network only, and never across families", () => {
    const net = parseCidr("10.0.0.0/24")!;
    expect(addressInCidr("10.0.0.7", net)).toBe(true);
    expect(addressInCidr("10.0.1.7", net)).toBe(false);
    expect(addressInCidr("2001:db8::1", net)).toBe(false);
    expect(addressInCidr("pypi.org", net)).toBe(false);
    expect(addressInCidr("2001:db8::1", parseCidr("2001:db8::/32")!)).toBe(true);
    expect(addressInCidr("10.0.0.7", parseCidr("2001:db8::/32")!)).toBe(false);
  });
});

describe("normalizeWhitelistEntry", () => {
  it("accepts host names, wildcards, IP addresses and networks, lower-cased", () => {
    expect(normalizeWhitelistEntry(" PyPI.org. ")).toBe("pypi.org");
    expect(normalizeWhitelistEntry("*.GitHub.com")).toBe("*.github.com");
    expect(normalizeWhitelistEntry("nas")).toBe("nas");
    expect(normalizeWhitelistEntry("192.168.1.20")).toBe("192.168.1.20");
    expect(normalizeWhitelistEntry("10.0.0.0/24")).toBe("10.0.0.0/24");
    expect(normalizeWhitelistEntry("fd00::/8")).toBe("fd00::/8");
  });
  it("refuses anything else", () => {
    for (const bad of [
      "",
      "https://pypi.org",
      "pypi.org/simple",
      "pypi.org:443",
      "*",
      "*.",
      "a b.com",
      "10.0.0.0/33",
      "a..b",
      "-x.com",
      "x_y.com",
      "*.*.com",
    ]) {
      expect(normalizeWhitelistEntry(bad), bad).toBeNull();
    }
    expect(normalizeWhitelistEntry("a".repeat(254))).toBeNull();
  });
});

describe("normalizeWhitelist", () => {
  it("drops duplicates, keeps order, and refuses a bad entry or too many", () => {
    expect(normalizeWhitelist(["pypi.org", "PYPI.org", "github.com"])).toEqual(["pypi.org", "github.com"]);
    expect(normalizeWhitelist(["pypi.org", "bad host"])).toBeNull();
    expect(normalizeWhitelist(Array.from({ length: MAX_WHITELIST_ENTRIES + 1 }, (_, i) => `h${i}.com`))).toBeNull();
    expect(normalizeWhitelist([])).toEqual([]);
  });
  it("starts with the registries and repository hosts", () => {
    expect(normalizeWhitelist([...DEFAULT_SANDBOX_WHITELIST])).toEqual([...DEFAULT_SANDBOX_WHITELIST]);
    expect(DEFAULT_SANDBOX_WHITELIST).toContain("pypi.org");
    expect(DEFAULT_SANDBOX_WHITELIST).toContain("registry.npmjs.org");
  });
});

describe("nameWhitelisted", () => {
  const list = ["pypi.org", "*.github.com", "nas", "192.168.1.20", "10.0.0.0/24"];
  it("matches an exact name, a wildcard subdomain, and not the apex of a wildcard", () => {
    expect(nameWhitelisted(list, "pypi.org")).toBe(true);
    expect(nameWhitelisted(list, "API.GitHub.com")).toBe(true);
    expect(nameWhitelisted(list, "github.com")).toBe(false);
    expect(nameWhitelisted(list, "evil-pypi.org")).toBe(false);
    expect(nameWhitelisted(list, "pypi.org.evil.com")).toBe(false);
  });
  it("matches a name entry, and an IP address entry only for that exact address", () => {
    expect(nameWhitelisted(list, "nas")).toBe(true);
    expect(nameWhitelisted(list, "192.168.1.20")).toBe(true);
    expect(nameWhitelisted(list, "192.168.1.21")).toBe(false);
  });
  it("never matches a name by a network entry, so a name needs its own entry", () => {
    expect(nameWhitelisted(list, "fileserver.lan")).toBe(false);
    expect(nameWhitelisted(["10.0.0.0/8"], "fileserver.lan")).toBe(false);
    expect(nameWhitelisted(["10.0.0.0/8"], "10.0.0.42")).toBe(false);
  });
  it("matches nothing for an empty whitelist", () => {
    expect(nameWhitelisted([], "pypi.org")).toBe(false);
  });
});

describe("addressInScope", () => {
  it('is all or nothing for "all" and "none"', () => {
    expect(addressInScope("192.168.1.20", "all")).toBe(true);
    expect(addressInScope("192.168.1.20", "none")).toBe(false);
  });
  it("matches an address entry exactly, or inside a network entry", () => {
    const scope = ["192.168.1.20", "10.0.0.0/24"];
    expect(addressInScope("192.168.1.20", scope)).toBe(true);
    expect(addressInScope("192.168.1.21", scope)).toBe(false);
    expect(addressInScope("10.0.0.9", scope)).toBe(true);
    expect(addressInScope("10.0.1.9", scope)).toBe(false);
    expect(addressInScope("10.0.0.9", [])).toBe(false);
  });
  it("takes the address entries out of a whitelist", () => {
    expect(addressEntries(["pypi.org", "192.168.1.20", "10.0.0.0/24", "*.github.com", "fd00::1"])).toEqual([
      "192.168.1.20",
      "10.0.0.0/24",
      "fd00::1",
    ]);
  });
});
