// search_capabilities: one search over the deferred tools this conversation is not offered yet (built-in groups and
// connector tools) and the skills its agent can read. Ranked tools are loaded with Pi's `control.addTools`, so the next
// request offers them; there is no second way to activate a tool. A built-in hit loads its whole group; connector tools
// load one by one. Searching or loading grants nothing: every call is still decided by the policy hook.

import type { Agent, ToolRegistration } from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { type CapabilitySearchDetails, DEFAULT_AGENT_CAPABILITIES, type LoadReason } from "@rei/protocol";
import { behaviorSettings, CONFIGLESS } from "../pi/behavior-settings.ts";
import type { PluginService } from "../plugins/service.ts";
import type { SkillStore } from "../skills/store.ts";
import type { AppStore } from "../store/store.ts";
import { agentAllowsGroup, agentAllowsTool } from "./agent-access.ts";
import { DEFERRED_GROUPS, type ToolGroups } from "./groups.ts";
import { clearing, minCoverage, queryTerms, type RankDocument, type RankedDocument, rank, tokenize } from "./rank.ts";

export const SEARCH_CAPABILITIES = "search_capabilities";
/** A ranked tool loads when it scores at least this share of the best score at the best coverage. */
export const LOAD_RATIO = 0.5;
export const ALSO_RELEVANT = 8;
const DIRECTORY_DESCRIPTION = 60;

/** A connector tool as search sees it; provided by the connector tools of the tree. */
export interface ConnectorToolInfo {
  name: string;
  connectorId: string;
  connectorName: string;
  /** The tool's own MCP name. */
  tool: string;
  description: string;
  /** The owning plugin, and its skills to suggest with the tool. */
  plugin?: string;
  skills?: string[];
}

export interface ConnectorToolLookup {
  info(name: string): ConnectorToolInfo | undefined;
  /** Whether the agent may use the connector tool now; a hidden one is neither found nor loaded. */
  visibleTo?(name: string, agentId: string): boolean;
  /** Why a connector tool name this server listed is not available to the agent now; undefined when it never was one. */
  unavailable?(name: string, agentId: string): string | undefined;
}

export type { CapabilitySearchDetails, LoadReason } from "@rei/protocol";

export interface SearchDeps {
  treeId: string;
  store: AppStore;
  groups: ToolGroups;
  skills?: SkillStore;
  plugins?: PluginService;
  connectors?: ConnectorToolLookup;
}

