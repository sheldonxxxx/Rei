import type { CSSProperties, ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";

/** The four arrival kinds. The kind says what happened; see src/styles/motion.css. */
export type Arrival = "rise" | "fade" | "card" | "scale";

/**
 * Whether a region's arrivals should animate. Outside any region everything animates, because mounting outside a region
 * means the user just caused it; a region that was already on screen when it first painted says no.
 */
const RegionLive = createContext(true);

/**
 * Mark a region whose first paint must not replay. `live` starts false and flips a couple of frames later, so whatever
 * the region rendered first — a chat's loaded history — arrived rather than arrives.
 */
export function MotionRegion({ live, children }: { live: boolean; children: ReactNode }) {
  return <RegionLive.Provider value={live}>{children}</RegionLive.Provider>;
}

/**
 * The `data-enter` value for an element that has just mounted, or undefined if it was already there.
 * Decided once at mount: a later flip of the region cannot start an animation late, which is the whole point.
 */
export function useArrival(kind: Arrival): Arrival | undefined {
  const live = useContext(RegionLive);
  const [animate] = useState(() => live);
  return animate ? kind : undefined;
}

/**
 * A region key that changes whenever the region becomes a different region — another chat, or the moment its first page
 * of history lands. The rows committed with the new key paint under a closed region.
 */
export function useRegionLive(key: unknown, hold = false): boolean {
  const [state, setState] = useState<{ key: unknown; live: boolean }>({ key, live: false });
  // Reset while rendering, so the same commit that mounts the new content already has the region closed.
  if (state.key !== key) setState({ key, live: false });
  const live = state.key === key && state.live;
  useEffect(() => {
    // Held shut until the region's own data is in: whatever arrives with it was already there as far as the user is
    // concerned, and opening on a timer would race an asynchronous load.
    if (live || hold) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setState({ key, live: true }));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [key, live, hold]);
  return live;
}

/** Whether this device asks for less motion. Scroll easing and other JS-driven movement must ask too. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type EnterStyle = CSSProperties & { "--enter-i": number };

/** Where a row sits in its sibling run: the CSS stagger step reads it, capped there rather than here. */
export function enterIndex(index: number): EnterStyle {
  return { "--enter-i": index };
}
