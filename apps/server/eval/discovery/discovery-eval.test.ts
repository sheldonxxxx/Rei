// The discovery eval (capability discovery, issue 01): how well search_capabilities finds what a task needs among the
// deferred built-in tools (registered by the real browser, plugins and triggers extensions), the tools of three
// realistic connectors (a GitHub-like one with 97 tools, Notion-like and Gmail-like ones) and the agent's skills.
//
// Retrieval part (this file, normal suite, no model): every query in fixture.json runs through the real tool's
// execute with a stand-in for Pi's agent view (everything deferred, nothing loaded yet). Per category it measures
// recall@5 and MRR@10 over the ranked candidates, how often what is needed is loaded or listed as "also relevant",
// loaded connector tools the query did not need, that a connector-only query ("github") returns the directory and
// loads nothing, and how often a query with no answer still returns something.
//
// The scenario part (a real model working tasks through the deployed stack) is recorded in RESULTS.md; it needs a
// gateway and a provider, so it is run by hand, not here.
//
// REI_EVAL_OUT=/path.json writes the metrics; REI_EVAL_DEBUG=1 prints each query's loads and top candidates.
// RESULTS.md records a run; the assertions are floors just under it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { beforeAll, describe, expect, it } from "vitest";
import { createBrowserExtension } from "../../src/browser/tools.ts";
import { ToolGroups } from "../../src/capabilities/groups.ts";
import {
  type CapabilitySearchDetails,
  type ConnectorToolInfo,
  searchCapabilitiesTool,
} from "../../src/capabilities/search.ts";
import { ToolCatalog } from "../../src/pi/policy-ext.ts";
import { createPluginsExtension } from "../../src/plugins/tools.ts";
import { createTriggersExtension } from "../../src/triggers/tools.ts";

interface FixtureConnector {
  id: string;
  name: string;
  slug: string;
  plugin?: string;
  tools: { name: string; description: string }[];
}
interface FixtureSkill {
  name: string;
  description: string;
  plugin?: string;
  connector?: string;
}
interface Query {
  id: string;
  cat: string;
  lang: string;
  q: string;
  tools?: string[];
  groups?: string[];
  skills?: string[];
  directory?: string;
}
const fixture = (await import(join(import.meta.dirname, "fixture.json"), { with: { type: "json" } })).default as {
  connectors: FixtureConnector[];
  skills: FixtureSkill[];
  queries: Query[];
};

const AGENT = "agt_eval";
const store = { sessionByConversation: () => ({ id: "ses_eval", agent_id: AGENT }) } as never;
const groups = new ToolGroups();
const deferred: ToolRegistration[] = [];
const connectorInfo = new Map<string, ConnectorToolInfo>();
const skillRef = (s: FixtureSkill): string => (s.plugin ? `${s.plugin}/${s.name}` : s.name);

beforeAll(() => {
  // The built-in deferred groups as the real extensions register them; their services are not called by search.
  const catalog = new ToolCatalog();
  const none = {} as never;
  const extensions: Extension[] = [
    createBrowserExtension({ treeId: "t", store, catalog, log: none, browser: none, takeovers: none }),
    createPluginsExtension({ treeId: "t", store, plugins: none, catalog }),
    createTriggersExtension({ treeId: "t", store, triggers: none, catalog, skills: none }),
  ];
  for (const extension of extensions) deferred.push(...(groups.mark(extension).tools ?? []));
  for (const c of fixture.connectors) {
    const skills = fixture.skills.filter((s) => s.connector === c.id).map(skillRef);
    for (const t of c.tools) {
      const name = `${c.slug}__${t.name}`;
      deferred.push({
        name,
        description: t.description,
        parameters: { type: "object", properties: {} },
        deferred: true,
        execute: async () => ({ output: [] }),
      } as never);
      connectorInfo.set(name, {
        name,
        connectorId: c.id,
        connectorName: c.name,
        tool: t.name,
        description: t.description,
        ...(c.plugin ? { plugin: c.plugin, skills } : {}),
      });
    }
  }
});

const skillsStore = {
  list: () => fixture.skills.map((s, i) => ({ id: `skl_${i}`, name: s.name, description: s.description })),
} as never;
const plugins = {
  skillInfo: (id: string) => {
    const s = fixture.skills[Number(id.slice("skl_".length))];
    return s?.plugin ? { plugin: s.plugin, reference: skillRef(s) } : undefined;
  },
} as never;

