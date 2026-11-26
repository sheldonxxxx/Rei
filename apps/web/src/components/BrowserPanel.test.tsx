import type { Session } from "@rei/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import { FakeWebSocket, hello } from "../test/fakes.ts";
import { session, sessionBrowser, takeover } from "../test/fixtures.ts";
import { BrowserPanel } from "./BrowserPanel.tsx";

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => vi.unstubAllGlobals());

const withBrowser = (over: Partial<ReturnType<typeof sessionBrowser>> = {}): Session =>
  session({ browser: sessionBrowser(over) });
const activeSession = () =>
  withBrowser({ takeover: takeover({ status: "active", requestedBy: "user", reason: null }) });

function setup(s: Session = withBrowser(), apiOver: Record<string, unknown> = {}, startSignal = 0) {
  const api = { startTakeover: vi.fn(), endTakeover: vi.fn(), ...apiOver };
  const onClose = vi.fn();
  const ui = (sess: Session, signal = startSignal) => (
    <BrowserPanel id="bp" api={api as unknown as Api} session={sess} startSignal={signal} onClose={onClose} />
  );
  const view = render(ui(s));
  return { api, onClose, rerender: (sess: Session, signal = startSignal) => view.rerender(ui(sess, signal)) };
}

/** The socket opens, then the server's hello says whether you are in control. */
async function connect(control: boolean) {
  await act(async () => {});
  act(() => FakeWebSocket.last.serverSend(hello({ control })));
}
const ws = () => FakeWebSocket.last;
const surface = () => document.querySelector<HTMLElement>(".live-surface")!;
/** The picture drawn at half size at (10, 20), so page pixels are twice the client offsets. */
const layout = () => {
  surface().getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 640, height: 450, right: 650, bottom: 470, x: 10, y: 20, toJSON() {} }) as DOMRect;
};
const mouse = (e: unknown) => (e as { type: string }).type === "mouse";

