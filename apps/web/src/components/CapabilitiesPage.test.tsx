import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { agent } from "../test/fixtures.ts";
import { CapabilitiesPage } from "./CapabilitiesPage.tsx";

const api = () =>
  ({
    getPlugins: vi.fn().mockResolvedValue({ plugins: [] }),
    getSkills: vi.fn().mockResolvedValue({ skills: [] }),
    getConnectors: vi.fn().mockResolvedValue({ connectors: [] }),
  }) as unknown as Api;

afterEach(cleanup);

it.each([
  ["plugins", "Plugins"],
  ["skills", "Skills"],
  ["connectors", "Connectors"],
] as const)("the %s view has the three views to switch between, with itself current", async (view, heading) => {
  render(<CapabilitiesPage api={api()} agents={[agent()]} view={view} id={null} rev={0} />);
  expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
  const nav = screen.getByRole("navigation", { name: "Capabilities" });
  const links = within(nav).getAllByRole("link");
  expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
    ["Plugins", "/settings/plugins"],
    ["Skills", "/settings/skills"],
    ["Connectors", "/settings/connectors"],
  ]);
  expect(within(nav).getByRole("link", { name: heading }).getAttribute("aria-current")).toBe("page");
});

it("leaves the view switcher off an open item", async () => {
  const a = {
    ...api(),
    getSkill: vi.fn().mockReturnValue(new Promise(() => undefined)),
  } as unknown as Api;
  render(<CapabilitiesPage api={a} agents={[agent()]} view="skills" id="skl1" rev={0} />);
  expect(screen.queryByRole("navigation", { name: "Capabilities" })).toBeNull();
});

it("adds a connector without a plugin from the Connectors view", async () => {
  render(<CapabilitiesPage api={api()} agents={[agent()]} view="connectors" id={null} rev={0} />);
  expect(await screen.findByRole("button", { name: "Add connector" })).toBeTruthy();
});
