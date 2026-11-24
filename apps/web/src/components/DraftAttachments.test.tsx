import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftFile } from "../lib/composerDraft.ts";
import { DraftAttachments } from "./DraftAttachments.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const actions = () => ({ onPreview: vi.fn(), onRemove: vi.fn(), onRetry: vi.fn(), onInsert: vi.fn() });
const draft = (): DraftFile => ({
  key: "one",
  file: new File(["Date,Amount\n2026-11-04,24"], "account.csv", { type: "text/csv" }),
  status: "uploading",
});

describe("attachment tray", () => {
  it("keeps the card mounted when an upload completes and enables preview", async () => {
    const file = draft(),
      handlers = actions();
    const { rerender } = render(<DraftAttachments files={[file]} {...handlers} />);
    const button = screen.getByRole("button", { name: "Preview account.csv" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("progressbar", { name: "Uploading account.csv" })).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".draft-thumbnail td")?.textContent).toBe("Date"));
    const attachment = { id: "a1", name: file.file.name, size: file.file.size, mediaType: "text/csv" };
    rerender(<DraftAttachments files={[{ ...file, status: "ready", attachment }]} {...handlers} />);
    expect(screen.getByRole("button", { name: "Preview account.csv" })).toBe(button);
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(button);
    expect(handlers.onPreview).toHaveBeenCalledWith(attachment);
  });

  it("makes a collapsing tray inaccessible immediately and releases previews after the transition", () => {
    vi.useFakeTimers();
    const file = { ...draft(), file: new File(["x"], "example.pdf", { type: "application/pdf" }) };
    const handlers = actions();
    const { rerender } = render(<DraftAttachments files={[file]} {...handlers} />);
    rerender(<DraftAttachments files={[]} {...handlers} />);
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
    expect(document.querySelector(".draft-attachment-tray")?.hasAttribute("inert")).toBe(true);
    expect(document.querySelector(".draft-file")).not.toBeNull();
    act(() => vi.advanceTimersByTime(300));
    expect(document.querySelector(".draft-file")).toBeNull();
  });

  it("revokes local image URLs when a file is removed", () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:thumbnail");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const file = { ...draft(), file: new File(["image"], "photo.png", { type: "image/png" }) };
    const { unmount } = render(<DraftAttachments files={[file]} {...actions()} />);
    expect(create).toHaveBeenCalledWith(file.file);
    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:thumbnail");
  });
});
