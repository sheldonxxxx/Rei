import { addressEntries, addressInScope, ipFamily, type LocalScope, nameWhitelisted } from "@rei/network";
import type { AppStore, RunRow } from "../store/store.ts";
import { fromBase64Url, randomBytes, timingSafeEqual, toBase64Url, utf8 } from "../util/encoding.ts";
import type { Logger } from "../util/log.ts";

/**
 * The sandbox's question carries its run's token; the browser listener's has none: its source network is the identity.
 */
export type EgressRequest =
  | { token: string; host: string; port: number }
  | { source: "browser"; host: string; port: number };
export interface EgressDecision {
  decision: "allow" | "deny";
  message?: string;
  /** On allow: the local-network addresses the destination may reach once the proxy has resolved it. */
  localNetworks?: LocalScope;
}

const normalizeHost = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

/** What a run was told about a destination it could not reach, for the note after its bash call. */
export type EgressBlock = { host: string; reason: string };

/** Where the listener hands a request to (the Node host owns the socket). */
export type EgressHandler = (request: EgressRequest) => Promise<EgressDecision>;
export interface EgressListener {
  start(handler: EgressHandler): Promise<void>;
  stop(): Promise<void>;
}

export const ALLOWED_PORTS: readonly number[] = [80, 443];
const NOT_A_RUN = "This connection does not belong to a running task.";
const BROWSER_IDLE = "The browser is not in use right now.";
const MAX_BLOCKS_PER_RUN = 50;
const MAX_RUNS_TRACKED = 500;

export interface EgressDeps {
  store: AppStore;
  log: Logger;
}

export class EgressService {
  readonly #d: EgressDeps;
  /** Random per process: a restart invalidates every token. */
  readonly #secret = randomBytes(32);
  #key: Promise<CryptoKey> | undefined;
  readonly #blocks = new Map<string, EgressBlock[]>();
  /** Blocks dropped from the front of a run's list so far, so marks stay valid. */
  readonly #dropped = new Map<string, number>();
  /** Whether the agent computer's browser is in use (a window with a running run, a takeover, recent work); unset: never. */
  #browserInUse: (() => boolean) | undefined;

  constructor(deps: EgressDeps) {
    this.#d = deps;
  }