type ToolText = {
  output: { type: "text"; text: string }[];
  details: CapabilitySearchDetails;
  control?: { addTools: string[] };
  isError?: true;
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const firstLine = (text: string, max: number): string => clip(text.replace(/\s+/g, " ").trim(), max);
/** One line of a connector's directory, as search and an @-mention list it. */
export const directoryLine = (name: string, description: string, loaded = false): string =>
  `- ${name}${loaded ? " (loaded)" : ""}: ${firstLine(description, DIRECTORY_DESCRIPTION)}`;

/** Search text of a tool: its description and its parameters' names and descriptions. */
export function toolText(tool: ToolRegistration): string {
  const parts = [tool.description];
  const walk = (schema: unknown) => {
    if (typeof schema !== "object" || schema === null) return;
    const s = schema as { description?: unknown; properties?: Record<string, unknown>; items?: unknown };
    if (typeof s.description === "string") parts.push(s.description);
    for (const [name, property] of Object.entries(s.properties ?? {})) {
      if (name === "_activity") continue;
      parts.push(name);
      walk(property);
    }
    walk(s.items);
  };
  walk(tool.parameters);
  return parts.join(" ");
}

export const SEARCH_DESCRIPTION = [
  "Find and load capabilities you are not offered yet: deferred built-in tool groups, tools of the user's connectors, and skills.",
  'Describe the task in a few words, in English where you can, e.g. "read a file in a GitHub repo" or "schedule a weekly reminder". A connector\'s name alone lists its tools without loading any.',
  "Matching tools are loaded and you can call them from your next step; a built-in match loads its whole group. Matching skills are listed: read them with use_skill before you start.",
  'To load exact tools or groups by name (from the Capabilities index, an "also relevant" list or a connector\'s directory), pass load instead of, or with, query.',
  "Loading a tool grants nothing: its calls follow the usual approval rules.",
].join(" ");

/** The search_capabilities tool's definition and execution, without its policy declaration. */
export function searchCapabilitiesTool(deps: SearchDeps) {
  const { treeId, store, groups } = deps;
  return {
    name: SEARCH_CAPABILITIES,
    description: SEARCH_DESCRIPTION,
    parameters: obj({
      query: opt(str({ description: "What you want to do, in a few words." })),
      load: opt(
        arr(str(), {
          description:
            'Exact tool or group names to load, e.g. a connector tool from its directory, or "browser". A connector\'s name lists its tools instead.',
        }),
      ),
    }),
    // Searching changes only what the model is offered; nested calls (code mode) have nothing to load.
    callers: ["model"] as ("model" | "tools")[],
    replay: "safe" as const,
    execute: async (
      args: { query?: string; load?: string[] },
      api: { conversationId: unknown; agent: (context: never) => Promise<Agent> },
      context: unknown,
    ): Promise<ToolText> => {
      const details: CapabilitySearchDetails = {
        candidates: [],
        loaded: [],
        alreadyLoaded: [],
        alsoRelevant: [],
        skills: [],
        notFound: [],
      };
      const fail = (text: string): ToolText => ({ isError: true, output: [{ type: "text", text }], details });
      const session = store.sessionByConversation(treeId, String(api.conversationId));
      if (!session) return fail("This session is no longer available.");
      const query = args.query?.trim() ?? "";
      const load = (args.load ?? []).map((n) => n.trim()).filter((n) => n !== "");
      if (query === "" && load.length === 0) return fail("Give a query, or names to load.");
      if (query !== "") details.query = query;

      const all = await api.agent(context as never);
      const caps = store.agentCapabilities?.(session.agent_id) ?? DEFAULT_AGENT_CAPABILITIES;
      // A tree registers the tools of every agent it has; this agent sees only its own connectors' tools and enabled built-ins.
      const visible = (t: { name: string }) =>
        (!deps.connectors?.info(t.name) || deps.connectors.visibleTo?.(t.name, session.agent_id) !== false) &&
        agentAllowsTool(caps, t.name);
      const agent = { deferred: all.deferred.filter(visible), tools: all.tools.filter(visible) };
      const deferred = new Map(agent.deferred.map((t) => [t.name, t]));
      const offered = new Set(agent.tools.map((t) => t.name));
      const toLoad: CapabilitySearchDetails["loaded"] = [];
      const add = (name: string, reason: LoadReason, group?: string) => {
        if (offered.has(name)) {
          if (!details.alreadyLoaded.includes(name)) details.alreadyLoaded.push(name);
          return;
        }
        if (!deferred.has(name) || toLoad.some((l) => l.name === name)) return;
        toLoad.push({ name, reason, ...(group ? { group } : {}) });
      };
      const addGroup = (group: string, reason: LoadReason) => {
        for (const name of groups.toolsOf(group)) add(name, reason, group);
      };
      const lines: string[] = [];

      // Exact names: a group, a tool of a deferred group (its whole group), or a connector tool.
      for (const name of load) {
        const group = groups.toolsOf(name).length > 0 ? name : groups.groupOf(name);
        if (group && groups.isDeferred(group) && agentAllowsGroup(caps, group)) addGroup(group, "load");
        else if (deferred.has(name) || (offered.has(name) && deps.connectors?.info(name))) add(name, "load");
        else if (offered.has(name)) details.alreadyLoaded.push(name);
        else details.notFound.push(name);
      }

      // Connector tools the agent can see, loaded or not, for directories and for explaining names that were not found.
      const connectorTools = [...agent.deferred, ...agent.tools].flatMap((tool) => {
        const info = deps.connectors?.info(tool.name);
        return info ? [{ tool, info }] : [];
      });
      const directoryLines = (c: ConnectorToolInfo, intro: string): string[] => {
        const tools = connectorTools.filter((t) => t.info.connectorId === c.connectorId);
        details.directory ??= { connectorId: c.connectorId, connectorName: c.connectorName, tools: tools.length };
        return [
          `${intro}${c.connectorName} has ${tools.length} tool${tools.length === 1 ? "" : "s"}; none was loaded. Load the ones the task needs with search_capabilities({ load: [names] }), or search again describing the task:`,
          ...tools.map((t) => directoryLine(t.tool.name, t.info.description, offered.has(t.tool.name))),
        ];
      };
      // A name that was not found: a connector's name gets its directory, a connector tool's own MCP name the full name,
      // and a connector tool that is no longer available says why, so the model does not keep guessing.
      const explained: string[] = [];
      const named: string[] = [];
      const missing: string[] = [];
      const byName = new Map(connectorTools.map((t) => [t.tool.name, t.info]));
      for (const name of details.notFound) {
        const c = connectorOnly(name, byName);
        if (c) {
          if (!named.includes(c.connectorId)) {
            named.push(c.connectorId);
            explained.push(...directoryLines(c, `${JSON.stringify(name)} is a connector, not a tool. `));
          }
          continue;
        }
        missing.push(name);
        const full = connectorTools.filter((t) => t.info.tool === name).map((t) => t.tool.name);
        const gone = deps.connectors?.unavailable?.(name, session.agent_id);
        if (full.length > 0) explained.push(`${name} is a connector tool's own name; load it as ${full.join(" or ")}.`);
        else if (gone)
          explained.push(`${name} is not available: ${gone}. Do not retry it; tell the user if the task needs it.`);
      }
      details.notFound = missing;

      let skillHits: RankedDocument[] = [];
      if (query !== "") {
        const builtinDocs: RankDocument[] = [];
        const connectorDocs: RankDocument[] = [];
        const connectorInfo = new Map<string, ConnectorToolInfo>();
        for (const tool of agent.deferred) {
          const info = deps.connectors?.info(tool.name);
          if (info) {
            connectorInfo.set(tool.name, info);
            connectorDocs.push({
              name: tool.name,
              text: toolText(tool),
              namespaceText: [info.connectorName, info.plugin ?? ""].join(" "),
            });
          } else {
            const group = groups.groupOf(tool.name);
            builtinDocs.push({
              name: tool.name,
              text: toolText(tool),
              ...(group ? { namespaceText: `${group} ${DEFERRED_GROUPS[group] ?? ""}` } : {}),
            });
          }
        }
        const ranked = rank(query, [...builtinDocs, ...connectorDocs]);
        const least = minCoverage(query);
        const discovery = behaviorSettings(deps.store, CONFIGLESS).discovery;
        const directoryOf = connectorOnly(query, connectorInfo);
        if (directoryOf) {
          // Every term matched only a connector's name: show what it has rather than load arbitrary tools.
          if (!named.includes(directoryOf.connectorId)) lines.push(...directoryLines(directoryOf, ""));
        } else {
          const top = clearing(ranked, LOAD_RATIO, least);
          let connectorLoads = 0;
          for (const hit of top) {
            if (connectorInfo.has(hit.name)) {
              if (connectorLoads >= discovery.maxConnectorTools) continue;
              connectorLoads++;
              add(hit.name, "ranked");
            } else {
              const group = groups.groupOf(hit.name);
              if (group) addGroup(group, "group");
              else add(hit.name, "ranked");
            }
          }
          const loadedNames = new Set(toLoad.map((l) => l.name));
          details.alsoRelevant = ranked
            .filter((r) => !loadedNames.has(r.name) && r.coverage >= least)
            .slice(0, ALSO_RELEVANT)
            .map((r) => r.name);
        }
        details.candidates = ranked.slice(0, 20).map((r) => ({ name: r.name, kind: "tool" as const, ...scoreOf(r) }));

        // Skills: ranked on their own, the qualified name as the name and the plugin as the namespace.
        if (deps.skills) {
          const skills = deps.skills.list(session.agent_id).map((s) => {
            const info = deps.plugins?.skillInfo(s.id);
            return { name: info?.reference ?? s.name, text: s.description, plugin: info?.plugin };
          });
          skillHits = clearing(
            rank(
              query,
              skills.map((s) => ({ name: s.name, text: s.text, namespaceText: s.plugin ?? "" })),
            ),
            LOAD_RATIO,
            least,
          ).slice(0, discovery.maxSkills);
          details.candidates.push(...skillHits.map((r) => ({ name: r.name, kind: "skill" as const, ...scoreOf(r) })));
          details.skills = skillHits.map((r) => r.name);
          const describe = new Map(skills.map((s) => [s.name, s]));
          // A loaded connector tool brings its plugin's skills along.
          for (const l of toLoad) {
            for (const skill of deps.connectors?.info(l.name)?.skills ?? [])
              if (!details.skills.includes(skill) && describe.has(skill)) details.skills.push(skill);
          }
          if (details.skills.length > 0)
            lines.push(
              "Skills that match (read with use_skill before you start):",
              ...details.skills.map((name) => {
                const s = describe.get(name);
                return `- ${name}${s?.plugin ? ` (plugin ${s.plugin})` : ""}: ${firstLine(s?.text ?? "", 160)}`;
              }),
            );
        }
      }

      details.loaded = toLoad;
      const loadedLines = describeLoads(toLoad, deferred, deps.connectors);
      const text = [
        ...loadedLines,
        ...(details.alreadyLoaded.length > 0 ? [`Already available: ${details.alreadyLoaded.join(", ")}.`] : []),
        ...(details.notFound.length > 0
          ? [
              `Not found: ${details.notFound.join(", ")}. Use names from a search result, a directory or the Capabilities index.`,
            ]
          : []),
        ...explained,
        ...lines,
        ...(details.alsoRelevant.length > 0
          ? [
              "Also relevant, not loaded (load with search_capabilities({ load: [names] })):",
              ...details.alsoRelevant.map((name) => {
                const tool = deferred.get(name);
                return `- ${name}: ${firstLine(tool?.description ?? "", 100)}`;
              }),
            ]
          : []),
      ];
      if (text.length === 0)
        text.push(
          `Nothing matches "${query}". Your tools, the Capabilities index and this search are everything this agent can use; do not guess a tool name.`,
        );
      return {
        output: [{ type: "text", text: text.join("\n") }],
        details,
        ...(toLoad.length > 0 ? { control: { addTools: toLoad.map((l) => l.name) } } : {}),
      };
    },
  };
}

const scoreOf = (r: RankedDocument) => ({ coverage: r.coverage, score: Math.round(r.score * 100) / 100 });

/**
 * The connector the query only names: every query term is a word of one connector's name ("github", "Notion"). Such a
 * query says which connector, not what to do with it, so search shows the connector's directory instead of loading.
 */
function connectorOnly(query: string, info: ReadonlyMap<string, ConnectorToolInfo>): ConnectorToolInfo | undefined {
  const terms = queryTerms(query).map((t) => t[0]!);
  if (terms.length === 0) return undefined;
  const seen = new Set<string>();
  for (const i of info.values()) {
    if (seen.has(i.connectorId)) continue;
    seen.add(i.connectorId);
    const words = new Set(tokenize(i.connectorName));
    if (terms.every((t) => words.has(t))) return i;
  }
  return undefined;
}

function describeLoads(
  loaded: CapabilitySearchDetails["loaded"],
  tools: ReadonlyMap<string, ToolRegistration>,
  connectors: ConnectorToolLookup | undefined,
): string[] {
  if (loaded.length === 0) return [];
  const lines: string[] = [];
  const groups = new Map<string, string[]>();
  for (const l of loaded) if (l.group) groups.set(l.group, [...(groups.get(l.group) ?? []), l.name]);
  for (const [group, names] of groups) lines.push(`Loaded the ${group} tools (${names.length}): ${names.join(", ")}.`);
  const single = loaded.filter((l) => !l.group);
  if (single.length > 0)
    lines.push(
      `Loaded ${single.length} tool${single.length === 1 ? "" : "s"}:`,
      ...single.map((l) => {
        const info = connectors?.info(l.name);
        return `- ${l.name}${info ? ` (${info.connectorName})` : ""}: ${firstLine(tools.get(l.name)?.description ?? "", 160)}`;
      }),
    );
  lines.push("They are available from your next step.");
  return lines;
}
