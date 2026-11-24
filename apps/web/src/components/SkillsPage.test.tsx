import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import { currentRoute } from "../lib/route.ts";
import { agent, SKILL_MD, skillResponse, skillSummary } from "../test/fixtures.ts";
import { newSkillMd, SkillsPage } from "./SkillsPage.tsx";

const dot = agent();
const rex = agent({ id: "a2", name: "Rex" });

function setup(api: Record<string, unknown>, id: string | null = null, rev = 0, agents = [dot, rex]) {
  const el = (r: number) => <SkillsPage api={api as unknown as Api} agents={agents} id={id} rev={r} />;
  const view = render(el(rev));
  return { view, rerender: (r: number) => view.rerender(el(r)) };
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("Skills view: the list", () => {
  it("shows each skill's owner, its plugin's state and which agents may use it", async () => {
    setup({
      getSkills: vi.fn().mockResolvedValue({
        skills: [
          skillSummary({ plugin: null, agents: ["a2"] }),
          skillSummary({
            id: "skl2",
            name: "notes/research",
            plugin: { id: "p1", name: "notes", enabled: false },
            agents: null,
          }),
          skillSummary({ id: "builtin_browser", name: "browser", builtIn: true }),
        ],
      }),
    });
    const rows = within(await screen.findByRole("list", { name: "Skills" })).getAllByRole("link");
    expect(rows[0]!.getAttribute("href")).toBe("/settings/skills/skl1");
    expect(rows[0]!.textContent).toContain("Standalone");
    expect(rows[0]!.textContent).toContain("Rex");
    expect(rows[0]!.textContent).not.toContain("Dot");
    expect(rows[1]!.textContent).toContain("Plugin: notes");
    expect(rows[1]!.textContent).toContain("Plugin disabled");
    expect(rows[1]!.textContent).toContain("All agents");
    expect(rows[2]!.textContent).toContain("Built-in");
    expect(rows[2]!.textContent).toContain("Included with Rei · Read-only");
    expect(rows[2]!.textContent).not.toContain("Standalone");
  });

  it("has an empty state, and refetches on a skills change", async () => {
    const getSkills = vi.fn().mockResolvedValue({ skills: [] });
    const { rerender } = setup({ getSkills });
    expect(await screen.findByText("No skills yet.")).toBeTruthy();
    rerender(1);
    await waitFor(() => expect(getSkills).toHaveBeenCalledTimes(2));
  });

  it("imports a lone SKILL.md as one file, then opens it", async () => {
    const importSkill = vi.fn().mockResolvedValue({ skill: skillSummary() });
    setup({ getSkills: vi.fn().mockResolvedValue({ skills: [] }), importSkill });
    fireEvent.change(await screen.findByLabelText("Import a skill"), {
      target: { files: [new File([SKILL_MD], "SKILL.md", { type: "text/markdown" })] },
    });
    await waitFor(() =>
      expect(importSkill).toHaveBeenCalledWith({ files: [{ path: "SKILL.md", encoding: "text", content: SKILL_MD }] }),
    );
    await waitFor(() => expect(currentRoute()).toBe("/settings/skills/skl1"));
  });
});

describe("Skills view: a new standalone skill", () => {
  it("creates one from a name, a description and instructions, then opens it", async () => {
    const importSkill = vi.fn().mockResolvedValue({ skill: skillSummary({ id: "skl9" }) });
    setup({ getSkills: vi.fn().mockResolvedValue({ skills: [] }), importSkill });
    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
    const form = screen.getByRole("form", { name: "New skill" });
    const create = within(form).getByRole("button", { name: "Create skill" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Bad Name" } });
    fireEvent.change(within(form).getByLabelText("Description"), { target: { value: "Plan: a trip" } });
    fireEvent.change(within(form).getByLabelText("Instructions"), { target: { value: "1. Ask where." } });
    expect(create.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "trip-planner" } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() =>
      expect(importSkill).toHaveBeenCalledWith({
        files: [
          {
            path: "SKILL.md",
            encoding: "text",
            content: '---\nname: trip-planner\ndescription: "Plan: a trip"\n---\n\n1. Ask where.\n',
          },
        ],
      }),
    );
    await waitFor(() => expect(currentRoute()).toBe("/settings/skills/skl9"));
  });

  it("shows the server's sentence when the skill is refused, and keeps the form", async () => {
    const importSkill = vi
      .fn()
      .mockRejectedValue(new ApiError(400, "bad_skill", "A skill named trip-planner already exists."));
    setup({ getSkills: vi.fn().mockResolvedValue({ skills: [] }), importSkill });
    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
    const form = screen.getByRole("form", { name: "New skill" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "trip-planner" } });
    fireEvent.change(within(form).getByLabelText("Description"), { target: { value: "Plan a trip" } });
    fireEvent.change(within(form).getByLabelText("Instructions"), { target: { value: "Ask." } });
    fireEvent.click(within(form).getByRole("button", { name: "Create skill" }));
    expect((await within(form).findByRole("alert")).textContent).toContain("already exists");
    expect(screen.getByRole("form", { name: "New skill" })).toBeTruthy();
  });

  it("quotes the description so any text is valid frontmatter", () => {
    expect(newSkillMd("a", ' "quoted": yes ', "  body  ")).toBe(
      '---\nname: a\ndescription: "\\"quoted\\": yes"\n---\n\nbody\n',
    );
  });
});

describe("Skills view: a skill's detail", () => {
  it("says which plugin owns it, linking to the plugin", async () => {
    setup(
      {
        getSkill: vi
          .fn()
          .mockResolvedValue(
            skillResponse({ skill: skillSummary({ plugin: { id: "p1", name: "notes", enabled: true } }) }),
          ),
      },
      "skl1",
    );
    const link = await screen.findByRole("link", { name: "notes" });
    expect(link.getAttribute("href")).toBe("/settings/plugins/p1");
  });

  it("says when it is standalone", async () => {
    setup({ getSkill: vi.fn().mockResolvedValue(skillResponse({ skill: skillSummary({ plugin: null }) })) }, "skl1");
    expect(await screen.findByText("Standalone: no plugin owns it")).toBeTruthy();
  });
});
