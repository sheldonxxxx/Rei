// MCP connectors in the app server: the gateway holds every connector, token and sign-in; this side keeps the
// policy (does the connector hold the user's data, which class a tool gets) and gives the agent and the Settings screen
// one view of both. The agent's tools and the App API both go through here.
import type {
  Connector,
  ConnectorTool,
  ConnectorToolClass,
  ConnectorToolsResponse,
  GatewayConnector,
  McpCallResult,
  McpProfile,
  McpToolInfo,
} from "@rei/protocol";
import { canonicalJson } from "../policy/decision.ts";
import type { ApprovalStore } from "../store/approvals.ts";
import type { AppStore } from "../store/store.ts";
import type { Clock } from "../util/clock.ts";
import { sha256Hex } from "../util/encoding.ts";
import { badRequest, HttpError, notFound } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";

/** What a grant of an MCP call is made of: connector "mcp", operation "call", destination `<connector id>.<tool>`. */
export const MCP_GRANT_CONNECTOR = "mcp";
export const MCP_GRANT_OPERATION = "call";
export const mcpDestination = (connectorId: string, tool: string): string => `${connectorId}.${tool}`;

/** How long the agent reuses a connector's tool list (the gateway keeps its own cache). */
export const TOOLS_TTL_MS = 60_000;
const GATEWAY_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 90_000;

export const TOOL_CLASSES: readonly ConnectorToolClass[] = ["read_external", "write_external", "send", "irreversible"];
const isToolClass = (value: unknown): value is ConnectorToolClass =>
  typeof value === "string" && (TOOL_CLASSES as readonly string[]).includes(value);
const isMcpProfile = (value: unknown): value is McpProfile =>
  value === "always_ask" || value === "read_only" || value === "read_write" || value === "yolo";

/** Claimed effect, separate from provider authorization. Destructive always takes precedence. */
export function defaultClass(annotations: McpToolInfo["annotations"] | null | undefined): ConnectorToolClass {
  if (annotations?.destructiveHint === true) return "irreversible";
  if (annotations?.readOnlyHint === true) return "read_external";
  return "write_external";
}

export interface McpDeps {
  store: AppStore;
  approvals: ApprovalStore;
  clock: Clock;
  log: Logger;
  /** The gateway's base URL; unset (faux mode): there are no connectors. */
  gatewayUrl: string | undefined;
  token: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch | undefined;
}

/** Why a tool call could not be made, as a sentence for the model. */
export class McpCallError extends Error {}

const readTrustPrefix = (id: string): string => `mcp:read-trust:${encodeURIComponent(id)}:`;
const readTrustKey = (id: string, tool: string): string => `${readTrustPrefix(id)}${encodeURIComponent(tool)}`;
const profileKey = (id: string): string => `mcp:profile:${encodeURIComponent(id)}`;
const providerIdentity = (c: GatewayConnector): Promise<string> =>
  sha256Hex(canonicalJson({ id: c.id, url: c.url, auth: c.auth, tokenHeader: c.tokenHeader, createdAt: c.createdAt }));
const definitionFingerprint = (connector: GatewayConnector, tool: McpToolInfo): Promise<string> =>
  sha256Hex(
    canonicalJson({
      connector: {
        id: connector.id,
        name: connector.name,
        url: connector.url,
        auth: connector.auth,
        tokenHeader: connector.tokenHeader,
        createdAt: connector.createdAt,
      },
      tool,
    }),
  );

export class McpService {
  readonly #d: McpDeps;
  readonly #cache = new Map<string, { at: number; tools: McpToolInfo[]; fetchedAt: number }>();
  readonly #listeners = new Set<(connectorId: string | undefined) => void>();
  /** What the last connector list said (ids, names, addresses and states), to notice changes made elsewhere. */
  #listed: string | undefined;

  constructor(deps: McpDeps) {
    this.#d = deps;
  }

