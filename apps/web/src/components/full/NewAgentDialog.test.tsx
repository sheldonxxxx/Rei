import type { Agent, CreateAgentResponse } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../../api/client.ts";
import { ApiError } from "../../api/client.ts";
import { agent, session } from "../../test/fixtures.ts";
import { NewAgentDialog } from "./NewAgentDialog.tsx";

const asApi = (partial: Partial<Record<keyof Api, unknown>>) => partial as unknown as Api;
const created: CreateAgentResponse = {
  agent: agent({ id: "a2", name: "Sam", homeSessionId: "h2" }) as Agent,
  session: session({ id: "h2", agentId: "a2", origin: "home" }),
};

describe("NewAgentDialog", () => {
  it("needs a description, then creates the agent and hands back the result", async () => {
    const createAgent = vi.fn().mockResolvedValue(created);
    const onCreated = vi.fn();
    render(<NewAgentDialog api={asApi({ createAgent })} onClose={() => {}} onCreated={onCreated} />);
    const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    const box = screen.getByLabelText("What kind of agent do you want?") as HTMLTextAreaElement;
    expect(box.maxLength).toBe(500);
    fireEvent.change(box, { target: { value: "  a social media manager " } });
    fireEvent.click(create);
    await waitFor(() => expect(createAgent).toHaveBeenCalledWith("a social media manager"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
  });

  it("shows the setting-up text while it works, and cannot be dismissed then", async () => {
    let finish: (r: CreateAgentResponse) => void = () => {};
    const createAgent = vi.fn(() => new Promise<CreateAgentResponse>((r) => (finish = r)));
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(<NewAgentDialog api={asApi({ createAgent })} onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText("What kind of agent do you want?"), { target: { value: "a tutor" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Setting up your agent…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    finish(created);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
  });

  it("shows an error and stays open so you can try again", async () => {
    const createAgent = vi.fn().mockRejectedValue(new ApiError(0, "network_error", ""));
    const onCreated = vi.fn();
    render(<NewAgentDialog api={asApi({ createAgent })} onClose={() => {}} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText("What kind of agent do you want?"), { target: { value: "a tutor" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Cancel closes", () => {
    const onClose = vi.fn();
    render(<NewAgentDialog api={asApi({})} onClose={onClose} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
