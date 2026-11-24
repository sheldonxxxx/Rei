import { useCallback, useEffect, useState } from "react";

export const FIRST_TIME_SETUP_SESSION_KEY = "rei:first-time-setup-dismissed-session";

// Per-device UI state (a collapsed sidebar, an expanded browser). localStorage can be missing, full or blocked, so every
// access is guarded and the UI works the same without it.

export function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // not remembered; nothing else depends on it
  }
}

export function readSessionFlag(key: string, fallback: boolean): boolean {
  try {
    const value = sessionStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

export function writeSessionFlag(key: string, value: boolean): void {
  try {
    sessionStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Session UI state is optional; the flow still works without storage.
  }
}

export function clearSessionFlag(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Session UI state is optional; the flow still works without storage.
  }
}

/** A boolean that lives in React state and is remembered on this device. */
export function useStoredFlag(
  key: string,
  fallback = false,
): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState(() => readFlag(key, fallback));
  useEffect(() => {
    if (readFlag(key, fallback) !== value) writeFlag(key, value);
  }, [key, fallback, value]);
  const set = useCallback((next: boolean | ((prev: boolean) => boolean)) => setValue(next), []);
  return [value, set];
}
