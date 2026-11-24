import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODE_KEY, parseMode, resolveScheme, ThemeProvider, useTheme } from "./theme.tsx";

function Probe() {
  const { mode, scheme, setMode } = useTheme();
  return (
    <div>
      <output data-testid="state">{`${mode}/${scheme}`}</output>
      <button onClick={() => setMode("dark")}>dark</button>
      <button onClick={() => setMode("light")}>light</button>
      <button onClick={() => setMode("auto")}>auto</button>
    </div>
  );
}

/** A matchMedia whose prefers-color-scheme answer can change, with the listeners the provider adds. */
function systemScheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (q: string) => ({
    get matches() {
      return q.includes("prefers-color-scheme: dark") ? dark : false;
    },
    media: q,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  }));
  return (next: boolean) => {
    dark = next;
    act(() => listeners.forEach((l) => l()));
  };
}

const html = () => document.documentElement.dataset;
const state = () => screen.getByTestId("state").textContent;

beforeEach(() => {
  delete html().mode;
  delete html().scheme;
  document.head.innerHTML =
    '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">';
});
afterEach(() => vi.unstubAllGlobals());

describe("theme helpers", () => {
  it("fall back to Auto for anything unknown", () => {
    expect(parseMode("dark")).toBe("dark");
    expect(parseMode("light")).toBe("light");
    expect(parseMode("sepia")).toBe("auto");
    expect(parseMode(null)).toBe("auto");
  });

  it("resolve Auto from the system and keep an explicit mode", () => {
    expect(resolveScheme("auto", true)).toBe("dark");
    expect(resolveScheme("auto", false)).toBe("light");
    expect(resolveScheme("light", true)).toBe("light");
    expect(resolveScheme("dark", false)).toBe("dark");
  });
});

describe("ThemeProvider", () => {
  it("starts on Auto and puts the choice on <html>", () => {
    systemScheme(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(state()).toBe("auto/light");
    expect({ ...html() }).toMatchObject({ mode: "auto", scheme: "light" });
    expect(html().theme).toBeUndefined();
  });

  it("follows the system while on Auto, and stops following once a mode is chosen", () => {
    const setSystem = systemScheme(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    setSystem(true);
    expect(state()).toBe("auto/dark");
    expect(html().scheme).toBe("dark");
    fireEvent.click(screen.getByText("light"));
    expect(state()).toBe("light/light");
    setSystem(false);
    setSystem(true);
    expect(html().scheme).toBe("light");
    fireEvent.click(screen.getByText("auto"));
    expect(html().scheme).toBe("dark");
  });

  it("remembers the mode on this device and reads them back", () => {
    systemScheme(false);
    const first = render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByText("dark"));
    expect(localStorage.getItem(MODE_KEY)).toBe("dark");
    first.unmount();
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(state()).toBe("dark/dark");
  });

  it("keeps a single theme-color, in the colour of the chosen mode", () => {
    systemScheme(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    const metas = () =>
      [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute("content"));
    expect(metas()).toEqual(["#f7f5f1"]);
    fireEvent.click(screen.getByText("dark"));
    expect(metas()).toEqual(["#1c1a19"]);
  });

  it("follows a change made in another tab", () => {
    systemScheme(false);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: MODE_KEY, newValue: "dark" }));
    });
    expect(state()).toBe("dark/dark");
  });

  it("works when storage is blocked: the choice applies for now and nothing throws", () => {
    systemScheme(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(state()).toBe("auto/light");
    fireEvent.click(screen.getByText("dark"));
    expect(state()).toBe("dark/dark");
    vi.restoreAllMocks();
  });
});
