import type { SessionSkillOption } from "@rei/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.ts";
import type { ComposerDraft } from "../lib/composerDraft.ts";
import { Composer } from "./Composer.tsx";

const drafts = vi.hoisted(() => ({
  load: vi.fn<(id: string) => Promise<ComposerDraft | undefined>>(),
  save: vi.fn<(id: string, draft: ComposerDraft) => Promise<void>>(),
}));
vi.mock("../lib/composerDraft.ts", () => ({
  loadComposerDraft: drafts.load,
  saveComposerDraft: drafts.save,
}));

const option = (id: string, name: string, extra: Partial<SessionSkillOption> = {}): SessionSkillOption => ({
  id,
  name,
  description: `${name} helps.`,
  version: 1,
  bodyChars: 1200,
  ...extra,
});
const SKILLS = [option("s1", "review"), option("s2", "acme/summarize", { version: 3, bodyChars: 90 })];
const apiOf = (skills = SKILLS) =>
  ({
    getSessionSkills: vi.fn().mockResolvedValue({ skills }),
    getConnectors: vi.fn().mockResolvedValue({ connectors: [] }),
  }) as unknown as import("../api/client.ts").Api;

const setup = (props: Partial<Parameters<typeof Composer>[0]> = {}) => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  const onCompact = vi.fn().mockResolvedValue(undefined);
  const api = apiOf();
  render(
    <Composer
      onSend={onSend}
      onCompact={onCompact}
      onStop={vi.fn()}
      running={false}
      api={api}
      sessionId="ses1"
      {...props}
    />,
  );
  const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
  return { onSend, onCompact, api, input };
};
const type = (input: HTMLTextAreaElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  input.setSelectionRange(value.length, value.length);
};
const send = () => fireEvent.click(screen.getByRole("button", { name: "Send message" }));
const sendButton = () => screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;

beforeEach(() => {
  drafts.load.mockReset();
  drafts.save.mockReset();
  drafts.load.mockResolvedValue(undefined);
  drafts.save.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("slash palette", () => {
  it("opens for a leading slash with /compact and the session's skills, tagged and sized", async () => {
    const { input, api } = setup();
    type(input, "/");
    expect(await screen.findByRole("option", { name: /review/ })).toBeTruthy();
    expect(screen.getByRole("listbox", { name: "Commands and skills" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /\/compact/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /acme\/summarize/ }).textContent).toMatch(/90 characters/);
    expect(screen.getByRole("option", { name: /review/ }).textContent).toMatch(/1\.2k characters/);
    expect(api.getSessionSkills).toHaveBeenCalledWith("ses1");
  });

  it("does not open in the middle of a sentence, for a path later in the line, or for text after the first word", () => {
    const { input, api } = setup();
    type(input, "please /review this");
    expect(screen.queryByRole("listbox")).toBeNull();
    type(input, "/review this change");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(api.getSessionSkills).not.toHaveBeenCalled();
  });

  it("filters by name and says when nothing matches", async () => {
    const { input } = setup();
    type(input, "/acme/su");
    expect(await screen.findByRole("option", { name: /acme\/summarize/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /review/ })).toBeNull();
    type(input, "/zzz");
    expect(await screen.findByText("No matching skills.")).toBeTruthy();
  });

  it("closes with Escape and leaves the draft untouched", async () => {
    const { input } = setup();
    type(input, "/rev");
    await screen.findByRole("option", { name: /review/ });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.value).toBe("/rev");
  });

  it("moves with the arrow keys and picks with Enter, without sending", async () => {
    const { input, onSend } = setup();
    type(input, "/");
    await screen.findByRole("option", { name: /review/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "Skills for this message" }).textContent).toMatch(/acme\/summarize/);
    expect(input.value).toBe("");
  });

  it("sends an unknown slash word as ordinary text when Enter finds nothing to pick", async () => {
    const { input, onSend, onCompact } = setup();
    type(input, "/usr/bin/env");
    await screen.findByText("No matching skills.");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/usr/bin/env");
    expect(onCompact).not.toHaveBeenCalled();
  });
});

