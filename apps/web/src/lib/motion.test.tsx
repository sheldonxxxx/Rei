import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enterIndex, MotionRegion, prefersReducedMotion, useArrival, useRegionLive } from "./motion.tsx";

/** Run the two frames the region waits for, so the flip lands inside act(). */
async function paintFrames() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))));
  });
}

/** A stand-in row: what a message, a tool row or a memory chip does with the hook. */
function Row({ kind = "rise" as const }: { kind?: "rise" | "fade" | "card" }) {
  return <li data-enter={useArrival(kind)}>row</li>;
}

describe("useRegionLive", () => {
  it("closes its first frames, then opens", async () => {
    const { result } = renderHook(() => useRegionLive("chat:one:ready"));
    expect(result.current).toBe(false);
    await paintFrames();
    expect(result.current).toBe(true);
  });

  it("stays shut while the region's own data is still landing", async () => {
    const { result, rerender } = renderHook(({ hold }: { hold: boolean }) => useRegionLive("chat:one", hold), {
      initialProps: { hold: true },
    });
    await paintFrames();
    expect(result.current).toBe(false); // a load that takes longer than two frames still does not animate
    rerender({ hold: false });
    await paintFrames();
    expect(result.current).toBe(true);
  });

  it("closes again when the region becomes a different region", async () => {
    const { result, rerender } = renderHook(({ key }: { key: string }) => useRegionLive(key), {
      initialProps: { key: "chat:one:opening" },
    });
    await paintFrames();
    expect(result.current).toBe(true);
    rerender({ key: "chat:two:opening" });
    expect(result.current).toBe(false);
    await paintFrames();
    expect(result.current).toBe(true);
  });
});

describe("useArrival", () => {
  it("decides at mount, so a region opening later cannot start an animation late", async () => {
    const { container, rerender } = render(
      <MotionRegion live={false}>
        <ul>
          <Row />
        </ul>
      </MotionRegion>,
    );
    const row = () => container.querySelector("li");
    expect(row()?.getAttribute("data-enter")).toBeNull(); // loaded history: present, not arriving
    rerender(
      <MotionRegion live={true}>
        <ul>
          <Row />
        </ul>
      </MotionRegion>,
    );
    expect(row()?.getAttribute("data-enter")).toBeNull(); // still no animation, not one two frames late
  });

  it("animates rows that mount while the region is open, and outside any region", async () => {
    const { container, rerender } = render(
      <MotionRegion live={true}>
        <ul>
          <Row kind="card" />
        </ul>
      </MotionRegion>,
    );
    expect(container.querySelector("li")?.getAttribute("data-enter")).toBe("card");
    rerender(
      <ul>
        <Row kind="fade" />
      </ul>,
    );
    expect(container.querySelector("li")?.getAttribute("data-enter")).toBe("fade");
  });
});

describe("enterIndex", () => {
  it("hands the stagger index to CSS rather than choosing a delay in JS", () => {
    expect(enterIndex(3)).toEqual({ "--enter-i": 3 });
  });
});

describe("prefersReducedMotion", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([true, false])("honors the device's reduced-motion preference: %s", (matches) => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && matches,
    }));
    expect(prefersReducedMotion()).toBe(matches);
  });

  it("uses ordinary motion when the browser has no preference API", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("motion grammar wiring", () => {
  it("gives an arriving answer the rise treatment", async () => {
    const { MessageItem } = await import("../components/MessageItem.tsx");
    const { message } = await import("../test/fixtures.ts");
    const { container } = render(
      <ul>
        <MessageItem message={message({ role: "assistant", text: "Here." })} />
      </ul>,
    );
    expect(container.querySelector(".msg-assistant")?.getAttribute("data-enter")).toBe("rise");
  });

  it("leaves your own message alone: you just typed it", async () => {
    const { MessageItem } = await import("../components/MessageItem.tsx");
    const { message } = await import("../test/fixtures.ts");
    const { container } = render(
      <ul>
        <MessageItem message={message({ role: "user", text: "Hello" })} />
      </ul>,
    );
    expect(container.querySelector(".msg-user")?.getAttribute("data-enter")).toBeNull();
  });

  it("staggers the rows of one run with capped CSS delays", async () => {
    const { ToolActivity } = await import("../components/ToolActivity.tsx");
    const { runTrace, step, toolStep } = await import("../test/fixtures.ts");
    const trace = runTrace({ steps: [step(), toolStep({ activity: "Compare hotel prices" })] });
    const { container } = render(<ToolActivity trace={trace} onOpen={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^Worked/ })); // a finished run folds its rows away
    const rows = [...container.querySelectorAll<HTMLElement>(".activity-list > li")];
    expect(rows.map((row) => row.dataset.enter)).toEqual(["fade", "fade"]);
    expect(rows.map((row) => row.style.getPropertyValue("--enter-i"))).toEqual(["0", "1"]);
  });
});
