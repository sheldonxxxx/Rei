import type { LiveClientMessage } from "@rei/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyLike, PointerLike } from "./browserInput.ts";
import { modifiersOf, PointerMapper, planKeyDown, toPagePoint } from "./browserInput.ts";

const viewport = { width: 1280, height: 900 };

describe("toPagePoint", () => {
  it("scales the picture box back to page pixels", () => {
    const box = { left: 100, top: 50, width: 640, height: 450 }; // half size
    expect(toPagePoint(100, 50, box, viewport)).toEqual({ x: 0, y: 0 });
    expect(toPagePoint(420, 275, box, viewport)).toEqual({ x: 640, y: 450 });
    expect(toPagePoint(739, 499, box, viewport)).toEqual({ x: 1278, y: 898 });
  });
  it("clamps a point outside the picture (a drag that leaves it)", () => {
    const box = { left: 0, top: 0, width: 640, height: 450 };
    expect(toPagePoint(-20, -5, box, viewport)).toEqual({ x: 0, y: 0 });
    expect(toPagePoint(9999, 9999, box, viewport)).toEqual({ x: 1279, y: 899 });
  });
  it("is harmless before layout", () => {
    expect(toPagePoint(10, 10, { left: 0, top: 0, width: 0, height: 0 }, viewport)).toEqual({ x: 0, y: 0 });
  });
});

const key = (over: Partial<KeyLike>): KeyLike => ({
  key: "a",
  code: "KeyA",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...over,
});