describe("tab completion", () => {
  // `fireEvent` answers false when the handler took the key (prevented the default focus move).
  const tab = (input: HTMLTextAreaElement, modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {}) =>
    !fireEvent.keyDown(input, { key: "Tab", ...modifiers });
  const chips = () => screen.queryByRole("list", { name: "Skills for this message" });
  const highlighted = () => screen.getByRole("option", { selected: true }).textContent;

  it("completes the skill whose name was typed, not an earlier row that only mentions it", async () => {
    const { input, onSend } = setup({
      api: apiOf([option("s1", "triage", { description: "Runs after summarize." }), option("s2", "acme/summarize")]),
    });
    type(input, "/summ");
    await screen.findByRole("option", { name: /acme\/summarize/ });
    expect(highlighted()).toMatch(/acme\/summarize/);
    expect(tab(input)).toBe(true);
    expect(chips()?.textContent).toMatch(/acme\/summarize/);
    expect(chips()?.textContent).not.toMatch(/triage/);
    expect(input.value).toBe("");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("completes the row moved to with the arrows", async () => {
    const { input } = setup();
    type(input, "/");
    await screen.findByRole("option", { name: /review/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(tab(input)).toBe(true);
    expect(chips()?.textContent).toMatch(/review/);
  });

  it("fills /compact in without running it, even when it is already typed in full", async () => {
    const { input, onCompact } = setup();
    for (const typed of ["/comp", "/compact"]) {
      type(input, typed);
      await screen.findByRole("option", { name: /\/compact/ });
      expect(tab(input)).toBe(true);
      expect(input.value).toBe("/compact ");
    }
    expect(onCompact).not.toHaveBeenCalled();
  });

  it("completes a connector mention from its name", async () => {
    const connectors = [
      { id: "c1", name: "Linear", status: "connected" },
      { id: "c2", name: "GitHub", status: "connected" },
    ];
    const api = { ...apiOf(), getConnectors: vi.fn().mockResolvedValue({ connectors }) };
    const { input, onSend } = setup({ api: api as unknown as import("../api/client.ts").Api });
    type(input, "ask @git");
    await screen.findByRole("option", { name: /GitHub/ });
    expect(tab(input)).toBe(true);
    expect(input.value).toBe("ask @GitHub ");
    send();
    expect(onSend).toHaveBeenCalledWith("ask @GitHub ", {
      mentions: [{ kind: "connector", id: "c2", label: "GitHub", start: 4, end: 11 }],
    });
  });

  it("highlights a usable name match ahead of the attachment row and a connector that needs sign-in", async () => {
    const connectors = [
      { id: "c1", name: "Mail archive", status: "needs_auth" },
      { id: "c2", name: "Maps", status: "connected" },
    ];
    const api = { ...apiOf(), getConnectors: vi.fn().mockResolvedValue({ connectors }) };
    const { input } = setup({ api: api as unknown as import("../api/client.ts").Api });
    type(input, "@ma");
    await screen.findByRole("option", { name: /Maps/ });
    expect(highlighted()).toMatch(/Maps/);
    expect(tab(input)).toBe(true);
    expect(input.value).toBe("@Maps ");
  });

  it("leaves Tab alone with no list, nothing to complete, or a modifier", async () => {
    const { input } = setup();
    type(input, "hello");
    expect(tab(input)).toBe(false);
    type(input, "/zzz");
    await screen.findByText("No matching skills.");
    expect(tab(input)).toBe(false);
    type(input, "/rev");
    await screen.findByRole("option", { name: /review/ });
    expect(tab(input, { shiftKey: true })).toBe(false);
    expect(tab(input, { ctrlKey: true })).toBe(false);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(tab(input)).toBe(false);
    expect(input.value).toBe("/rev");
    expect(chips()).toBeNull();
  });

  it("leaves Tab alone while the + menu is open", async () => {
    const { input } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add attachments and context" }));
    await screen.findByRole("option", { name: /Upload attachment/ });
    expect(tab(input)).toBe(false);
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});

describe("selected skills", () => {
  const pick = async (input: HTMLTextAreaElement, name: RegExp, query = "/") => {
    type(input, query);
    fireEvent.click(await screen.findByRole("option", { name }));
  };

  it("adds a removable chip, consumes only the command token, and keeps the rest of the draft", async () => {
    const { input } = setup();
    await pick(input, /review/);
    const chips = screen.getByRole("list", { name: "Skills for this message" });
    expect(chips.textContent).toMatch(/review/);
    expect(input.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Remove skill review" }));
    expect(screen.queryByRole("list", { name: "Skills for this message" })).toBeNull();
  });

  it("keeps Send off, with the reason, until there is a message to send with the chip", async () => {
    const { input } = setup();
    await pick(input, /review/);
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText("Add a message to send with the selected skills.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "check this" } });
    expect(sendButton().disabled).toBe(false);
  });

  it("sends the chips as id, version and name with one request id, and clears the draft only when accepted", async () => {
    const { input, onSend } = setup();
    await pick(input, /acme\/summarize/);
    fireEvent.change(input, { target: { value: "please" } });
    send();
    await waitFor(() => expect(input.value).toBe(""));
    expect(onSend).toHaveBeenCalledWith(
      "please",
      { selectedSkills: [{ id: "s2", version: 3, name: "acme/summarize" }] },
      expect.any(String),
    );
    expect(screen.queryByRole("list", { name: "Skills for this message" })).toBeNull();
  });

  it("keeps the draft and the chips, and says why, when the server refuses; a resend reuses the request id", async () => {
    const refused = new ApiError(409, "skill_unavailable", "The skill review is not available to this agent any more.");
    const { input, onSend } = setup();
    onSend.mockRejectedValueOnce(refused).mockRejectedValueOnce(new ApiError(0, "network", "offline"));
    await pick(input, /review/);
    fireEvent.change(input, { target: { value: "check this" } });
    send();
    expect(await screen.findByText(/not available to this agent any more/)).toBeTruthy();
    expect(input.value).toBe("check this");
    expect(screen.getByRole("list", { name: "Skills for this message" })).toBeTruthy();
    send();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(input.value).toBe("check this"));
    send();
    await waitFor(() => expect(input.value).toBe(""));
    const ids = onSend.mock.calls.map((c) => c[2]);
    expect(new Set(ids).size).toBe(1);
  });

  it("uses a new request id once the draft changes", async () => {
    const { input, onSend } = setup();
    onSend.mockRejectedValue(new ApiError(0, "network", "offline"));
    await pick(input, /review/);
    fireEvent.change(input, { target: { value: "one" } });
    send();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    await screen.findByRole("status");
    fireEvent.change(input, { target: { value: "two" } });
    send();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend.mock.calls[0]![2]).not.toBe(onSend.mock.calls[1]![2]);
  });

  it("greys out a skill that is already chosen, and every skill once five are chosen", async () => {
    const many = Array.from({ length: 6 }, (_, i) => option(`k${i}`, `skill-${i}`));
    const { input } = setup({ api: apiOf(many) });
    for (let i = 0; i < 5; i++) await pick(input, new RegExp(`skill-${i}\\b`));
    expect(screen.getAllByRole("button", { name: /Remove skill/ })).toHaveLength(5);
    type(input, "/");
    const last = await screen.findByRole("option", { name: /skill-5/ });
    expect(last.getAttribute("aria-disabled")).toBe("true");
    expect(last.textContent).toMatch(/Up to 5 skills per message/);
    fireEvent.click(last);
    expect(screen.getAllByRole("button", { name: /Remove skill/ })).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Remove skill skill-0" }));
    type(input, "/");
    const dup = await screen.findByRole("option", { name: /skill-1\b/ });
    expect(dup.getAttribute("aria-disabled")).toBe("true");
    expect(dup.textContent).toMatch(/Already added/);
  });

  it("re-checks restored chips: a current one moves to the latest version, a gone one is marked and blocks Send", async () => {
    vi.stubGlobal("indexedDB", {});
    drafts.load.mockResolvedValue({
      text: "carry on",
      mentions: [],
      files: [],
      selectedSkills: [
        { id: "s1", name: "review", version: 1 },
        { id: "gone", name: "retired", version: 2 },
      ],
    });
    const api = apiOf([option("s1", "review", { version: 4 })]);
    setup({ api });
    const chips = await screen.findByRole("list", { name: "Skills for this message" });
    await waitFor(() => expect(chips.textContent).toMatch(/retired\s*unavailable/));
    expect(chips.querySelector('[title="review · version 4"]')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText("Selected skill unavailable. Remove it to send.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove skill retired" }));
    expect(sendButton().disabled).toBe(false);
  });

  it("saves chips in the draft, and a chip-only draft is kept", async () => {
    vi.stubGlobal("indexedDB", {});
    drafts.load.mockResolvedValue(undefined);
    const { input } = setup();
    await pick(input, /review/);
    await waitFor(() =>
      expect(drafts.save).toHaveBeenLastCalledWith(
        "ses1",
        expect.objectContaining({ selectedSkills: [{ id: "s1", name: "review", version: 1 }] }),
      ),
    );
  });
});

describe("/compact", () => {
  it("runs the built-in on Enter, not as a message, and clears only the command", async () => {
    const { input, onSend, onCompact } = setup();
    type(input, "/compact");
    await screen.findByRole("option", { name: /\/compact/ });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onCompact).toHaveBeenCalledWith(undefined, expect.any(String)));
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("takes the text after it as guidance and keeps skill chips for the next message", async () => {
    const { input, onCompact } = setup();
    type(input, "/");
    fireEvent.click(await screen.findByRole("option", { name: /review/ }));
    type(input, "/compact keep the decisions");
    send();
    await waitFor(() => expect(onCompact).toHaveBeenCalledWith("keep the decisions", expect.any(String)));
    await waitFor(() => expect(input.value).toBe(""));
    expect(screen.getByRole("list", { name: "Skills for this message" }).textContent).toMatch(/review/);
  });

  it("picked from the list it waits for optional guidance instead of running", async () => {
    const { input, onCompact } = setup();
    type(input, "/comp");
    fireEvent.click(await screen.findByRole("option", { name: /\/compact/ }));
    expect(input.value).toBe("/compact ");
    expect(onCompact).not.toHaveBeenCalled();
  });

  it("keeps the draft and shows the reason when the server refuses it", async () => {
    const { input, onCompact } = setup();
    onCompact.mockRejectedValueOnce(new ApiError(409, "busy", "The chat is busy. Wait for the reply to finish."));
    type(input, "/compact keep this");
    send();
    expect(await screen.findByText(/The chat is busy/)).toBeTruthy();
    expect(input.value).toBe("/compact keep this");
  });

  it("refuses over-long guidance in the composer, counted in characters", async () => {
    const { input, onCompact } = setup();
    type(input, `/compact ${"é".repeat(4001)}`);
    send();
    expect(await screen.findByText(/at most 4000 characters/)).toBeTruthy();
    expect(onCompact).not.toHaveBeenCalled();
  });

  it("says the chat is busy while a reply is running, without asking the server", async () => {
    const { input, onCompact } = setup({ running: true });
    type(input, "/compact");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(/Session busy/)).toBeTruthy();
    expect(onCompact).not.toHaveBeenCalled();
    expect(input.value).toBe("/compact");
  });

  it("shows what the compaction is doing and turns Send off with the reason while it runs", () => {
    setup({ compaction: { requestId: "r1", status: "running" } });
    expect(screen.getByText("Compacting the conversation…")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText(/You can send when it finishes/)).toBeTruthy();
  });

  it("says the summary is waiting to be placed when it is", () => {
    setup({ compaction: { requestId: "r1", status: "pending_placement" } });
    expect(screen.getByText(/being placed in the conversation/)).toBeTruthy();
  });
});