async function search(query: string): Promise<{ text: string; details: CapabilitySearchDetails }> {
  const tool = searchCapabilitiesTool({
    treeId: "t",
    store,
    groups,
    skills: skillsStore,
    plugins,
    connectors: { info: (name) => connectorInfo.get(name) },
  });
  const agent = { deferred, tools: [] } as unknown as Agent;
  const result = await tool.execute({ query }, { conversationId: "c", agent: async () => agent }, undefined);
  return { text: result.output[0]!.text, details: result.details };
}

const bare = (skill: string): string => skill.slice(skill.lastIndexOf("/") + 1);

interface Score {
  recall5: number;
  rr: number;
  /** Needed tools and groups loaded, or listed as also relevant. */
  reachable: number;
  needed: number;
  unusedLoads: number;
  connectorQueries: number;
}

function score(q: Query, d: CapabilitySearchDetails): Score {
  const toolRank = d.candidates.filter((c) => c.kind === "tool").map((c) => c.name);
  const skillRank = d.skills.map(bare);
  const positions: number[] = [];
  for (const t of q.tools ?? []) positions.push(toolRank.indexOf(t));
  for (const g of q.groups ?? []) positions.push(toolRank.findIndex((n) => groups.groupOf(n) === g));
  for (const s of q.skills ?? []) positions.push(skillRank.indexOf(s));
  // A query lists one or more acceptable tools for one need (e.g. modify_email or batch_modify_emails): any one counts.
  const needs = (q.tools && q.tools.length > 1 ? 1 : (q.tools?.length ?? 0)) + (q.groups?.length ?? 0);
  const goldCount = needs + (q.skills?.length ?? 0);
  const toolHits = (q.tools ?? []).map((t) => toolRank.indexOf(t)).filter((p) => p >= 0 && p < 5).length;
  const top5 =
    Math.min(toolHits, q.tools && q.tools.length > 1 ? 1 : toolHits) +
    (q.groups ?? []).filter((g) => {
      const p = toolRank.findIndex((n) => groups.groupOf(n) === g);
      return p >= 0 && p < 5;
    }).length +
    (q.skills ?? []).filter((s) => {
      const p = skillRank.indexOf(s);
      return p >= 0 && p < 5;
    }).length;
  const found = positions.filter((p) => p >= 0 && p < 10);
  const loaded = new Set(d.loaded.map((l) => l.name));
  const also = new Set(d.alsoRelevant);
  const reachTool = (q.tools ?? []).some((t) => loaded.has(t) || also.has(t));
  const reachGroups = (q.groups ?? []).filter((g) => d.loaded.some((l) => l.group === g)).length;
  const connectorLoads = d.loaded.filter((l) => connectorInfo.has(l.name)).map((l) => l.name);
  return {
    recall5: goldCount === 0 ? 0 : top5 / goldCount,
    rr: found.length === 0 ? 0 : 1 / (Math.min(...found) + 1),
    reachable: (reachTool ? 1 : 0) + reachGroups,
    needed: needs,
    unusedLoads: connectorLoads.filter((n) => !(q.tools ?? []).includes(n)).length,
    connectorQueries: connectorLoads.length > 0 || (q.tools ?? []).some((t) => connectorInfo.has(t)) ? 1 : 0,
  };
}

interface Row {
  cat: string;
  n: number;
  recall5: number;
  mrr10: number;
  reachable: number;
}

