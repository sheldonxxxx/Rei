import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";

// Appearance is one choice, kept on this device: mode is Auto (follow the system), Light or Dark.
// It lands on <html> as data-mode and data-scheme (the resolved light or dark), which the stylesheets key on.
// public/theme-init.js does the same before first paint; keep the keys and the rules in step with it.

export const MODE_KEY = "rei:mode";

export type Mode = "auto" | "light" | "dark";
export type Scheme = "light" | "dark";

export const MODES: { id: Mode; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** The colour of the page, for the theme-color meta (browser and installed-app title bar). Matches --background. */
const CHROME: Record<Scheme, string> = { light: "#f7f5f1", dark: "#1c1a19" };

export const parseMode = (v: unknown): Mode => (v === "light" || v === "dark" ? v : "auto");

export const resolveScheme = (mode: Mode, systemDark: boolean): Scheme =>
  mode === "auto" ? (systemDark ? "dark" : "light") : mode;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered; the choice still applies until the page closes
  }
}

const DARK_QUERY = "(prefers-color-scheme: dark)";
const systemPrefersDark = () => typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;

export interface ThemeState {
  mode: Mode;
  /** What the mode comes to right now: Auto follows the system. */
  scheme: Scheme;
  setMode: (mode: Mode) => void;
}

export const ThemeContext = createContext<ThemeState>({ mode: "auto", scheme: "light", setMode: () => {} });
export const useTheme = () => useContext(ThemeContext);

/** Keeps <html> in step with the chosen mode, follows the system while the mode is Auto, and syncs other tabs. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(() => parseMode(read(MODE_KEY)));
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => setSystemDark(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === MODE_KEY) setModeState(parseMode(e.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const scheme = resolveScheme(mode, systemDark);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.mode = mode;
    root.dataset.scheme = scheme;
    // One theme-color for the browser and the installed app's title bar, in the colour of the page it sits above.
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((m, i) => (i === 0 ? m.setAttribute("content", CHROME[scheme]) : m.remove()));
  }, [mode, scheme]);

  const setMode = useCallback((next: Mode) => {
    setModeState(next);
    write(MODE_KEY, next);
  }, []);

  const value = useMemo(() => ({ mode, scheme, setMode }), [mode, scheme, setMode]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
