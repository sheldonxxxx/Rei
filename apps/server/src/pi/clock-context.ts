import { defineExtension, section } from "@earendil-works/pi-durable";
import type { AppStore } from "../store/store.ts";
import { knownTimeZone, localDay } from "../util/time.ts";

const KEY = "user_time_zone";

/** The user's saved time zone (Settings > General), or null until the browser has saved one. */
export function savedTimeZone(store: Pick<AppStore, "metaGet">): string | null {
  return knownTimeZone(store.metaGet(KEY)) ?? null;
}

/** Saves the user's time zone. Callers check it with `knownTimeZone` first. */
export function saveTimeZone(store: Pick<AppStore, "metaSet">, timeZone: string): void {
  store.metaSet(KEY, timeZone);
}

/**
 * What the model is told about today. The date is a calendar day, so the prompt changes once a day. Until the user's zone is
 * saved, the date is the server's, and the prompt says so rather than guessing.
 */
export function clockText(ms: number, timeZone: string, userZone: string | null): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(ms);
  const day = localDay(ms, timeZone);
  if (userZone === null)
    return `Today is ${weekday}, ${day} (YYYY-MM-DD), in the server's time zone (${timeZone}). The user's time zone is not set.`;
  return `Today is ${weekday}, ${day} (YYYY-MM-DD). The user's time zone is ${userZone}.`;
}

/** Tells the model today's date and the user's time zone, so it can read "today" and clock times correctly. */
export function createClockExtension(store: Pick<AppStore, "metaGet" | "clock">) {
  return defineExtension({
    name: "clock",
    sections: [
      section("clock", () => {
        const userZone = savedTimeZone(store);
        const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return clockText(store.clock.now(), userZone ?? hostZone, userZone);
      }),
    ],
  });
}
