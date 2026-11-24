/** Per-agent sandbox egress policy. The proxy enforces allowed ports and reserved addresses. */
export const SANDBOX_NETWORK_MODES = ["block", "whitelist", "any"] as const;
export type SandboxNetworkMode = (typeof SANDBOX_NETWORK_MODES)[number];

/**
 * GET/PUT /api/settings/sandbox-network: the sites that Whitelist-mode agents reach without asking. Entries are host names
 * ("pypi.org"), wildcards for subdomains ("*.github.com"), IP addresses or networks ("192.168.1.0/24"). `defaults` is what
 * a reset restores. GET answers this; PUT with `{ whitelist }` replaces the list, or `{ reset: true }` restores the defaults.
 * Errors: "bad_request" (an entry that is not valid, or more than 200 entries).
 */
export interface SandboxNetworkSettings {
  whitelist: string[];
  defaults: string[];
}
export type UpdateSandboxNetworkRequest = { whitelist: string[] } | { reset: true };