describe("planKeyDown", () => {
  it("leaves printable characters to the text field (so layout and IME decide)", () => {
    expect(planKeyDown(key({ key: "a" })).kind).toBe("text");
    expect(planKeyDown(key({ key: "A", shiftKey: true })).kind).toBe("text");
    expect(planKeyDown(key({ key: "你" })).kind).toBe("text");
    expect(planKeyDown(key({ key: "@", ctrlKey: true, altKey: true })).kind).toBe("text"); // AltGr
  });
  it("sends non-text keys as key messages with modifiers", () => {
    const p = planKeyDown(key({ key: "ArrowDown", code: "ArrowDown", shiftKey: true }));
    expect(p).toEqual({
      kind: "key",
      down: { type: "key", action: "down", key: "ArrowDown", code: "ArrowDown", modifiers: 8 },
    });
    expect(planKeyDown(key({ key: "Backspace", code: "Backspace" })).kind).toBe("key");
    expect(planKeyDown(key({ key: "Tab", code: "Tab" })).kind).toBe("key");
    expect(planKeyDown(key({ key: "Escape", code: "Escape" })).kind).toBe("key");
  });
  it("gives Enter and Space their text so they type, submit and click", () => {
    expect(planKeyDown(key({ key: "Enter", code: "Enter" }))).toMatchObject({ kind: "key", down: { text: "\r" } });
    expect(planKeyDown(key({ key: " ", code: "Space" }))).toMatchObject({ kind: "key", down: { text: " " } });
  });
  it("sends Ctrl and Cmd shortcuts as keys without text, but lets paste through", () => {
    const p = planKeyDown(key({ key: "a", ctrlKey: true }));
    expect(p).toEqual({ kind: "key", down: { type: "key", action: "down", key: "a", code: "KeyA", modifiers: 2 } });
    expect(planKeyDown(key({ key: "c", metaKey: true }))).toMatchObject({ kind: "key", down: { modifiers: 4 } });
    expect(planKeyDown(key({ key: "v", ctrlKey: true })).kind).toBe("ignore");
    expect(planKeyDown(key({ key: "V", metaKey: true, shiftKey: true })).kind).toBe("ignore");
  });
  it("ignores keys while an IME composes, and lone modifier keys", () => {
    expect(planKeyDown(key({ key: "Process", keyCode: 229 })).kind).toBe("text");
    expect(planKeyDown(key({ key: "Enter", isComposing: true })).kind).toBe("text"); // the Enter that confirms a candidate
    expect(planKeyDown(key({ key: "n", keyCode: 229 })).kind).toBe("text");
    expect(planKeyDown(key({ key: "Shift", code: "ShiftLeft" })).kind).toBe("ignore");
  });
  it("computes modifier bits", () => {
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(modifiersOf({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(0);
  });
});

describe("PointerMapper", () => {
  let sent: LiveClientMessage[];
  let clock: number;
  let box: { left: number; top: number; width: number; height: number };
  let mapper: PointerMapper;
  const ptr = (over: Partial<PointerLike>): PointerLike => ({
    pointerId: 1,
    pointerType: "mouse",
    clientX: 0,
    clientY: 0,
    button: 0,
    ...over,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    clock = 1000;
    box = { left: 0, top: 0, width: 640, height: 450 }; // the page drawn at half size
    mapper = new PointerMapper(
      (m) => sent.push(m),
      () => ({ box, viewport }),
      () => clock,
    );
  });
  afterEach(() => {
    mapper.dispose();
    vi.useRealTimers();
  });

  it("maps a mouse press and release to page pixels with the button", () => {
    mapper.down(ptr({ clientX: 100, clientY: 50 }));
    mapper.up(ptr({ clientX: 100, clientY: 50 }));
    mapper.down(ptr({ clientX: 10, clientY: 10, button: 2 }));
    expect(sent).toEqual([
      { type: "mouse", action: "down", x: 200, y: 100, button: "left", clickCount: 1 },
      { type: "mouse", action: "up", x: 200, y: 100, button: "left", clickCount: 1 },
      { type: "mouse", action: "down", x: 20, y: 20, button: "right", clickCount: 1 },
    ]);
  });

  it("counts double and triple clicks by timing and distance", () => {
    const click = () => {
      mapper.down(ptr({ clientX: 100, clientY: 100 }));
      mapper.up(ptr({ clientX: 100, clientY: 100 }));
    };
    click();
    clock += 200;
    click();
    clock += 200;
    click();
    clock += 2000;
    click();
    const counts = sent
      .filter((m) => m.type === "mouse" && m.action === "down")
      .map((m) => (m as { clickCount: number }).clickCount);
    expect(counts).toEqual([1, 2, 3, 1]);
  });

  it("throttles moves but sends the last position when the pointer stops", () => {
    mapper.move(ptr({ clientX: 10, clientY: 10 })); // sent now
    clock += 5;
    mapper.move(ptr({ clientX: 20, clientY: 20 }));
    clock += 5;
    mapper.move(ptr({ clientX: 30, clientY: 30 }));
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(40);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ type: "mouse", action: "move", x: 60, y: 60 });
  });

  it("drags with the held button on moves", () => {
    mapper.down(ptr({ clientX: 10, clientY: 10, button: 0 }));
    clock += 100;
    mapper.move(ptr({ clientX: 50, clientY: 10 }));
    expect(sent[1]).toMatchObject({ action: "move", button: "left" });
  });

  it("ignores buttons beyond left, middle and right, and releases a held button on cancel", () => {
    mapper.down(ptr({ button: 3 }));
    expect(sent).toEqual([]);
    mapper.down(ptr({ clientX: 10, clientY: 10 }));
    mapper.cancel(ptr({ clientX: 10, clientY: 10 }));
    expect(sent.map((m) => (m as { action: string }).action)).toEqual(["down", "up"]);
  });

  describe("touch", () => {
    const touch = (id: number, x: number, y: number): PointerLike =>
      ptr({ pointerId: id, pointerType: "touch", clientX: x, clientY: y });

    it("a tap is a press and release at the finger", () => {
      mapper.down(touch(1, 100, 50));
      mapper.up(touch(1, 101, 51));
      expect(sent).toEqual([
        { type: "mouse", action: "down", x: 200, y: 100, button: "left", clickCount: 1 },
        { type: "mouse", action: "up", x: 200, y: 100, button: "left", clickCount: 1 },
      ]);
    });

    it("sends nothing while a finger rests, and a cancelled tap sends nothing", () => {
      mapper.down(touch(1, 100, 50));
      expect(sent).toEqual([]);
      mapper.cancel(touch(1, 100, 50));
      expect(sent).toEqual([]);
    });

    it("a one-finger drag presses where it began, moves, and releases where it ends", () => {
      mapper.down(touch(1, 100, 100));
      mapper.move(touch(1, 140, 100));
      mapper.move(touch(1, 180, 100));
      mapper.up(touch(1, 180, 100));
      expect(sent.map((m) => (m as { action: string }).action)).toEqual(["down", "move", "move", "up"]);
      expect(sent[0]).toMatchObject({ x: 200, y: 200 });
      expect(sent[3]).toMatchObject({ x: 360, y: 200 });
    });

    it("a two-finger drag scrolls with wheel messages and never clicks", () => {
      mapper.down(touch(1, 100, 200));
      mapper.down(touch(2, 200, 200));
      mapper.move(touch(1, 100, 150)); // centroid moved up by 25 screen px => 50 page px
      mapper.move(touch(2, 200, 150)); // and another 25
      mapper.up(touch(1, 100, 150));
      mapper.up(touch(2, 200, 150));
      expect(sent.every((m) => m.type === "wheel")).toBe(true);
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatchObject({ type: "wheel", dx: 0, dy: 50 }); // drag up = page moves up = scroll down
      expect(sent.reduce((n, m) => n + (m as { dy: number }).dy, 0)).toBe(100);
    });

    it("lifting one finger of a scroll does not turn the other into a tap", () => {
      mapper.down(touch(1, 100, 200));
      mapper.down(touch(2, 200, 200));
      mapper.up(touch(1, 100, 200));
      mapper.up(touch(2, 200, 200));
      expect(sent).toEqual([]);
      // and a new tap afterwards works again
      mapper.down(touch(3, 10, 10));
      mapper.up(touch(3, 10, 10));
      expect(sent).toHaveLength(2);
    });
  });
});
