// Tells the server whether this device is in use, so it does not notify you about what you are looking at. A visible
// window you have not touched for a while does not count: the server holds notifications only while a device is both
// visible and recently used.

import type { DevicePresenceRequest } from "@rei/protocol";

/** Input after this long without any counts as coming back, and is reported at once instead of on the next beat. */
const RETURN_AFTER_MS = 60_000;
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * Posts presence now, whenever the page's visibility changes, every `intervalMs` while it is visible, and at once when
 * you touch the page after a quiet spell. Each report carries how long ago you last touched it. Returns the stop function.
 */
export function startPresence(
  post: (report: DevicePresenceRequest) => Promise<unknown>,
  intervalMs = 30_000,
  doc: Document = document,
  now: () => number = Date.now,
): () => void {
  let lastInput = now();
  const send = () => {
    const visible = doc.visibilityState === "visible";
    try {
      void post(visible ? { visible, idleMs: Math.max(0, now() - lastInput) } : { visible }).catch(() => undefined);
    } catch {
      // presence is best effort
    }
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  const sync = () => {
    // Bringing the window forward is itself a touch.
    if (doc.visibilityState === "visible") lastInput = now();
    send();
    if (timer !== undefined) clearInterval(timer);
    timer = doc.visibilityState === "visible" ? setInterval(send, intervalMs) : undefined;
  };
  const touched = () => {
    const quiet = now() - lastInput;
    lastInput = now();
    if (quiet >= RETURN_AFTER_MS && doc.visibilityState === "visible") send();
  };
  doc.addEventListener("visibilitychange", sync);
  for (const name of INPUT_EVENTS) doc.addEventListener(name, touched, { passive: true, capture: true });
  sync();
  return () => {
    doc.removeEventListener("visibilitychange", sync);
    for (const name of INPUT_EVENTS) doc.removeEventListener(name, touched, { capture: true });
    if (timer !== undefined) clearInterval(timer);
  };
}