  get #db() {
    return this.#d.store.db;
  }

  // ---- the gateway -------------------------------------------------------------------------------------------------

  async #gateway(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = GATEWAY_TIMEOUT_MS,
    beforeDispatch?: () => void,
  ): Promise<any> {
    const base = this.#d.gatewayUrl;
    if (!base)
      throw new HttpError(503, "gateway_unavailable", "Connectors need the gateway, which isn't running here.");
    const doFetch = this.#d.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const token = await this.#d.token();
    beforeDispatch?.();
    let res: Response;
    try {
      res = await doFetch(`${base.replace(/\/+$/, "")}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new HttpError(502, "gateway_unavailable", "The gateway could not be reached.");
    }
    if (res.status === 204) return undefined;
    let parsed: any;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const info = parsed?.error;
      throw new HttpError(
        res.status >= 400 && res.status < 600 ? res.status : 502,
        typeof info?.code === "string" ? info.code : "connector_unreachable",
        typeof info?.message === "string" ? info.message : "The gateway could not answer that.",
      );
    }
    return parsed;
  }

  // ---- policy rows -------------------------------------------------------------------------------------------------

  holdsPrivate(connectorId: string): boolean {
    const row = this.#db.get<{ holds_private: number }>(
      "SELECT holds_private FROM connector_settings WHERE connector_id = ?",
      connectorId,
    );
    return row ? row.holds_private !== 0 : true;
  }
  #overrides(connectorId: string): Map<string, ConnectorToolClass> {
    const rows = this.#db.all<{ tool: string; action_class: string }>(
      "SELECT tool, action_class FROM tool_overrides WHERE connector_id = ?",
      connectorId,
    );
    return new Map(
      rows.filter((r) => isToolClass(r.action_class)).map((r) => [r.tool, r.action_class as ConnectorToolClass]),
    );
  }
  async effectiveClass(
    connectorId: string,
    tool: McpToolInfo,
    connector?: GatewayConnector,
  ): Promise<ConnectorToolClass> {
    // Owner overrides change classification, but never lower the destructive floor. Consent is separate.
    if (defaultClass(tool.annotations) === "irreversible") return "irreversible";
    const override = this.#overrides(connectorId).get(tool.name);
    if (
      override === "read_external" &&
      (!connector ||
        this.#d.store.metaGet(readTrustKey(connectorId, tool.name)) !== (await definitionFingerprint(connector, tool)))
    )
      return "write_external";
    return override ?? defaultClass(tool.annotations);
  }

  /** Drift removes manual Read overrides permanently; provider-scoped consent is separate. */
  async #invalidateReads(connector: GatewayConnector, tools: McpToolInfo[]): Promise<void> {
    const invalid: { name: string; pin: string | undefined }[] = [];
    for (const [name, actionClass] of this.#overrides(connector.id)) {
      if (actionClass !== "read_external") continue;
      const pin = this.#d.store.metaGet(readTrustKey(connector.id, name));
      const matches = tools.filter((t) => t.name === name);
      if (matches.length === 1 && pin === (await definitionFingerprint(connector, matches[0]!))) continue;
      invalid.push({ name, pin });
    }
    this.#d.store.tx(() => {
      for (const { name, pin } of invalid) {
        // Do not erase a newer owner selection while the digest was being computed.
        if (
          this.#overrides(connector.id).get(name) !== "read_external" ||
          this.#d.store.metaGet(readTrustKey(connector.id, name)) !== pin
        )
          continue;
        this.#db.run("DELETE FROM tool_overrides WHERE connector_id = ? AND tool = ?", connector.id, name);
        this.#d.store.metaSet(readTrustKey(connector.id, name), null);
        this.#d.log.info("connector.read_trust_invalidated", {
          connectorId: connector.id,
          tool: name,
          reason: "missing_or_changed_definition_binding",
        });
      }
    });
  }

  /** Local owner configuration included in both the approval and the final dispatch check. */
  configuration(connectorId: string, tool: string): string {
    return canonicalJson({
      override: this.#overrides(connectorId).get(tool) ?? null,
      readTrust: this.#d.store.metaGet(readTrustKey(connectorId, tool)) ?? null,
      holdsPrivate: this.holdsPrivate(connectorId),
    });
  }

  /** Persisted revision catches profile changes, including change-and-restore, before dispatch. */
  profileAuthority(id: string): string {
    return this.#d.store.metaGet(profileKey(id)) ?? "missing";
  }

  async #profile(c: GatewayConnector): Promise<{ profile: McpProfile; revision: string }> {
    const identity = await providerIdentity(c);
    const stored = this.#d.store.metaGet(profileKey(c.id));
    if (stored) {
      try {
        const row = JSON.parse(stored);
        if (row.identity === identity && isMcpProfile(row.profile) && typeof row.revision === "string" && row.revision)
          return row;
      } catch {
        /* invalid or stale profile resets safely, never to YOLO */
      }
    }
    const profile: McpProfile = "always_ask";
    const row = { identity, profile, revision: crypto.randomUUID() };
    this.#d.store.tx(() => {
      this.#d.store.metaSet(profileKey(c.id), JSON.stringify(row));
    });
    this.#d.log.info(stored ? "connector.mcp_profile_invalidated" : "connector.mcp_profile_initialized", {
      connectorId: c.id,
      profile,
      identity,
      revision: row.revision,
    });
    return row;
  }

  async setProfile(
    id: string,
    profile: McpProfile,
    expectedIdentity: string,
    expectedRevision: string,
    confirmYolo = false,
  ): Promise<Connector> {
    if (!isMcpProfile(profile)) throw badRequest("bad_request", "Unknown MCP permission profile.");
    const c = await this.#find(id);
    if (!c) throw notFound("That connector does not exist.");
    const identity = await providerIdentity(c);
    const current = await this.#profile(c);
    let liveRevision: unknown;
    try {
      liveRevision = JSON.parse(this.profileAuthority(id)).revision;
    } catch {
      /* missing authority fails closed */
    }
    if (expectedIdentity !== identity || expectedRevision !== current.revision || expectedRevision !== liveRevision)
      throw new HttpError(
        409,
        "connector_changed",
        "The connector or its permissions changed. Refresh Settings and review them again.",
      );
    if (profile === "yolo" && !confirmYolo)
      throw badRequest(
        "confirmation_required",
        "YOLO can write, send and permanently delete data without asking. Explicit confirmation is required.",
      );
    const revision = crypto.randomUUID();
    this.#d.store.metaSet(profileKey(id), JSON.stringify({ identity, profile, revision }));
    this.#d.log.info("connector.mcp_profile_changed", { connectorId: id, profile, identity, revision });
    return this.#merge(c);
  }

  // ---- the App API -------------------------------------------------------------------------------------------------

  async #merge(c: GatewayConnector): Promise<Connector> {
    const profile = await this.#profile(c);
    return {
      ...c,
      holdsPrivate: this.holdsPrivate(c.id),
      mcpProfile: profile.profile,
      mcpProfileRevision: profile.revision,
      providerIdentity: await providerIdentity(c),
    };
  }

  /**
   * Calls `listener` when what the connectors offer may have changed: a connector added, renamed, removed or signed in,
   * a state change, or a tool list that differs from the one cached. Returns the unsubscribe function.
   */
  onChange(listener: (connectorId: string | undefined) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #changed(connectorId?: string): void {
    for (const listener of this.#listeners) {
      try {
        listener(connectorId);
      } catch (error) {
        this.#d.log.warn("connector.change_listener_failed", { error: error instanceof Error ? error.name : "error" });
      }
    }
  }

  async list(): Promise<Connector[]> {
    const body = await this.#gateway("GET", "/mcp/connectors");
    const connectors = body.connectors as GatewayConnector[];
    const listed = canonicalJson(connectors.map((c) => [c.id, c.name, c.url, c.status, c.createdAt, c.tokenHeader]));
    const changed = this.#listed !== undefined && this.#listed !== listed;
    this.#listed = listed;
    if (changed) this.#changed();
    return Promise.all(connectors.map((c) => this.#merge(c)));
  }

  async create(input: {
    name: string;
    url: string;
    token?: string;
    tokenHeader?: string;
    ownerKey?: string;
    auth?: "none" | "token" | "oauth";
  }): Promise<Connector> {
    const body = await this.#gateway("POST", "/mcp/connectors", {
      name: input.name,
      url: input.url,
      ...(input.ownerKey ? { ownerKey: input.ownerKey, auth: input.auth } : {}),
      ...(input.token !== undefined ? { token: input.token } : {}),
      ...(input.tokenHeader !== undefined ? { tokenHeader: input.tokenHeader } : {}),
    });
    const connector = body.connector as GatewayConnector;
    this.#d.log.info("connector.created", {
      connectorId: connector.id,
      auth: connector.auth,
      status: connector.status,
    });
    this.#changed(connector.id);
    return this.#merge(connector);
  }

  async update(
    id: string,
    input: { name?: string; token?: string | null; tokenHeader?: string | null; holdsPrivate?: boolean },
  ): Promise<Connector> {
    let connector: GatewayConnector | undefined;
    const authenticationChanged = input.token !== undefined || input.tokenHeader !== undefined;
    if (input.name !== undefined || authenticationChanged) {
      const body = await this.#gateway("PATCH", `/mcp/connectors/${encodeURIComponent(id)}`, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.token !== undefined ? { token: input.token } : {}),
        ...(input.tokenHeader !== undefined ? { tokenHeader: input.tokenHeader } : {}),
      });
      connector = body.connector as GatewayConnector;
      this.#cache.delete(id);
      if (authenticationChanged) {
        this.#d.store.metaSet(
          profileKey(id),
          JSON.stringify({
            identity: await providerIdentity(connector),
            profile: "always_ask",
            revision: crypto.randomUUID(),
          }),
        );
        this.#d.log.info("connector.mcp_profile_invalidated", { connectorId: id, reason: "authentication_changed" });
      }
    }
    if (input.holdsPrivate !== undefined) {
      if (!connector) connector = (await this.#find(id)) ?? undefined;
      if (!connector) throw notFound("That connector does not exist.");
      this.#db.run(
        "INSERT INTO connector_settings (connector_id, holds_private) VALUES (?, ?) ON CONFLICT (connector_id) DO UPDATE SET holds_private = excluded.holds_private",
        id,
        input.holdsPrivate ? 1 : 0,
      );
      this.#d.log.info("connector.holds_private_changed", { connectorId: id, holdsPrivate: input.holdsPrivate });
    }
    if (!connector) throw badRequest("bad_request", "Nothing to change.");
    this.#changed(id);
    return this.#merge(connector);
  }

  async remove(id: string): Promise<void> {
    await this.#gateway("DELETE", `/mcp/connectors/${encodeURIComponent(id)}`);
    this.#cache.delete(id);
    this.#d.store.tx(() => {
      this.#db.run("DELETE FROM connector_settings WHERE connector_id = ?", id);
      this.#db.run("DELETE FROM tool_overrides WHERE connector_id = ?", id);
      this.#d.store.metaSet(profileKey(id), null);
      const prefix = readTrustPrefix(id);
      this.#db.run("DELETE FROM meta WHERE substr(key, 1, ?) = ?", prefix.length, prefix);
      this.#d.approvals.revokeDestinationsOf(MCP_GRANT_CONNECTOR, `${id}.`);
    });
    this.#d.log.info("connector.removed", { connectorId: id });
    this.#changed(id);
  }

  async oauthStart(
    id: string,
    input: { redirectUri: string; clientId?: string; clientSecret?: string },
  ): Promise<string> {
    const body = await this.#gateway("POST", `/mcp/connectors/${encodeURIComponent(id)}/oauth/start`, {
      redirectUri: input.redirectUri,
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      ...(input.clientSecret !== undefined ? { clientSecret: input.clientSecret } : {}),
    });
    if (typeof body?.authorizationUrl !== "string")
      throw new HttpError(502, "oauth_failed", "The gateway gave no sign-in address.");
    return body.authorizationUrl;
  }

  async oauthFinish(input: { state: string; code: string; iss?: string }): Promise<Connector> {
    const body = await this.#gateway("POST", "/mcp/oauth/callback", {
      state: input.state,
      code: input.code,
      ...(input.iss !== undefined ? { iss: input.iss } : {}),
    });
    const connector = body.connector as GatewayConnector;
    this.#cache.delete(connector.id);
    this.#d.log.info("connector.signed_in", { connectorId: connector.id, status: connector.status });
    this.#changed(connector.id);
    return this.#merge(connector);
  }

  async #find(id: string): Promise<GatewayConnector | undefined> {
    const body = await this.#gateway("GET", "/mcp/connectors");
    return (body.connectors as GatewayConnector[]).find((c) => c.id === id);
  }

  /** The tools of a connector, from the cache unless `refresh`. Throws the gateway's error (needs_auth, connector_not_found…). */
  async #toolList(
    id: string,
    refresh: boolean,
    connector: GatewayConnector,
  ): Promise<{ tools: McpToolInfo[]; fetchedAt: number }> {
    const now = this.#d.clock.now();
    const hit = this.#cache.get(id);
    if (!refresh && hit && now - hit.at < TOOLS_TTL_MS) {
      await this.#invalidateReads(connector, hit.tools);
      return hit;
    }
    const body = await this.#gateway(
      "GET",
      `/mcp/connectors/${encodeURIComponent(id)}/tools${refresh ? "?refresh=1" : ""}`,
    );
    const entry = { at: now, tools: (body.tools ?? []) as McpToolInfo[], fetchedAt: Number(body.fetchedAt) || now };
    this.#cache.set(id, entry);
    await this.#invalidateReads(connector, entry.tools);
    if (hit && canonicalJson(hit.tools) !== canonicalJson(entry.tools)) this.#changed(id);
    return entry;
  }

  async tools(id: string, refresh: boolean): Promise<ConnectorToolsResponse> {
    const connector = await this.#find(id);
    if (!connector) throw notFound("That connector does not exist.");
    const { tools, fetchedAt } = await this.#toolList(id, refresh, connector);
    const overrides = this.#overrides(id);
    return {
      tools: await Promise.all(
        tools.map(
          async (t): Promise<ConnectorTool> => ({
            ...t,
            defaultClass: defaultClass(t.annotations),
            override: overrides.get(t.name) ?? null,
            effectiveClass: await this.effectiveClass(id, t, connector),
            definitionFingerprint: await definitionFingerprint(connector, t),
          }),
        ),
      ),
      fetchedAt,
    };
  }

  async setOverride(
    id: string,
    tool: string,
    actionClass: ConnectorToolClass | null,
    expectedFingerprint?: string,
  ): Promise<void> {
    let fingerprint: string | undefined;
    if (actionClass !== null) {
      let resolved;
      try {
        resolved = await this.resolve(id, tool, true);
      } catch (error) {
        if (error instanceof McpCallError) throw new HttpError(409, "tool_changed", error.message);
        throw error;
      }
      if (resolved.connector.id !== id) throw notFound("That connector does not exist.");
      fingerprint = await definitionFingerprint(resolved.connector, resolved.tool);
      if (expectedFingerprint !== undefined && expectedFingerprint !== fingerprint)
        throw new HttpError(
          409,
          "tool_changed",
          "The tool definition changed. Refresh the tools and review it before trusting it again.",
        );
    }
    this.#d.store.tx(() => {
      if (actionClass === null)
        this.#db.run("DELETE FROM tool_overrides WHERE connector_id = ? AND tool = ?", id, tool);
      else
        this.#db.run(
          "INSERT INTO tool_overrides (connector_id, tool, action_class) VALUES (?, ?, ?) ON CONFLICT (connector_id, tool) DO UPDATE SET action_class = excluded.action_class",
          id,
          tool,
          actionClass,
        );
      this.#d.store.metaSet(readTrustKey(id, tool), actionClass === "read_external" ? fingerprint! : null);
    });
    this.#d.log.info("connector.tool_class_changed", {
      connectorId: id,
      tool,
      actionClass: actionClass ?? "default",
      ...(fingerprint ? { definitionFingerprint: fingerprint } : {}),
    });
  }

  // ---- the agent ---------------------------------------------------------------------------------------------------

  /** Every connector, and the tools of the connected ones (a connector whose list fails has none). */
  async connectorTools(): Promise<{ connectors: Connector[]; tools: Map<string, McpToolInfo[]>; reachable: boolean }> {
    const tools = new Map<string, McpToolInfo[]>();
    if (!this.#d.gatewayUrl) return { connectors: [], tools, reachable: true };
    let all: Connector[];
    try {
      all = await this.list();
    } catch {
      return { connectors: [], tools, reachable: false };
    }
    await Promise.all(
      all
        .filter((c) => c.status === "connected")
        .map(async (c) => {
          try {
            tools.set(c.id, (await this.#toolList(c.id, false, c)).tools);
          } catch {
            /* left without tools; the index says so */
          }
        }),
    );
    return { connectors: all, tools, reachable: true };
  }

  /** The connector a model named (its id, or its name in any case) and the tool, with the class the call is decided as. */
  async resolve(
    connectorRef: string,
    toolName: string,
    refresh = false,
  ): Promise<{
    connector: Connector;
    tool: McpToolInfo;
    actionClass: ConnectorToolClass;
    binding: string;
    configuration: string;
    profileAuthority: string;
  }> {
    if (!this.#d.gatewayUrl) throw new McpCallError("There are no connectors: the gateway isn't running here.");
    let all: Connector[];
    try {
      all = await this.list();
    } catch {
      throw new McpCallError(
        "The connectors could not be reached right now (the gateway did not answer). Try again in a moment.",
      );
    }
    const ref = connectorRef.trim().toLowerCase();
    const connector = all.find((c) => c.id.toLowerCase() === ref) ?? all.find((c) => c.name.toLowerCase() === ref);
    if (!connector) {
      const names = all.map((c) => c.name);
      throw new McpCallError(
        names.length === 0
          ? "There is no connector. Tell the user to add one in Settings → Capabilities → Connectors."
          : `There is no connector "${connectorRef}". The connectors are: ${names.join(", ")}.`,
      );
    }
    if (connector.status === "needs_auth")
      throw new McpCallError(
        `${connector.name} needs the user to sign in again. Tell the user to open Settings → Capabilities → Connectors and sign in to ${connector.name}, then end your turn.`,
      );
    if (connector.status === "error")
      throw new McpCallError(
        `${connector.name} is not working right now${connector.error ? ` (${connector.error})` : ""}. Tell the user and do not retry.`,
      );
    let tools: McpToolInfo[];
    try {
      tools = (await this.#toolList(connector.id, refresh, connector)).tools;
    } catch (error) {
      throw new McpCallError(this.#failure(connector.name, error));
    }
    const matches = tools.filter((t) => t.name === toolName);
    if (matches.length > 1)
      throw new McpCallError("The connector returned ambiguous tool definitions; the call was not executed.");
    const tool = matches[0];
    if (!tool) throw new McpCallError(`${connector.name} no longer has the tool "${toolName}". Tell the user.`);
    const actionClass = await this.effectiveClass(connector.id, tool, connector);
    const configuration = this.configuration(connector.id, toolName);
    const profileAuthority = this.profileAuthority(connector.id);
    const binding = await sha256Hex(
      canonicalJson({
        connector: {
          id: connector.id,
          name: connector.name,
          url: connector.url,
          auth: connector.auth,
          tokenHeader: connector.tokenHeader,
          createdAt: connector.createdAt,
          status: connector.status,
        },
        tool,
        actionClass,
        configuration,
        profileAuthority,
      }),
    );
    return { connector, tool, actionClass, binding, configuration, profileAuthority };
  }

  /** One sentence for the model about a failed gateway answer. */
  #failure(connectorName: string, error: unknown): string {
    if (error instanceof HttpError) {
      if (error.code === "needs_auth")
        return `${connectorName} needs the user to sign in again. Tell the user to open Settings → Capabilities → Connectors and sign in to ${connectorName}, then end your turn.`;
      if (error.code === "connector_not_found") return `${connectorName} was removed. Tell the user.`;
      if (error.code === "connector_unreachable" || error.code === "mcp_error" || error.code === "gateway_unavailable")
        return `${connectorName} could not be reached right now (${error.message}) Do not retry more than once.`;
      return `${connectorName} failed: ${error.message}`;
    }
    return `${connectorName} failed.`;
  }

  async call(
    connector: Connector,
    tool: string,
    args: Record<string, unknown>,
    stepId: string | undefined,
    guard: { definition: McpToolInfo; beforeDispatch: () => void },
  ): Promise<McpCallResult> {
    try {
      const body = await this.#gateway(
        "POST",
        `/mcp/connectors/${encodeURIComponent(connector.id)}/call`,
        {
          tool,
          arguments: args,
          expected: {
            connector: {
              id: connector.id,
              name: connector.name,
              url: connector.url,
              auth: connector.auth,
              tokenHeader: connector.tokenHeader,
              status: connector.status,
              createdAt: connector.createdAt,
            },
            tool: guard.definition,
          },
          ...(stepId ? { stepId } : {}),
        },
        CALL_TIMEOUT_MS,
        guard.beforeDispatch,
      );
      return {
        isError: body.isError === true,
        text: typeof body.text === "string" ? body.text : "",
        structured: body.structured ?? null,
        truncated: body.truncated === true,
        ...(Array.isArray(body.media) ? { media: body.media as import("@rei/protocol").McpResultMedia[] } : {}),
      };
    } catch (error) {
      if (error instanceof McpCallError) throw error;
      if (error instanceof HttpError && error.code === "needs_auth") this.#cache.delete(connector.id);
      throw new McpCallError(this.#failure(connector.name, error));
    }
  }
}