describe("discovery eval", () => {
  it("has the fixture it describes", () => {
    expect(fixture.connectors.find((c) => c.slug === "github")!.tools.length).toBeGreaterThanOrEqual(90);
    expect(fixture.queries.length).toBeGreaterThanOrEqual(40);
    expect(groups.deferredGroups()).toEqual(["browser", "plugins", "triggers"]);
    // Every expected tool exists, so a miss is a ranking miss, not a typo.
    const names = new Set(deferred.map((t) => t.name));
    for (const q of fixture.queries) for (const t of q.tools ?? []) expect(names.has(t), `${q.id}: ${t}`).toBe(true);
  });

  it("finds what each kind of query needs, and records the numbers", async () => {
    const perCat = new Map<string, { n: number; recall: number; rr: number; reach: number; needed: number }>();
    let noAnswer = 0;
    let noAnswerReturned = 0;
    let directoryOk = 0;
    let directoryQueries = 0;
    let unusedLoads = 0;
    let connectorQueries = 0;
    const misses: string[] = [];
    for (const q of fixture.queries) {
      const { details: d } = await search(q.q);
      if (process.env.REI_EVAL_DEBUG)
        console.log(
          q.id,
          q.q,
          "| loaded:",
          d.loaded.map((l) => l.name).join(","),
          "| skills:",
          d.skills.join(","),
          "| top:",
          d.candidates
            .slice(0, 5)
            .map((c) => `${c.name}(${c.coverage}/${c.score})`)
            .join(" "),
          d.directory ? `| directory: ${d.directory.connectorName}` : "",
        );
      if (q.cat === "no-answer") {
        noAnswer++;
        if (d.loaded.length > 0 || d.skills.length > 0 || d.alsoRelevant.length > 0 || d.directory) noAnswerReturned++;
        continue;
      }
      if (q.cat === "connector-only") {
        directoryQueries++;
        if (d.directory?.connectorId === q.directory && d.loaded.length === 0) directoryOk++;
        else misses.push(`${q.id} ${q.q}`);
        continue;
      }
      const s = score(q, d);
      unusedLoads += s.unusedLoads;
      connectorQueries += s.connectorQueries;
      if (s.recall5 < 1 || s.reachable < s.needed) misses.push(`${q.id} ${q.q}`);
      for (const cat of [q.cat, "all"]) {
        const c = perCat.get(cat) ?? { n: 0, recall: 0, rr: 0, reach: 0, needed: 0 };
        c.n++;
        c.recall += s.recall5;
        c.rr += s.rr;
        c.reach += s.reachable;
        c.needed += s.needed;
        perCat.set(cat, c);
      }
    }
    const rows: Row[] = [...perCat].map(([cat, c]) => ({
      cat,
      n: c.n,
      recall5: Number((c.recall / c.n).toFixed(3)),
      mrr10: Number((c.rr / c.n).toFixed(3)),
      reachable: c.needed === 0 ? 1 : Number((c.reach / c.needed).toFixed(3)),
    }));
    const row = (cat: string): Row => rows.find((r) => r.cat === cat)!;
    const metrics = {
      rows,
      noAnswer,
      noAnswerReturned,
      directoryQueries,
      directoryOk,
      unusedLoadsPerConnectorQuery: connectorQueries === 0 ? 0 : Number((unusedLoads / connectorQueries).toFixed(2)),
      misses,
    };
    console.log(
      [
        "Discovery eval",
        "| category | queries | recall@5 | MRR@10 | needed loaded or also relevant |",
        "| --- | --- | --- | --- | --- |",
        ...rows.map((r) => `| ${r.cat} | ${r.n} | ${r.recall5.toFixed(3)} | ${r.mrr10.toFixed(3)} | ${r.reachable} |`),
        `| connector-only: directory, nothing loaded | ${directoryQueries} | ${directoryOk}/${directoryQueries} | | |`,
        `| no-answer: returned something | ${noAnswer} | ${noAnswerReturned}/${noAnswer} | | |`,
        `Unused connector loads per connector query: ${metrics.unusedLoadsPerConnectorQuery}`,
        misses.length ? `Misses: ${misses.join("; ")}` : "",
      ].join("\n"),
    );
    if (process.env.REI_EVAL_OUT) writeFileSync(process.env.REI_EVAL_OUT, JSON.stringify(metrics, null, 2));

    // Floors just under the recorded run (RESULTS.md).
    expect(row("all").recall5).toBeGreaterThanOrEqual(0.95);
    expect(row("all").mrr10).toBeGreaterThanOrEqual(0.93);
    expect(row("all").reachable).toBeGreaterThanOrEqual(0.95);
    for (const cat of ["exact", "group", "paraphrase", "connector", "chinese", "mixed"])
      expect(row(cat).recall5, cat).toBeGreaterThanOrEqual(0.95);
    expect(row("skill").recall5).toBeGreaterThanOrEqual(0.85);
    expect(directoryOk).toBe(directoryQueries);
    expect(noAnswerReturned).toBe(0);
    expect(metrics.unusedLoadsPerConnectorQuery).toBeLessThanOrEqual(1.2);
  });

  it("a connector-only query lists the connector's tools and loads none", async () => {
    const { text, details } = await search("github");
    expect(details.directory).toMatchObject({ connectorId: "con_github", tools: 97 });
    expect(details.loaded).toEqual([]);
    expect(text).toContain("GitHub has 97 tools; none was loaded.");
    expect(text).toContain("- github__get_file_contents:");
  });

  it("a built-in hit loads its whole group, and a plugin's tool brings its skills", async () => {
    const browser = await search("take a screenshot of the page");
    expect(browser.details.loaded.map((l) => l.name).sort()).toEqual(groups.toolsOf("browser").sort());
    const issues = await search("list my open GitHub issues");
    expect(issues.details.loaded.map((l) => l.name)).toContain("github__list_issues");
    expect(issues.details.skills).toContain("github/issue-review");
  });
});
