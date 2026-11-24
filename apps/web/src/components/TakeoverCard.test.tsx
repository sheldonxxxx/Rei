import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client.ts";
import { message, takeover } from "../test/fixtures.ts";
import { MessageItem } from "./MessageItem.tsx";

const card = (t = takeover(), props: Record<string, unknown> = {}) =>
  render(
    <ul>
      <MessageItem
        message={message({ id: "m-t", role: "takeover", status: "complete", runId: null, takeover: t })}
        {...props}
      />
    </ul>,
  );

describe("takeover card", () => {
  it("pending: says what the assistant needs, where, and offers Take over and Not now", () => {
    const onTakeOver = vi.fn();
    const { container } = card(takeover(), { onTakeOver, onEndTakeover: vi.fn() });
    expect(screen.getByText("The assistant needs you in the browser")).toBeTruthy();
    expect(container.querySelector(".approval-summary")?.textContent).toBe("Sign in to the bank");
    expect(container.querySelector(".approval-facts")?.textContent).toContain("bank.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    expect(onTakeOver).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  });

  it("pending: Not now cancels the request and the card shows it at once", async () => {
    const onEndTakeover = vi.fn().mockResolvedValue(takeover({ status: "cancelled" }));
    card(takeover(), { onTakeOver: vi.fn(), onEndTakeover });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(onEndTakeover).toHaveBeenCalledWith("t1", { action: "cancel" }));
    expect(await screen.findByText("Cancelled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("pending: shows an error and keeps the buttons when Not now fails", async () => {
    card(takeover(), {
      onTakeOver: vi.fn(),
      onEndTakeover: vi.fn().mockRejectedValue(new ApiError(409, "not_open", "")),
    });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This request is already over.");
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();
  });

  it("pending, read-only (no handlers): the buttons are disabled", () => {
    card();
    expect((screen.getByRole("button", { name: "Take over" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Not now" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("pending in a spawned session shown in its parent: links to that chat instead", () => {
    card(takeover({ sessionId: "child 1" }));
    expect(screen.getByRole("link", { name: "Open chat" }).getAttribute("href")).toBe("/s/child%201");
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("active: says you're in control and can reopen the browser", () => {
    const onOpenBrowser = vi.fn();
    card(takeover({ status: "active", requestedBy: "user", reason: null }), { onOpenBrowser });
    expect(screen.getByText("You're in control")).toBeTruthy();
    expect(screen.queryByText(/waits until you press Done/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open browser" }));
    expect(onOpenBrowser).toHaveBeenCalled();
  });

  it("done: one line with your note; cancelled: one line", () => {
    const { unmount } = card(takeover({ status: "done", note: "Signed in", endedAt: 5000 }));
    expect(screen.getByLabelText("You finished in the browser: Signed in")).toBeTruthy();
    expect(screen.getByText(/You finished in the browser/).textContent).toBe("You finished in the browser");
    expect(screen.getByText(/Signed in/)).toBeTruthy();
    unmount();
    card(takeover({ status: "cancelled", note: null, endedAt: 5000 }));
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders as plain text: a reason with markup is not parsed", () => {
    const { container } = card(takeover({ reason: "<img src=x onerror=alert(1)> **bold**" }), { onTakeOver: vi.fn() });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".approval-summary")?.textContent).toBe("<img src=x onerror=alert(1)> **bold**");
  });
});
