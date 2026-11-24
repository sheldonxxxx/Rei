// Job tokens: the password one read's connections give the reader's own proxy (ADR 0017's per-job token, kept here now
// that the browser lives here). A token is made for one phase of one read, names what its connections may reach, and is
// revoked when the phase ends, so a connection left over from a finished read reaches nothing. The proxy asks
// `decide` (a local function, no control plane) for every connection.
import { randomBytes } from "node:crypto";
import type { Decide, DecideRequest, DecideResponse } from "@rei/forward-proxy";
import { ipFamily, isPrivateAddress, isRefusedAddress, type LocalScope } from "@rei/network";

export const ALLOWED_PORTS: readonly number[] = [80, 443];
export const DEFAULT_MAX_CONNECTIONS = 200;
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const MAX_JOBS = 200;
const ENDED = "This read has ended.";
const LOCAL_DENIED =
  "That address is on the local network, which this read may not reach: the caller must hold the read-local scope and name the address.";

/** Special-use and private-use suffixes no public site lives under (RFC 6761, 6762, 8375 and common LAN names). */
const LOCAL_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "home.arpa",
  "test",
  "invalid",
];

/** Whether a host name (not an IP literal) could be a public site: it has a dot and no special-use suffix. */
export function isPublicName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!name.includes(".")) return false;
  return !LOCAL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

const normalizeHost = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

export type JobSpec =
  | {
      /** The HTTP read: only the hosts the caller allowed, and local addresses only as the caller's scope says. */
      kind: "fetch";
      allowHosts: ReadonlySet<string>;
      localNetworks: LocalScope;
      deadlineMs: number;
    }
  | {
      /** A render: any public host once the start URL was allowed (the page's scripts, styles and APIs), never local. */
      kind: "render";
      deadlineMs: number;
    };

/** What a job's connections did, for the attempt row and the details. */
export interface Traffic {
  connections: number;
  refused: number;
}

export interface JobHandle {
  token: string;
  /** Ends the job: its token is refused from now on. */
  revoke(): Traffic;
}

export interface JobTokens {
  open(spec: JobSpec): JobHandle;
  decide: Decide;
}

interface Job {
  spec: JobSpec;
  deadline: number;
  connections: number;
  refused: number;
}

export interface JobLimits {
  maxConnections: number;
  maxBytes: number;
}

export function createJobTokens(options: { limits?: JobLimits; now?: () => number } = {}): JobTokens {
  const limits = options.limits ?? { maxConnections: DEFAULT_MAX_CONNECTIONS, maxBytes: DEFAULT_MAX_BYTES };
  const now = options.now ?? Date.now;
  const jobs = new Map<string, Job>();
  return {
    open(spec) {
      const t = now();
      for (const [id, job] of jobs) if (job.deadline <= t) jobs.delete(id);
      if (jobs.size >= MAX_JOBS) jobs.delete(jobs.keys().next().value!);
      // The token is the capability: 32 random bytes, kept only in memory, so a restart ends every job.
      const id = randomBytes(24).toString("base64url");
      jobs.set(id, { spec, deadline: t + spec.deadlineMs, connections: 0, refused: 0 });
      return {
        token: `j.${id}`,
        revoke() {
          const job = jobs.get(id);
          jobs.delete(id);
          return { connections: job?.connections ?? 0, refused: job?.refused ?? 0 };
        },
      };
    },
    async decide(request: DecideRequest): Promise<DecideResponse> {
      // The reader's listeners all require a token; a request without one (the browser kind) is not one of ours.
      if (!("token" in request)) return { decision: "deny", message: "A job token is required." };
      const id = request.token.startsWith("j.") ? request.token.slice(2) : undefined;
      const job = id === undefined ? undefined : jobs.get(id);
      const t = now();
      if (!job || job.deadline <= t) {
        if (id !== undefined && job) jobs.delete(id);
        return { decision: "deny", message: ENDED };
      }
      const host = normalizeHost(request.host);
      const refuse = (message: string): DecideResponse => {
        job.refused++;
        return { decision: "deny", message };
      };
      if (host === "" || host.length > 253) return refuse("That destination is not valid.");
      if (!ALLOWED_PORTS.includes(request.port)) return refuse("Only ports 80 and 443 are allowed.");
      const literal = ipFamily(host) !== 0;
      if (job.spec.kind === "fetch") {
        if (!job.spec.allowHosts.has(host)) return refuse("This read is not for that site.");
        if (literal && isRefusedAddress(host)) return refuse("Connections to special addresses are not allowed.");
        if (literal && isPrivateAddress(host) && job.spec.localNetworks === "none") return refuse(LOCAL_DENIED);
      } else {
        // A rendered page never reaches the local network: the proxy also checks every resolved address against "none".
        if (literal && (isPrivateAddress(host) || isRefusedAddress(host))) return refuse(LOCAL_DENIED);
        if (!literal && !isPublicName(host)) return refuse(LOCAL_DENIED);
      }
      if (job.connections >= limits.maxConnections)
        return refuse("This read has opened as many connections as it may.");
      job.connections++;
      return {
        decision: "allow",
        localNetworks: job.spec.kind === "fetch" ? job.spec.localNetworks : "none",
        budget: { bytes: limits.maxBytes, ms: Math.max(1, job.deadline - t) },
      };
    },
  };
}
