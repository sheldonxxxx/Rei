// The stack's fixed subnets (REI_NET.231.0/24 … REI_NET.238.0/24) must be free: Docker refuses a network whose subnet
// overlaps another one, so a second stack left on the first one's REI_NET, or any other network on those addresses, stops
// `up` with "Pool overlaps". The stack's own networks are expected there; anything else is named. Read-only.
import type { Ctx } from "../ctx.ts";
import type { CheckResult } from "../format.ts";
import { firstLine, ok, warn } from "../format.ts";
import { projectPrefix, SUBNETS, stackNet } from "../stack.ts";

/** An IPv4 CIDR as [first, last] address numbers, or undefined (IPv6, or not a CIDR). */
function range(cidr: string): [number, number] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return undefined;
  const bytes = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (bytes.some((b) => b > 255) || prefix > 32) return undefined;
  const address = bytes.reduce((n, b) => n * 256 + b, 0);
  const size = 2 ** (32 - prefix);
  const first = Math.floor(address / size) * size;
  return [first, first + size - 1];
}

const overlaps = (a: [number, number], b: [number, number]): boolean => a[0] <= b[1] && b[0] <= a[1];

/** `docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}'` lines: name and its subnets. */
export function parseNetworks(text: string): { name: string; subnets: string[] }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((words) => words[0])
    .map(([name, ...subnets]) => ({ name: name!, subnets }));
}

/** Which other networks hold one of the stack's subnets: "name (subnet)" for each. */
export function clashes(networks: { name: string; subnets: string[] }[], net: string, project: string): string[] {
  const found: string[] = [];
  for (const { octet, network } of SUBNETS) {
    const ours = range(`${net}.${octet}.0/24`);
    if (!ours) continue;
    for (const { name, subnets } of networks) {
      if (name === network(project)) continue;
      for (const subnet of subnets) {
        const theirs = range(subnet);
        if (theirs && overlaps(ours, theirs)) found.push(`${name} (${subnet})`);
      }
    }
  }
  return [...new Set(found)];
}

export async function subnetCheck(ctx: Ctx): Promise<CheckResult> {
  const net = stackNet(ctx.env);
  const wanted = `${net}.231.0/24 to ${net}.238.0/24`;
  const ids = await ctx.runner.run("docker", ["network", "ls", "-q"], { timeoutMs: 30_000 });
  if (ids.code !== 0)
    return warn(`could not list docker networks (${firstLine(ids.stderr, 100) || `exit ${ids.code}`})`);
  const list = ids.stdout.split(/\s+/).filter(Boolean);
  if (list.length === 0) return ok(`${wanted} free`);
  const inspected = await ctx.runner.run(
    "docker",
    ["network", "inspect", "-f", "{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}", ...list],
    { timeoutMs: 30_000 },
  );
  if (inspected.code !== 0)
    return warn(`could not inspect docker networks (${firstLine(inspected.stderr, 100) || `exit ${inspected.code}`})`);
  const taken = clashes(parseNetworks(inspected.stdout), net, projectPrefix(ctx.env));
  if (taken.length === 0) return ok(`${wanted} free for this stack (REI_NET ${net})`);
  return warn(
    `another network uses this stack's subnets (REI_NET ${net}): ${taken.slice(0, 4).join(", ")}${taken.length > 4 ? ", …" : ""}`,
    "set REI_NET in containers/.env to two octets no other network uses (for example 10.90), or remove that network",
  );
}
