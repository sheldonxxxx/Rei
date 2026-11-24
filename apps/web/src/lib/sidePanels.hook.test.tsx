import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useChatPanels } from "./sidePanels.ts";

function viewport(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: wide,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function setup(opts: { wide: boolean; full?: boolean; hasSession?: boolean }) {
  viewport(opts.wide);
  return renderHook((p: { full: boolean }) => useChatPanels({ hasSession: opts.hasSession ?? true, full: p.full }), {
    initialProps: { full: opts.full ?? true },
  });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  document.body.innerHTML = "";
});

describe("useChatPanels", () => {
  for (const wide of [true, false]) {
    it(`walks browser → inspector → sessions with one panel open at a time (${wide ? "wide" : "phone"})`, () => {
      const { result } = setup({ wide });
      act(() => result.current.toggleBrowser());
      expect(result.current.browserOpen).toBe(true);
      expect(result.current.browserLayout).toBe(wide ? "side" : "sheet");
      expect(result.current.focusView).toBe(!wide);
      act(() => result.current.openInspector("run_1", "step_1"));
      expect(result.current.browserOpen).toBe(false);
      expect(result.current.inspect).toMatchObject({ runId: "run_1", stepId: "step_1" });
      act(() => result.current.toggleSessions());
      expect(result.current.inspect).toBeNull();
      expect(result.current.sessionsOpen).toBe(true);
      act(() => result.current.takeOver());
      expect(result.current.sessionsOpen).toBe(false);
      expect(result.current.browserOpen).toBe(true);
      expect(result.current.browserAutoStart).toBe(1);
    });
  }

  it("expanding the browser hides the chat on a wide screen; showChat collapses it, or closes the sheet on a phone", () => {
    const wideView = setup({ wide: true });
    act(() => wideView.result.current.toggleBrowser());
    act(() => wideView.result.current.toggleExpanded());
    expect(wideView.result.current.focusView).toBe(true);
    expect(wideView.result.current.browserLayout).toBe("focus");
    act(() => wideView.result.current.showChat());
    expect(wideView.result.current.focusView).toBe(false);
    expect(wideView.result.current.browserOpen).toBe(true);
    wideView.unmount();

    localStorage.clear();
    const phone = setup({ wide: false });
    act(() => phone.result.current.toggleBrowser());
    expect(phone.result.current.focusView).toBe(true);
    act(() => phone.result.current.showChat());
    expect(phone.result.current.browserOpen).toBe(false);
  });

  it("never shows the browser without a session", () => {
    const { result } = setup({ wide: true, hasSession: false });
    act(() => result.current.toggleBrowser());
    expect(result.current.browserOpen).toBe(false);
    expect(result.current.focusView).toBe(false);
  });

  it("closes the inspector when full mode turns off", () => {
    const { result, rerender } = setup({ wide: true });
    act(() => result.current.openInspector("run_1"));
    expect(result.current.inspect).not.toBeNull();
    rerender({ full: false });
    expect(result.current.inspect).toBeNull();
  });

  it("returns focus to what opened the inspector, to the sessions button, and to the browser button after the render", () => {
    const { result } = setup({ wide: true });
    const opener = document.body.appendChild(document.createElement("button"));
    const sessionsBtn = document.body.appendChild(document.createElement("button"));
    const browserBtn = document.body.appendChild(document.createElement("button"));
    (result.current.sessionsBtn as { current: HTMLButtonElement | null }).current = sessionsBtn;
    (result.current.browserBtn as { current: HTMLButtonElement | null }).current = browserBtn;

    opener.focus();
    act(() => result.current.openInspector("run_1"));
    document.body.focus();
    act(() => result.current.closeInspector());
    expect(document.activeElement).toBe(opener);

    act(() => result.current.toggleSessions());
    act(() => result.current.closeSessions());
    expect(document.activeElement).toBe(sessionsBtn);

    act(() => result.current.toggleBrowser());
    act(() => result.current.closeBrowser());
    expect(document.activeElement).toBe(browserBtn);
  });
});
