import type { Agent } from "@rei/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import { grant, session } from "../test/fixtures.ts";
import { PermissionsPage } from "./PermissionsPage.tsx";

const agents: Agent[] = [
  {
    id: "a1",
    name: "Dot",
    avatar: "D",
    model: null,
    thinkingLevel: "off",
    networkMode: "block",
    defaultProfile: "standard",
    homeSessionId: "h",
  },
];
const sessions = [session({ id: "s1", title: "Budget" })];

function setup(api: Partial<Record<keyof Api, unknown>>) {
  const withWhitelist = { getSandboxNetwork: vi.fn().mockResolvedValue({ whitelist: [], defaults: [] }), ...api };
  return render(<PermissionsPage api={withWhitelist as unknown as Api} agents={agents} sessions={sessions} />);
}

describe("PermissionsPage", () => {
  it("sets the level new chats start at, saves on pick and warns about YOLO", async () => {
    const updateAgent = vi.fn().mockResolvedValue({ agent: agents[0] });
    const { rerender } = setup({ listGrants: vi.fn().mockResolvedValue({ grants: [] }), updateAgent });
    const select = screen.getByLabelText("Start new chats at") as HTMLSelectElement;
    expect(select.value).toBe("standard");
    fireEvent.change(select, { target: { value: "strict" } });
    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith("a1", { defaultProfile: "strict" }));
    expect(screen.queryByText(/YOLO skips most approvals/)).toBeNull();
    const yolo = [{ ...agents[0]!, defaultProfile: "yolo" as const }];
    rerender(
      <PermissionsPage
        api={
          {
            getSandboxNetwork: vi.fn().mockResolvedValue({ whitelist: [], defaults: [] }),
            listGrants: vi.fn().mockResolvedValue({ grants: [] }),
            updateAgent,
          } as unknown as Api
        }
        agents={yolo}
        sessions={sessions}
      />,
    );
    expect(screen.getByText(/YOLO skips most approvals/)).toBeTruthy();
  });

  it("shows a save error for the new-chat level", async () => {
    setup({
      listGrants: vi.fn().mockResolvedValue({ grants: [] }),
      updateAgent: vi.fn().mockRejectedValue(new ApiError(500, "internal", "")),
    });
    fireEvent.change(screen.getByLabelText("Start new chats at"), { target: { value: "strict" } });
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("lists grants with connector, destination, length in words and when they were made", async () => {
    const hoursAt = new Date(2030, 0, 15, 14, 30).getTime();
    const listGrants = vi.fn().mockResolvedValue({
      grants: [
        grant({ id: "g1" }),
        grant({ id: "g2", operation: "create_event", destination: null, length: "session", sessionId: "s1" }),
        grant({ id: "g3", connector: "email", operation: "send", length: "agent", agentId: "a1" }),
        grant({ id: "g4", length: "hours", expiresAt: hoursAt }),
      ],
    });
    setup({ listGrants });
    const list = await screen.findByRole("list", { name: "Grants in force" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain("demo · send_email");
    expect(rows[0]?.textContent).toContain("ana@example.com");
    expect(rows[0]?.textContent).toContain("Always");
    expect(rows[1]?.textContent).toContain("Any destination");
    expect(rows[1]?.textContent).toContain("For the chat “Budget”");
    expect(rows[2]?.textContent).toContain("For the agent Dot");
    expect(rows[3]?.textContent).toMatch(/Until .*2:30/);
    expect(rows[0]?.textContent).toMatch(/Allowed /);
  });

  it("resolves a grant's unloaded chat title on demand", async () => {
    const getSessionSummary = vi.fn().mockResolvedValue({ session: session({ id: "older", title: "Older budget" }) });
    setup({
      listGrants: vi.fn().mockResolvedValue({ grants: [grant({ length: "session", sessionId: "older" })] }),
      getSessionSummary,
    });
    expect(await screen.findByText("For the chat “Older budget”")).toBeTruthy();
    expect(getSessionSummary).toHaveBeenCalledWith("older");
  });

  it("sets each section in its own block with a heading", async () => {
    setup({ listGrants: vi.fn().mockResolvedValue({ grants: [] }) });
    for (const name of ["New chats", "Sandbox network", "Allowed in advance"])
      expect(screen.getByRole("region", { name })).toBeTruthy();
    expect(await screen.findByText("Nothing allowed in advance.")).toBeTruthy();
  });

  it("shows an empty state", async () => {
    setup({ listGrants: vi.fn().mockResolvedValue({ grants: [] }) });
    expect(await screen.findByText("Nothing allowed in advance.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Grants in force" })).toBeNull();
  });

  it("shows a load error with a retry", async () => {
    const listGrants = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(0, "network_error", ""))
      .mockResolvedValue({ grants: [] });
    setup({ listGrants });
    expect((await screen.findByRole("alert")).textContent).toContain("Can't reach the server");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Nothing allowed in advance.")).toBeTruthy();
  });

  it("asks to confirm, then revokes and removes the row", async () => {
    const revokeGrant = vi.fn().mockResolvedValue({ ok: true });
    setup({
      listGrants: vi.fn().mockResolvedValue({ grants: [grant({ id: "g1" }), grant({ id: "g2", operation: "other" })] }),
      revokeGrant,
    });
    await screen.findByRole("list");
    fireEvent.click(screen.getByRole("button", { name: "Revoke demo · send_email" }));
    expect(revokeGrant).not.toHaveBeenCalled();
    expect(screen.getByText("Revoke?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByText("Revoke?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revoke demo · send_email" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, revoke demo · send_email" }));
    await waitFor(() => expect(revokeGrant).toHaveBeenCalledWith("g1"));
    await waitFor(() =>
      expect(within(screen.getByRole("list", { name: "Grants in force" })).getAllByRole("listitem")).toHaveLength(1),
    );
    expect(screen.queryByText("demo · send_email")).toBeNull();
  });

  it("keeps the row and says why when revoking fails", async () => {
    const revokeGrant = vi.fn().mockRejectedValue(new ApiError(0, "network_error", ""));
    setup({ listGrants: vi.fn().mockResolvedValue({ grants: [grant()] }), revokeGrant });
    await screen.findByRole("list");
    fireEvent.click(screen.getByRole("button", { name: /^Revoke/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Yes, revoke/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Can't reach the server");
    expect(within(screen.getByRole("list", { name: "Grants in force" })).getAllByRole("listitem")).toHaveLength(1);
  });
});
