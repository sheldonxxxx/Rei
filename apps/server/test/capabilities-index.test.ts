// The Capabilities index (issue 04): one prompt section listing the deferred tool groups, the agent's connectors and up
// to 30 of its skills. It renders per agent, deterministically, and within a token budget.

import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";
import { describe, expect, it } from "vitest";
import { type ConnectorIndexSource, createCapabilitiesExtension, INDEX_SKILLS } from "../src/capabilities/extension.ts";
import type { ToolGroups } from "../src/capabilities/groups.ts";
import { ToolCatalog } from "../src/pi/policy-ext.ts";
import type { PluginService } from "../src/plugins/service.ts";
import type { SkillStore } from "../src/skills/store.ts";
import type { AppStore } from "../src/store/store.ts";

/** The worst case the budget covers: every deferred group, 10 connectors and a full page of long skill lines. */
const INDEX_TOKEN_BUDGET = 1_200;

interface Skill {
  id: string;
  name: string;
  description: string;
}
interface World {
  groups: string[];
  connectors: Record<string, { name: string; tools: number; state?: string }[]>;
  skills: Record<string, Skill[]>;
  uses?: Map<string, number>;
}

/** Renders the index for one agent; the conversation id stands for the agent id. */
function render(world: World, agentId: string): string | undefined {
  const connectors = {
    forAgent: (id: string) => world.connectors[id] ?? [],
    info: () => undefined,
  } as unknown as ConnectorIndexSource;
  const ext = createCapabilitiesExtension({
    treeId: "tree",
    catalog: new ToolCatalog(),
    store: { sessionByConversation: (_t: string, c: string) => ({ agent_id: c }) } as unknown as AppStore,
    groups: { deferredGroups: () => world.groups } as unknown as ToolGroups,
    skills: {
      list: (id: string) => world.skills[id] ?? [],
      useCounts: () => world.uses ?? new Map(),
    } as unknown as SkillStore,
    plugins: { skillInfo: () => undefined } as unknown as PluginService,
    connectors,
  });
  const section = ext.sections?.find((s) => s.key === "capabilities");
  return section?.render({ conversationId: agentId } as never, {} as never) as string | undefined;
}

const skill = (n: number, description = `Does task number ${n}.`): Skill => ({
  id: `sk_${String(n).padStart(2, "0")}`,
  name: `skill-${String(n).padStart(2, "0")}`,
  description,
});

describe("the Capabilities index", () => {
  it("renders per agent: only the connectors and skills that agent may use", () => {
    const world: World = {
      groups: ["browser"],
      connectors: { a: [{ name: "GitHub", tools: 12 }], b: [] },
      skills: { a: [skill(1)], b: [skill(2)] },
    };
    const a = render(world, "a")!;
    const b = render(world, "b")!;
    expect(a).toContain("- GitHub (12 tools)");
    expect(a).toContain("- skill-01: Does task number 1.");
    expect(a).not.toContain("skill-02");
    expect(b).not.toContain("- GitHub");
    expect(b).toContain("- skill-02:");
    expect(b).toContain("- browser: ");
    expect(a.split("\n")[0]).toMatch(/search_capabilities/);
  });

  it("is a short placeholder when there is nothing to load, so a later connector is a small patch", () => {
    expect(render({ groups: [], connectors: {}, skills: {} }, "a")).toBe("No deferred tools, connectors or skills.");
  });

  it("shows a connector's state instead of its tool count when it is not ready", () => {
    const text = render(
      {
        groups: [],
        connectors: {
          a: [
            { name: "Calendar", tools: 1 },
            { name: "Mail", tools: 0, state: "needs sign-in (Settings → Capabilities → Connectors)" },
            { name: "Drive", tools: 0, state: "not working right now" },
          ],
        },
        skills: {},
      },
      "a",
    )!;
    expect(text).toContain("- Calendar (1 tool)");
    expect(text).toContain("- Mail — needs sign-in (Settings → Capabilities → Connectors)");
    expect(text).toContain("- Drive — not working right now");
  });

  it(`shows at most ${INDEX_SKILLS} skills, the most used, in name order, and says how many more search finds`, () => {
    const skills = Array.from({ length: 40 }, (_, i) => skill(i + 1));
    // The ten least-numbered skills were never used; the rest were, so they are the ones shown.
    const uses = new Map(skills.slice(10).map((s, i) => [s.id, i + 1]));
    const text = render({ groups: [], connectors: {}, skills: { a: skills }, uses }, "a")!;
    const shown = text.split("\n").filter((l) => l.startsWith("- skill-"));
    expect(shown).toHaveLength(INDEX_SKILLS);
    expect(shown[0]).toMatch(/^- skill-11:/);
    expect(shown.at(-1)).toMatch(/^- skill-40:/);
    expect(shown).toEqual([...shown].sort());
    expect(text).toContain("(10 more skills: search_capabilities finds them.)");
  });

  it("clips a skill's description to one line of about 100 characters", () => {
    const text = render(
      { groups: [], connectors: {}, skills: { a: [skill(1, `First line\n\n${"word ".repeat(60)}`)] } },
      "a",
    )!;
    const line = text.split("\n").find((l) => l.startsWith("- skill-01:"))!;
    expect(line.length).toBeLessThanOrEqual("- skill-01: ".length + 100);
    expect(line.endsWith("…")).toBe(true);
  });

  it("renders byte-identical text for the same capabilities, whatever order they arrive in", () => {
    const skills = Array.from({ length: 35 }, (_, i) => skill(i + 1));
    const uses = new Map(skills.map((s, i) => [s.id, i % 3]));
    const world: World = { groups: ["browser", "triggers"], connectors: { a: [] }, skills: { a: skills }, uses };
    const first = render(world, "a");
    const second = render({ ...world, skills: { a: [...skills].reverse() } }, "a");
    expect(second).toBe(first);
  });

  it(`stays within ${INDEX_TOKEN_BUDGET} tokens in the worst case it is built for`, () => {
    const long = "Summarises, drafts and checks documents against the house style guide, then files them.".repeat(3);
    const world: World = {
      groups: ["browser", "plugins", "triggers"],
      connectors: {
        a: Array.from({ length: 10 }, (_, i) => ({ name: `Connector Number ${i + 1}`, tools: 40 + i })),
      },
      skills: { a: Array.from({ length: 50 }, (_, i) => skill(i + 1, long)) },
    };
    const text = render(world, "a")!;
    const tokens = new Tiktoken(o200k).encode(text).length;
    expect(tokens).toBeLessThanOrEqual(INDEX_TOKEN_BUDGET);
  });
});
