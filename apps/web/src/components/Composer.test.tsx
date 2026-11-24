import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { message } from "../test/fixtures.ts";
import { Composer, type ComposerHandle } from "./Composer.tsx";

const setup = (props: Partial<Parameters<typeof Composer>[0]> = {}) => {
  const onSend = vi.fn();
  const onStop = vi.fn();
  render(<Composer onSend={onSend} onStop={onStop} running={false} {...props} />);
  return { onSend, onStop, input: screen.getByLabelText("Message") as HTMLTextAreaElement };
};

describe("Composer", () => {
  it("disables Send while empty", () => {
    const { input } = setup();
    const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "   " } });
    expect(send.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "hi" } });
    expect(send.disabled).toBe(false);
  });

  it("Enter sends and clears", () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: "hello there" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello there");
    expect(input.value).toBe("");
  });

  it("Shift+Enter does not send", () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("line one");
  });

  it("Enter on an empty composer does nothing", () => {
    const { input, onSend } = setup();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("ignores the Enter that confirms an IME composition", () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: "你好" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows Stop only while running, and it calls onStop", () => {
    const first = setup({ running: false });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    cleanup();
    const onStop = vi.fn();
    render(<Composer onSend={first.onSend} onStop={onStop} running={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("warns about queued messages and restores a stopped draft with its attachments", () => {
    const draftRef = createRef<ComposerHandle>();
    const { onSend, input } = setup({ running: true, hasQueuedMessages: true, draftRef });
    const stop = screen.getByRole("button", { name: "Stop" });
    const warning = screen.getByText("Stop also cancels messages still waiting.");
    expect(stop.getAttribute("aria-describedby")).toBe(warning.id);

    const attachment = { id: "att-1", name: "notes.txt", size: 10, mediaType: "text/plain" };
    act(() => draftRef.current?.restoreDraft(message({ text: "queued text", attachments: [attachment] })));
    expect(input.value).toBe("queued text");
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("queued text", { attachments: [attachment] });
  });

  it("sends with the setting's default on Enter and the other on Alt+Enter while a reply runs", () => {
    const { onSend, input } = setup({ running: true, whenBusy: "steer" });
    fireEvent.change(input, { target: { value: "use pnpm" } });
    expect(screen.getByText("Enter steers the reply · Alt+Enter queues it for after")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenLastCalledWith("use pnpm");
    fireEvent.change(input, { target: { value: "then the tests" } });
    fireEvent.keyDown(input, { key: "Enter", altKey: true });
    expect(onSend).toHaveBeenLastCalledWith("then the tests", undefined, undefined, { whenBusy: "queue" });
  });

  it("steers on Alt+Enter when the setting queues, and ignores Alt when idle", () => {
    const busy = setup({ running: true, whenBusy: "queue" });
    fireEvent.change(busy.input, { target: { value: "stop, wrong file" } });
    expect(screen.getByText("Enter queues it for after the reply · Alt+Enter steers the reply")).toBeTruthy();
    fireEvent.keyDown(busy.input, { key: "Enter", altKey: true });
    expect(busy.onSend).toHaveBeenLastCalledWith("stop, wrong file", undefined, undefined, { whenBusy: "steer" });
    cleanup();
    const idle = setup({ running: false, whenBusy: "queue" });
    fireEvent.change(idle.input, { target: { value: "hello" } });
    expect(screen.queryByText(/Alt\+Enter/)).toBeNull();
    fireEvent.keyDown(idle.input, { key: "Enter", altKey: true });
    expect(idle.onSend).toHaveBeenLastCalledWith("hello");
  });
});

// Context and uploads use the same editor and send contract as plain text.
describe("composer context", () => {
  const api = (
    upload = vi.fn().mockResolvedValue({ id: "att1", name: "pasted.txt", size: 4001, mediaType: "text/plain" }),
  ) =>
    ({
      getConnectors: vi.fn().mockResolvedValue({
        connectors: [
          { id: "c1", name: "Notes", status: "connected" },
          { id: "c2", name: "Mail", status: "needs_auth" },
        ],
      }),
      uploadAttachment: upload,
    }) as unknown as import("../api/client.ts").Api;
  const session = (id: string, title: string) =>
    ({ id, title, agentId: "a1", origin: "user" }) as import("@rei/protocol").Session;
  const paste = (input: HTMLTextAreaElement, text: string, files: File[] = []) =>
    fireEvent.paste(input, { clipboardData: { getData: () => text, files } });

  it("only offers connectors enabled for the current agent", async () => {
    setup({ api: api(), sessionId: "current", allowedConnectorIds: ["c1"] });
    fireEvent.click(screen.getByRole("button", { name: "Add attachments and context" }));
    expect(await screen.findByRole("option", { name: /Notes/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Mail/ })).toBeNull();
  });

  it("opens from +, inserts a stable chat mention at the cursor, and sends its metadata", async () => {
    const { input, onSend } = setup({
      api: api(),
      sessionId: "current",
      sessions: [session("current", "Current"), session("s1", "Same"), session("s2", "Same")],
    });
    fireEvent.change(input, { target: { value: "Read " } });
    input.setSelectionRange(5, 5);
    fireEvent.click(screen.getByRole("button", { name: "Add attachments and context" }));
    expect(screen.queryByRole("option", { name: /Current/ })).toBeNull();
    fireEvent.click(screen.getAllByRole("option", { name: /Same/ })[1]!);
    expect(input.value).toBe("Read @Same ");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith("Read @Same ", {
      mentions: [{ kind: "chat", id: "s2", label: "Same", start: 5, end: 10 }],
    });
  });

  it("opens the Library picker from the attachment menu", async () => {
    const mock = { ...api(), listFiles: vi.fn().mockResolvedValue({ files: [] }) };
    setup({ api: mock, sessionId: "current" });
    expect(screen.queryByText("Choose from Library")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add attachments and context" }));
    fireEvent.click(screen.getByRole("option", { name: /Choose from Library/ }));
    expect(screen.getByRole("dialog", { name: "Choose library files" })).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(await screen.findByLabelText("Search saved files")).toBeTruthy();
  });

  it("offers only the five most recently updated other chats", async () => {
    const chats = [1, 6, 3, 7, 2, 5, 4].map((n) => ({ ...session(`s${n}`, `Chat ${n}`), updatedAt: n }));
    const { input } = setup({ api: api(), sessionId: "s7", sessions: chats });
    fireEvent.change(input, { target: { value: "@" } });
    const options = screen.getAllByRole("option");
    expect(
      options.filter((option) => option.textContent?.includes("Chat ")).map((option) => option.textContent),
    ).toEqual([6, 5, 4, 3, 2].map((n) => expect.stringContaining(`Chat ${n}`)));
    expect(screen.queryByRole("option", { name: /Chat 1/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Chat 7/ })).toBeNull();
    expect(await screen.findByRole("option", { name: /Notes/ })).toBeTruthy();
  });

  it("filters @ queries, keeps Enter for selection, and disables unavailable connectors", async () => {
    const { input, onSend } = setup({ api: api(), sessionId: "current" });
    fireEvent.change(input, { target: { value: "@No" } });
    await screen.findByRole("option", { name: /Notes/ });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("@Notes ");
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add attachments and context" }));
    expect((await screen.findByRole("option", { name: /Mail/ })).getAttribute("aria-disabled")).toBe("true");
  });

  it("sends an @ word that matches nothing instead of swallowing Enter", async () => {
    const { input, onSend } = setup({ api: api(), sessionId: "current" });
    const text = '// @options: {"timeout": 5}';
    fireEvent.change(input, { target: { value: text } });
    input.setSelectionRange(text.length, text.length);
    expect(await screen.findByText("No matching connectors, chats or pages.")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith(text);
  });

  it("converts a large paste without changing the draft and allows an attachment-only send", async () => {
    const mock = api();
    const { input, onSend } = setup({ api: mock, sessionId: "s1" });
    const text = " first\r\n" + "🦊".repeat(4001) + "\n last ";
    paste(input, text);
    expect(input.value).toBe("");
    await screen.findByRole("button", { name: "Insert as text" });
    expect(mock.uploadAttachment).toHaveBeenCalledTimes(1);
    const file = vi.mocked(mock.uploadAttachment).mock.calls[0]![1];
    expect(file.name).toMatch(/^pasted-text-\d{8}-\d{6}\.txt$/);
    expect(await file.text()).toBe(text);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith("", { attachments: [expect.objectContaining({ id: "att1" })] });
  });

  it("leaves exactly 4000 Unicode characters inline", () => {
    const mock = api();
    const { input } = setup({ api: mock, sessionId: "s1" });
    paste(input, "🦊".repeat(4000));
    expect(input.value).toBe("🦊".repeat(4000));
    expect(mock.uploadAttachment).not.toHaveBeenCalled();
  });

  it("retains failed large pastes and recovers their exact content through Insert as text", async () => {
    const mock = api(vi.fn().mockRejectedValue(new Error("Offline")));
    const { input } = setup({ api: mock, sessionId: "s1" });
    fireEvent.change(input, { target: { value: "Keep this" } });
    input.setSelectionRange(9, 9);
    fireEvent.select(input);
    const text = "\n " + "x".repeat(4001) + "\r\n ";
    paste(input, text);
    expect(input.value).toBe("Keep this");
    await screen.findByRole("button", { name: "Retry upload" });
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Insert as text" }));
    // Native textarea normalizes CRLF to LF; the generated file preserves the original clipboard bytes.
    expect(input.value).toBe(("Keep this" + text).replace(/\r\n/g, "\n"));
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });

  it("prefers clipboard files over their accompanying large text", async () => {
    const mock = api();
    const { input } = setup({ api: mock, sessionId: "s1" });
    const file = new File(["photo"], "photo.png", { type: "image/png" });
    paste(input, "x".repeat(5000), [file]);
    await screen.findByRole("button", { name: "Remove photo.png" });
    expect(mock.uploadAttachment).toHaveBeenCalledWith("s1", file);
    expect(mock.uploadAttachment).toHaveBeenCalledTimes(1);
  });

  it("removes an inline mention atomically with Backspace", async () => {
    const { input, onSend } = setup({ api: api(), sessionId: "current", sessions: [session("s1", "Other")] });
    fireEvent.change(input, { target: { value: "@Other" } });
    fireEvent.click(screen.getByRole("option", { name: /Other/ }));
    input.setSelectionRange(6, 6);
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(input.value).toBe(" ");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });
});

it("consumes the @ query when choosing Upload attachment", () => {
  const mock = {
    getConnectors: vi.fn().mockResolvedValue({ connectors: [] }),
    uploadAttachment: vi.fn(),
  } as unknown as import("../api/client.ts").Api;
  const { input } = setup({ api: mock, sessionId: "s1" });
  fireEvent.change(input, { target: { value: "Read @upload" } });
  fireEvent.click(screen.getByRole("option", { name: /Upload attachment/ }));
  expect(input.value).toBe("Read ");
});
