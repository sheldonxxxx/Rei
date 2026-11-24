import type { Agent } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CompanionSetting } from "./CompanionSetting.tsx";

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  avatar: "bot:sprout",
  model: null,
  thinkingLevel: "off",
  networkMode: "block",
  defaultProfile: "standard",
  homeSessionId: `home-${id}`,
});
const agents = [agent("a1", "Assistant"), agent("a2", "Helper")];

it("shows the companion agent and saves a new pick", async () => {
  const updateCompanion = vi.fn().mockResolvedValue({ companion: { agentId: "a2", homeSessionId: "home-a2" } });
  render(
    <CompanionSetting
      api={{ updateCompanion }}
      agents={agents}
      companion={{ agentId: "a1", homeSessionId: "home-a1" }}
    />,
  );
  const select = screen.getByLabelText("Companion") as HTMLSelectElement;
  expect(select.value).toBe("a1");
  fireEvent.change(select, { target: { value: "a2" } });
  await waitFor(() => expect(updateCompanion).toHaveBeenCalledWith({ agentId: "a2" }));
});

it("says why a pick failed", async () => {
  const updateCompanion = vi.fn().mockRejectedValue(new Error("That agent does not exist."));
  render(
    <CompanionSetting
      api={{ updateCompanion }}
      agents={agents}
      companion={{ agentId: "a1", homeSessionId: "home-a1" }}
    />,
  );
  fireEvent.change(screen.getByLabelText("Companion"), { target: { value: "a2" } });
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect((screen.getByLabelText("Companion") as HTMLSelectElement).value).toBe("a1");
});

it("waits for the companion before it can be changed", () => {
  render(<CompanionSetting api={{ updateCompanion: vi.fn() }} agents={agents} companion={null} />);
  expect((screen.getByLabelText("Companion") as HTMLSelectElement).disabled).toBe(true);
});