  #hmac(): Promise<CryptoKey> {
    this.#key ??= crypto.subtle.importKey("raw", this.#secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return this.#key;
  }
  async #mac(text: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.sign("HMAC", await this.#hmac(), utf8(text)));
  }

  /** `<runId>.<base64url HMAC of the run id>`. */
  async issue(runId: string): Promise<string> {
    return `${runId}.${toBase64Url(await this.#mac(runId))}`;
  }

  /** The run a token belongs to, only while that run is running. */
  async verify(token: string): Promise<RunRow | undefined> {
    const dot = token.indexOf(".");
    if (dot <= 0 || token.length > 200) return undefined;
    const runId = token.slice(0, dot);
    let given: Uint8Array;
    try {
      given = fromBase64Url(token.slice(dot + 1));
    } catch {
      return undefined;
    }
    if (!timingSafeEqual(given, await this.#mac(runId))) return undefined;
    const run = this.#d.store.getRun(runId);
    return run?.status === "running" ? run : undefined;
  }

  /** The browser feature sets this: the browser listener's connections are allowed only while it returns true. */
  setBrowserGate(inUse: () => boolean): void {
    this.#browserInUse = inUse;
  }

  /**
   * A connection from the browser's listener. There is no approval at this layer: which site a session may visit is
   * decided by the browser tools (policy), so here a connection only has to belong to a browser that is being used.
   * Idle windows' background traffic is refused.
   */
  #decideBrowser(request: { host: string; port: number }): EgressDecision {
    const { log } = this.#d;
    const host = normalizeHost(request.host);
    if (host === "" || host.length > 253) return { decision: "deny", message: "That destination is not valid." };
    const fields = { host, port: request.port, source: "browser" };
    if (!ALLOWED_PORTS.includes(request.port)) {
      log.info("egress.denied", { ...fields, reason: "port" });
      return { decision: "deny", message: "Only ports 80 and 443 are allowed." };
    }
    if (!this.#browserInUse?.()) {
      log.info("egress.denied", { ...fields, reason: "idle" });
      return { decision: "deny", message: BROWSER_IDLE };
    }
    log.debug("egress.allowed", fields);
    // The browser keeps its reach to the user's network: its only limit is the stack's own networks, which the proxy refuses.
    return { decision: "allow", localNetworks: "all" };
  }

  /**
   * The local-network addresses a read of these hosts may reach (web_fetch asks the shared reader with this, ADR 0020): the
   * scope the agent's network setting gives every one of them, or none when they differ. A host the setting does not open
   * reaches nothing local.
   */
  localNetworksFor(agentId: string, hosts: readonly string[]): LocalScope {
    let first: string | undefined;
    let scope: LocalScope = "none";
    for (const host of hosts) {
      const { localNetworks } = this.#verdict(agentId, normalizeHost(host));
      const key = JSON.stringify(localNetworks);
      if (first === undefined) {
        first = key;
        scope = localNetworks;
      } else if (first !== key) return "none";
    }
    return scope;
  }

  #verdict(agentId: string, host: string): { via?: "any" | "whitelist"; localNetworks: LocalScope } {
    const { store } = this.#d;
    const mode = store.getAgent(agentId)?.networkMode ?? "block";
    if (mode === "any") return { via: "any", localNetworks: "all" };
    if (mode !== "whitelist") return { localNetworks: "none" };
    const whitelist = store.sandboxWhitelist();
    const addresses = addressEntries(whitelist);
    const open = ipFamily(host) !== 0 ? addressInScope(host, addresses) : nameWhitelisted(whitelist, host);
    return open ? { via: "whitelist", localNetworks: addresses } : { localNetworks: "none" };
  }

  // ---- what the proxy asks ----------------------------------------------------------------------------------------

  async decide(request: EgressRequest): Promise<EgressDecision> {
    const { store, log } = this.#d;
    if ("source" in request) return this.#decideBrowser(request);
    const run = await this.verify(request.token);
    const session = run ? store.getSessionRow(run.session_id) : undefined;
    if (!run || !session) return { decision: "deny", message: NOT_A_RUN };
    const host = normalizeHost(request.host);
    const { port } = request;
    if (host === "" || host.length > 253) return { decision: "deny", message: "That destination is not valid." };
    if (!ALLOWED_PORTS.includes(port)) return this.#deny(run.id, host, "Only ports 80 and 443 are allowed.");

    const verdict = this.#verdict(session.agent_id, host);
    if (!verdict.via) {
      const message =
        store.getAgent(session.agent_id)?.networkMode === "whitelist"
          ? "The destination is outside the sandbox whitelist."
          : "Sandbox network access is blocked.";
      return this.#deny(run.id, host, message);
    }

    store.addTaint(session.id, ["external"]);
    log.debug("egress.allowed", { sessionId: session.id, runId: run.id, host, port, via: verdict.via });
    return { decision: "allow", localNetworks: verdict.localNetworks };
  }

  #deny(runId: string, host: string, reason: string): EgressDecision {
    this.#d.log.info("egress.denied", { runId, host, reason });
    this.#record(runId, { host, reason });
    return { decision: "deny", message: reason };
  }

  // ---- what the bash tool needs ----------------------------------------------------------------------------------

  #record(runId: string, block: EgressBlock): void {
    let list = this.#blocks.get(runId);
    if (!list) {
      list = [];
      this.#blocks.set(runId, list);
      // Runs that ended are never asked about again; keep the map small.
      if (this.#blocks.size > MAX_RUNS_TRACKED) {
        const oldest = this.#blocks.keys().next().value;
        if (oldest !== undefined) {
          this.#blocks.delete(oldest);
          this.#dropped.delete(oldest);
        }
      }
    }
    list.push(block);
    if (list.length > MAX_BLOCKS_PER_RUN) {
      list.shift();
      this.#dropped.set(runId, (this.#dropped.get(runId) ?? 0) + 1);
    }
  }

  /** A position in a run's block log; `blocksSince` returns what was recorded after it. */
  mark(runId: string): number {
    return (this.#dropped.get(runId) ?? 0) + (this.#blocks.get(runId)?.length ?? 0);
  }

  /** The blocks recorded after `mark`, one per host. */
  blocksSince(runId: string, mark: number): EgressBlock[] {
    const list = this.#blocks.get(runId) ?? [];
    const from = Math.max(0, mark - (this.#dropped.get(runId) ?? 0));
    const byHost = new Map<string, EgressBlock>();
    for (const block of list.slice(from)) {
      if (!byHost.has(block.host)) byHost.set(block.host, block);
    }
    return [...byHost.values()];
  }
}

/** The note after a bash call for a block the run hit, in the words the model is told to act on. */
export function blockNote(block: EgressBlock): string {
  return `[Network access to ${block.host} is not allowed: ${block.reason.replace(/[.\s]+$/, "")}. Do not retry or work around it.]`;
}