describe("browser panel: watching", () => {
  it("shows the page title and host, a status that follows the socket, and a Take over button", async () => {
    setup();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByText("bank.example.com")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Connecting…");
    expect(ws().url).toMatch(/^ws:\/\/.+\/api\/sessions\/s1\/browser\/live$/);
    await connect(false);
    expect(screen.getByRole("status").textContent).toBe("Live");
    expect(screen.queryByText("Watching")).toBeNull();
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();
    // The address bar is always there, so the layout does not change on takeover; it is inert until you are in control.
    expect((screen.getByLabelText("Address") as HTMLInputElement).disabled).toBe(true);
  });

  it("sizes the picture to the window's aspect ratio and follows viewport and page messages", async () => {
    setup();
    await connect(false);
    expect(surface().style.aspectRatio).toBe("1280 / 900");
    act(() => ws().serverSend({ type: "viewport", width: 800, height: 600 }));
    expect(surface().style.aspectRatio).toBe("800 / 600");
    act(() => ws().serverSend({ type: "page", url: "https://other.example.org/x", title: "Other" }));
    expect(screen.getByRole("heading", { name: "Other" })).toBeTruthy();
    expect(screen.getByText("other.example.org")).toBeTruthy();
  });

  it("draws frames and drops the placeholder once a picture arrives", async () => {
    const drawImage = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 1280, height: 900, close() {} }));
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as never);
    setup();
    await connect(false);
    expect(screen.getByText("Waiting for the first picture…")).toBeTruthy();
    act(() => ws().serverFrame());
    await waitFor(() => expect(drawImage).toHaveBeenCalled());
    expect(screen.queryByText("Waiting for the first picture…")).toBeNull();
    spy.mockRestore();
  });

  it("reconnects with backoff while open and says so", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      setup();
      await connect(false);
      act(() => ws().serverClose());
      expect(screen.getByRole("status").textContent).toBe("Reconnecting…");
      expect(FakeWebSocket.all).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40_000);
      });
      expect(FakeWebSocket.all).toHaveLength(2);
      await act(async () => {});
      act(() => ws().serverSend(hello()));
      expect(screen.getByRole("status").textContent).toBe("Live");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the window is closed when the server does, and when the chat has none", async () => {
    const { rerender } = setup();
    await connect(false);
    act(() => ws().serverSend({ type: "closed", reason: "closed" }));
    expect(screen.getByRole("status").textContent).toBe("Window closed");
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    rerender(session({ browser: null }));
    expect(screen.getByText("This chat's browser window is closed.")).toBeTruthy();
  });

  it("closes the socket when the panel unmounts, and on the close button and Escape", async () => {
    const { onClose } = setup();
    await connect(false);
    fireEvent.click(screen.getByRole("button", { name: "Close browser" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    const socket = ws();
    cleanup();
    expect(socket.closed).toBe(true);
  });
});

describe("browser panel: taking over", () => {
  it("Take over calls the server and turns into Done at once", async () => {
    const startTakeover = vi
      .fn()
      .mockResolvedValue({ takeover: takeover({ status: "active", requestedBy: "user", reason: null }) });
    const { api } = setup(withBrowser(), { startTakeover });
    await connect(false);
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(api.startTakeover).toHaveBeenCalledWith("s1"));
    expect(await screen.findByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    expect(screen.getByLabelText("Address")).toBeTruthy();
    // input is still held back until the server says control is on
    expect(screen.queryByLabelText("Keyboard input for the page")).toBeNull();
    act(() => ws().serverSend({ type: "control", control: true }));
    expect(screen.getByLabelText("Keyboard input for the page")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keyboard" })).toBeTruthy();
  });

  it("opens a pending agent request with its reason, and Take over / Not now call the server", async () => {
    const pending = withBrowser({ takeover: takeover() });
    const startTakeover = vi.fn().mockResolvedValue({ takeover: takeover({ status: "active" }) });
    const endTakeover = vi.fn().mockResolvedValue({ takeover: takeover({ status: "cancelled" }) });
    const { api } = setup(pending, { startTakeover, endTakeover });
    await connect(false);
    const banner = screen.getByRole("group", { name: "The assistant needs you" });
    expect(banner.textContent).toContain("Sign in to the bank");
    fireEvent.click(within(banner).getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(api.endTakeover).toHaveBeenCalledWith("t1", { action: "cancel" }));
    fireEvent.click(within(banner).getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(api.startTakeover).toHaveBeenCalledWith("s1"));
  });

  it("starts at once when opened from a card (startSignal), and again on each new signal", async () => {
    const startTakeover = vi.fn().mockResolvedValue({ takeover: takeover({ status: "active" }) });
    const { api, rerender } = setup(withBrowser({ takeover: takeover() }), { startTakeover }, 1);
    await waitFor(() => expect(api.startTakeover).toHaveBeenCalledTimes(1));
    rerender(withBrowser({ takeover: takeover() }), 2);
    await waitFor(() => expect(api.startTakeover).toHaveBeenCalledTimes(2));
  });

  it("does not start when opened to look (signal 0)", async () => {
    const { api } = setup(withBrowser(), {}, 0);
    await connect(false);
    expect(api.startTakeover).not.toHaveBeenCalled();
  });

  it("explains a failed start, and treats already-active as success", async () => {
    const startTakeover = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, "no_window", ""))
      .mockRejectedValueOnce(new ApiError(409, "already_active", ""));
    setup(withBrowser(), { startTakeover });
    await connect(false);
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The browser window is closed.");
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    await waitFor(() => expect(startTakeover).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("Done ends the takeover with the takeover id", async () => {
    const endTakeover = vi.fn().mockResolvedValue({ takeover: takeover({ status: "done" }) });
    const { api } = setup(activeSession(), { endTakeover });
    await connect(true);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(api.endTakeover).toHaveBeenCalledWith("t1", { action: "done" }));
    expect(screen.queryByRole("button", { name: "Give up" })).toBeNull();
  });

  it("goes back to watching when the stream says the takeover is over", async () => {
    const { rerender } = setup(activeSession());
    await connect(true);
    expect(screen.getByLabelText("Keyboard input for the page")).toBeTruthy();
    rerender(withBrowser({ takeover: null }));
    expect(screen.queryByLabelText("Keyboard input for the page")).toBeNull();
    expect(screen.getByRole("button", { name: "Take over" })).toBeTruthy();
  });
});

describe("browser panel: nothing is sent without control", () => {
  it("drops pointer, wheel and navigation events while only watching", async () => {
    setup();
    await connect(false);
    layout();
    fireEvent.pointerDown(surface(), { clientX: 50, clientY: 60, button: 0, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerUp(surface(), { clientX: 50, clientY: 60, button: 0, pointerId: 1, pointerType: "mouse" });
    fireEvent.wheel(surface(), { clientX: 50, clientY: 60, deltaY: 100 });
    expect(ws().sent).toEqual([]);
  });

  it("drops events when the takeover is active but the server has not given control, and after it takes it back", async () => {
    setup(activeSession());
    await connect(false);
    layout();
    fireEvent.pointerDown(surface(), { clientX: 50, clientY: 60, button: 0, pointerId: 1, pointerType: "mouse" });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(ws().sent).toEqual([]);

    act(() => ws().serverSend({ type: "control", control: true }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(ws().messages).toEqual([{ type: "nav", action: "reload" }]);
    act(() => ws().serverSend({ type: "control", control: false }));
    fireEvent.pointerDown(surface(), { clientX: 50, clientY: 60, button: 0, pointerId: 1, pointerType: "mouse" });
    expect(ws().messages).toHaveLength(1);
  });

  it("sends nothing through a stale socket after a reconnect until the new hello gives control", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      setup(activeSession());
      await connect(true);
      act(() => ws().serverClose());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40_000);
      });
      await act(async () => {});
      expect(screen.queryByLabelText("Keyboard input for the page")).toBeNull();
      act(() => ws().serverSend(hello({ control: true })));
      expect(screen.getByLabelText("Keyboard input for the page")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("browser panel: input mapping", () => {
  const takeoverReady = async () => {
    setup(activeSession());
    await connect(true);
    layout();
  };
  const keys = () => screen.getByLabelText("Keyboard input for the page") as HTMLTextAreaElement;

  it("maps mouse presses to page pixels with button and click count", async () => {
    await takeoverReady();
    fireEvent.pointerDown(surface(), {
      clientX: 10 + 320,
      clientY: 20 + 225,
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(surface(), {
      clientX: 10 + 320,
      clientY: 20 + 225,
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerDown(surface(), { clientX: 10, clientY: 20, button: 2, pointerId: 1, pointerType: "mouse" });
    expect(ws().messages).toEqual([
      { type: "mouse", action: "down", x: 640, y: 450, button: "left", clickCount: 1 },
      { type: "mouse", action: "up", x: 640, y: 450, button: "left", clickCount: 1 },
      { type: "mouse", action: "down", x: 0, y: 0, button: "right", clickCount: 1 },
    ]);
  });

  it("focuses the key field on a mouse press so typing goes to the page", async () => {
    await takeoverReady();
    keys().blur();
    fireEvent.pointerDown(surface(), { clientX: 20, clientY: 30, button: 0, pointerId: 1, pointerType: "mouse" });
    expect(document.activeElement).toBe(keys());
  });

  it("maps a tap on a phone to a press and release, without opening the keyboard", async () => {
    await takeoverReady();
    keys().blur();
    fireEvent.pointerDown(surface(), { clientX: 110, clientY: 120, button: 0, pointerId: 7, pointerType: "touch" });
    fireEvent.pointerUp(surface(), { clientX: 110, clientY: 120, button: 0, pointerId: 7, pointerType: "touch" });
    expect(ws().messages.filter(mouse)).toEqual([
      { type: "mouse", action: "down", x: 200, y: 200, button: "left", clickCount: 1 },
      { type: "mouse", action: "up", x: 200, y: 200, button: "left", clickCount: 1 },
    ]);
    expect(document.activeElement).not.toBe(keys());
  });

  it("maps a two-finger drag to wheel messages scaled to page pixels", async () => {
    await takeoverReady();
    const t = (id: number, x: number, y: number) => ({
      clientX: x,
      clientY: y,
      button: 0,
      pointerId: id,
      pointerType: "touch",
    });
    fireEvent.pointerDown(surface(), t(1, 100, 300));
    fireEvent.pointerDown(surface(), t(2, 200, 300));
    fireEvent.pointerMove(surface(), t(1, 100, 250));
    fireEvent.pointerMove(surface(), t(2, 200, 250));
    expect(ws().messages.every((m) => m.type === "wheel")).toBe(true);
    expect(ws().messages.reduce((n, m) => n + (m as { dy: number }).dy, 0)).toBe(100);
  });

  it("sends the wheel at the page point, converting lines to pixels", async () => {
    await takeoverReady();
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 0, deltaY: 3, deltaMode: 1 });
    Object.defineProperties(wheel, { clientX: { value: 10 + 320 }, clientY: { value: 20 + 225 } });
    surface().dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true); // the chat behind must not scroll
    expect(ws().messages).toEqual([{ type: "wheel", x: 640, y: 450, dx: 0, dy: 48 }]);
  });

  it("sends non-text keys as key down and up, and the typed characters as text", async () => {
    await takeoverReady();
    fireEvent.keyDown(keys(), { key: "Enter", code: "Enter" });
    fireEvent.keyUp(keys(), { key: "Enter", code: "Enter" });
    fireEvent.keyDown(keys(), { key: "ArrowLeft", code: "ArrowLeft", shiftKey: true });
    fireEvent.keyUp(keys(), { key: "ArrowLeft", code: "ArrowLeft" });
    // a printable key is not a key message; its character arrives as input
    fireEvent.keyDown(keys(), { key: "h", code: "KeyH" });
    keys().value = "h";
    fireEvent.input(keys());
    fireEvent.keyUp(keys(), { key: "h", code: "KeyH" });
    expect(ws().messages).toEqual([
      { type: "key", action: "down", key: "Enter", code: "Enter", modifiers: 0, text: "\r" },
      { type: "key", action: "up", key: "Enter", code: "Enter", modifiers: 0 },
      { type: "key", action: "down", key: "ArrowLeft", code: "ArrowLeft", modifiers: 8 },
      { type: "key", action: "up", key: "ArrowLeft", code: "ArrowLeft", modifiers: 0 }, // Shift was let go first
      { type: "text", text: "h" },
    ]);
    expect(keys().value).toBe("");
  });

  it("sends an IME result once, at compositionend (Chinese), and nothing while composing", async () => {
    await takeoverReady();
    fireEvent.compositionStart(keys());
    fireEvent.keyDown(keys(), { key: "Process", code: "KeyN", keyCode: 229 });
    keys().value = "ni";
    fireEvent.input(keys());
    keys().value = "你";
    fireEvent.input(keys());
    expect(ws().messages).toEqual([]);
    const end = new Event("compositionend", { bubbles: true });
    Object.assign(end, { data: "你好" });
    keys().dispatchEvent(end);
    expect(ws().messages).toEqual([{ type: "text", text: "你好" }]);
    expect(keys().value).toBe("");
    // the Enter that confirmed the candidate was composing, so it was not sent as a key either
  });

  it("sends a paste as one text message and keeps the field empty", async () => {
    await takeoverReady();
    fireEvent.paste(keys(), { clipboardData: { getData: (t: string) => (t === "text/plain" ? "pasted 平凡人" : "") } });
    expect(ws().messages).toEqual([{ type: "text", text: "pasted 平凡人" }]);
    fireEvent.keyDown(keys(), { key: "v", code: "KeyV", ctrlKey: true }); // the shortcut itself is left to the paste event
    expect(ws().messages).toHaveLength(1);
  });

  it("sends shortcuts as keys with the modifier", async () => {
    await takeoverReady();
    fireEvent.keyDown(keys(), { key: "a", code: "KeyA", ctrlKey: true });
    expect(ws().messages).toEqual([{ type: "key", action: "down", key: "a", code: "KeyA", modifiers: 2 }]);
  });

  it("releases held keys when the key field loses focus", async () => {
    await takeoverReady();
    fireEvent.keyDown(keys(), { key: "Shift", code: "ShiftLeft", shiftKey: true });
    fireEvent.keyDown(keys(), { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.blur(keys());
    expect(ws().messages.at(-1)).toEqual({
      type: "key",
      action: "up",
      key: "ArrowDown",
      code: "ArrowDown",
      modifiers: 0,
    });
  });

  it("the Keyboard button focuses the key field and toggles it off", async () => {
    await takeoverReady();
    keys().blur();
    fireEvent.focusOut(keys()); // happy-dom's blur() does not emit the focusout React listens to
    const btn = screen.getByRole("button", { name: "Keyboard" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(document.activeElement).toBe(keys());
    await waitFor(() => expect(btn.getAttribute("aria-pressed")).toBe("true"));
    fireEvent.click(btn);
    expect(document.activeElement).not.toBe(keys());
  });

  it("treats Backspace and Return from a phone keyboard (beforeinput only) as keys", async () => {
    await takeoverReady();
    const before = (inputType: string) => {
      const ev = new Event("beforeinput", { cancelable: true, bubbles: true }) as Event & { inputType: string };
      ev.inputType = inputType;
      keys().dispatchEvent(ev);
    };
    before("deleteContentBackward");
    before("insertLineBreak");
    expect(ws().messages.map((m) => (m as { key?: string }).key ?? m.type)).toEqual([
      "Backspace",
      "Backspace",
      "Enter",
      "Enter",
    ]);
  });

  it("sends navigation: back, forward, reload, and an address (normalised, http(s) only)", async () => {
    await takeoverReady();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    const address = screen.getByLabelText("Address") as HTMLInputElement;
    expect(address.value).toBe("https://bank.example.com/login");
    fireEvent.focus(address);
    fireEvent.change(address, { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(address.closest("form")!);
    expect(screen.getByRole("alert").textContent).toMatch(/web address/);
    fireEvent.change(address, { target: { value: "example.com/a" } });
    fireEvent.submit(address.closest("form")!);
    expect(ws().messages).toEqual([
      { type: "nav", action: "back" },
      { type: "nav", action: "forward" },
      { type: "nav", action: "reload" },
      { type: "goto", url: "https://example.com/a" },
    ]);
  });

  it("keeps the address in step with the page unless you are typing in it", async () => {
    await takeoverReady();
    const address = screen.getByLabelText("Address") as HTMLInputElement;
    act(() => ws().serverSend({ type: "page", url: "https://next.example.com/", title: "Next" }));
    expect(address.value).toBe("https://next.example.com/");
    fireEvent.focus(address);
    fireEvent.change(address, { target: { value: "typing" } });
    act(() => ws().serverSend({ type: "page", url: "https://later.example.com/", title: "Later" }));
    expect(address.value).toBe("typing");
  });
});

describe("browser panel: native page UI", () => {
  const takeoverReady = async () => {
    setup(activeSession());
    await connect(true);
  };
  const options = [
    { label: "Hong Kong", value: "hk", selected: true },
    { label: "Japan", value: "jp", selected: false },
    { label: "France", value: "fr", selected: false },
  ];

  it("shows a picker for a focused <select> and answers with the chosen value", async () => {
    await takeoverReady();
    act(() => ws().serverSend({ type: "select", options, multiple: false }));
    const dialog = screen.getByRole("dialog", { name: "Choose one" });
    expect((within(dialog).getByRole("radio", { name: "Hong Kong" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Japan" }));
    expect(ws().messages).toEqual([{ type: "select", values: ["jp"] }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lets several be chosen and sends them on Done; Cancel sends nothing", async () => {
    await takeoverReady();
    act(() => ws().serverSend({ type: "select", options, multiple: true }));
    fireEvent.click(screen.getByRole("checkbox", { name: "France" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hong Kong" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Done" }));
    expect(ws().messages).toEqual([{ type: "select", values: ["fr"] }]);

    act(() => ws().serverSend({ type: "select", options, multiple: false }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ws().messages).toHaveLength(1);
  });

  it.each([
    ["alert", "The page says", ["OK"]],
    ["confirm", "The page asks", ["Cancel", "OK"]],
  ] as const)("answers a %s dialog", async (kind, heading, buttons) => {
    await takeoverReady();
    act(() => ws().serverSend({ type: "dialog", kind, message: "Delete it?", defaultPrompt: null }));
    const dialog = screen.getByRole("alertdialog", { name: heading });
    expect(dialog.textContent).toContain("Delete it?");
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: kind === "alert" ? "OK" : "Cancel" }),
    );
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(buttons);
    fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
    expect(ws().messages).toEqual([{ type: "dialog", accept: true }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("declines a confirm with Cancel", async () => {
    await takeoverReady();
    act(() => ws().serverSend({ type: "dialog", kind: "confirm", message: "Sure?", defaultPrompt: null }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(ws().messages).toEqual([{ type: "dialog", accept: false }]);
  });

  it("answers a prompt with the typed text, starting from the page's default", async () => {
    await takeoverReady();
    act(() => ws().serverSend({ type: "dialog", kind: "prompt", message: "Your name?", defaultPrompt: "Ana" }));
    const input = screen.getByLabelText("Your answer") as HTMLInputElement;
    expect(input.value).toBe("Ana");
    fireEvent.change(input, { target: { value: "平凡人" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(ws().messages).toEqual([{ type: "dialog", accept: true, text: "平凡人" }]);
  });

  it("asks before leaving a page (beforeunload)", async () => {
    await takeoverReady();
    act(() => ws().serverSend({ type: "dialog", kind: "beforeunload", message: "", defaultPrompt: null }));
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(ws().messages).toEqual([{ type: "dialog", accept: false }]);
  });

  it("an Escape in a dialog answers it and does not close the panel", async () => {
    const { onClose } = setup(activeSession());
    await connect(true);
    act(() => ws().serverSend({ type: "dialog", kind: "confirm", message: "Sure?", defaultPrompt: null }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(ws().messages).toEqual([{ type: "dialog", accept: false }]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not show a picker or dialog when you are not in control", async () => {
    setup();
    await connect(false);
    act(() => ws().serverSend({ type: "select", options, multiple: false }));
    act(() => ws().serverSend({ type: "dialog", kind: "alert", message: "x", defaultPrompt: null }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("browser panel: layouts", () => {
  function setupLayout(
    layout: "side" | "focus" | "sheet",
    s: Session = withBrowser(),
    startTakeover = vi
      .fn()
      .mockResolvedValue({ takeover: takeover({ status: "active", requestedBy: "user", reason: null }) }),
  ) {
    const onToggleExpand = vi.fn();
    const api = { startTakeover, endTakeover: vi.fn() };
    render(
      <BrowserPanel
        id="bp"
        api={api as unknown as Api}
        session={s}
        startSignal={0}
        onClose={() => {}}
        layout={layout}
        onToggleExpand={onToggleExpand}
      />,
    );
    return { onToggleExpand, startTakeover };
  }

  it("side: an Expand button; focus: Show chat; the sheet has neither", () => {
    const side = setupLayout("side");
    expect(document.querySelector(".browser-panel")?.classList.contains("side")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand browser" }));
    expect(side.onToggleExpand).toHaveBeenCalled();
    cleanup();
    const focus = setupLayout("focus");
    expect(screen.queryByRole("button", { name: "Expand browser" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show chat" }));
    expect(focus.onToggleExpand).toHaveBeenCalled();
    cleanup();
    setupLayout("sheet");
    expect(screen.queryByRole("button", { name: "Expand browser" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show chat" })).toBeNull();
  });

  it("focus: Take over sits in the header (once), and the picture's aspect ratio drives its fitted size", async () => {
    const { startTakeover } = setupLayout("focus");
    await connect(false);
    const take = screen.getAllByRole("button", { name: "Take over" });
    expect(take).toHaveLength(1);
    expect(take[0]!.closest(".panel-head")).not.toBeNull();
    expect((document.querySelector(".live-stage") as HTMLElement).style.getPropertyValue("--ar")).toBe(
      String(1280 / 900),
    );
    act(() => ws().serverSend({ type: "viewport", width: 800, height: 600 }));
    expect((document.querySelector(".live-stage") as HTMLElement).style.getPropertyValue("--ar")).toBe(
      String(800 / 600),
    );
    fireEvent.click(take[0]!);
    await waitFor(() => expect(startTakeover).toHaveBeenCalledWith("s1"));
  });

  it("focus, in control: nav, address and Done stay available, and pointer input maps at the larger scale", async () => {
    setupLayout("focus", activeSession());
    await connect(true);
    expect(screen.getByLabelText("Address")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show chat" })).toBeTruthy();
    // the picture fitted to 1600 x 1125 on screen (1.25x the 1280 x 900 window), starting at (100, 50)
    surface().getBoundingClientRect = () =>
      ({
        left: 100,
        top: 50,
        width: 1600,
        height: 1125,
        right: 1700,
        bottom: 1175,
        x: 100,
        y: 50,
        toJSON() {},
      }) as DOMRect;
    fireEvent.pointerDown(surface(), {
      clientX: 100 + 800,
      clientY: 50 + 562.5,
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    const down = ws().messages.find(mouse) as { x: number; y: number } | undefined;
    expect(down).toMatchObject({ x: 640, y: 450 });
  });
});
