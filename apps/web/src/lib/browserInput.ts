// Turns what you do on the live picture into LiveClientMessages. Pure of React so it can be tested without a browser:
// the panel gives it the picture's on-screen box and the page's CSS-pixel viewport, and it calls `send`.
import type { LiveClientMessage, MouseButton } from "@rei/protocol";

export interface Viewport {
  width: number;
  height: number;
}
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A client point on the picture as CSS pixels in the page (what the server's CDP calls expect), clamped to the page. */
export function toPagePoint(clientX: number, clientY: number, box: Box, viewport: Viewport): { x: number; y: number } {
  if (!(box.width > 0 && box.height > 0) || !Number.isFinite(clientX) || !Number.isFinite(clientY))
    return { x: 0, y: 0 };
  const x = ((clientX - box.left) / box.width) * viewport.width;
  const y = ((clientY - box.top) / box.height) * viewport.height;
  return {
    x: Math.min(viewport.width - 1, Math.max(0, Math.round(x))),
    y: Math.min(viewport.height - 1, Math.max(0, Math.round(y))),
  };
}

// ---- keyboard ----------------------------------------------------------------------------------------------------------

/** Modifier bits as the protocol defines them: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
export function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export interface KeyLike {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

const MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Fn",
  "Hyper",
  "Super",
]);
/** Keys that don't tell what they typed (an IME is busy, or a dead key waits for the next one): the text arrives by `input`. */
const INDIRECT_KEYS = new Set(["Process", "Unidentified", "Dead", "Compose"]);

export type KeyPlan =
  /** Let the textarea take it; the typed character arrives as an `input` event and goes out as `text`. */
  | { kind: "text" }
  /** Send these messages and cancel the browser's own handling. */
  | { kind: "key"; down: LiveClientMessage }
  /** Not ours (a lone modifier key, a paste shortcut that must reach the paste event). */
  | { kind: "ignore" };

/**
 * Which keys go as `key` messages and which as `text`:
 * - a printable character, alone or with Shift or AltGr, is text (so the layout and IME decide what was typed);
 * - Space is the exception: it is also a button/checkbox/scroll key on the page, so it goes as a key with its text;
 * - everything else (Enter, Backspace, Tab, arrows, Escape, F-keys) and Ctrl/Meta shortcuts is a key.
 * Ctrl/Cmd+V is left alone so the browser fires `paste` (the clipboard text then goes as `text`).
 */
export function planKeyDown(e: KeyLike): KeyPlan {
  if (e.isComposing || e.keyCode === 229 || INDIRECT_KEYS.has(e.key)) return { kind: "text" };
  if (MODIFIER_KEYS.has(e.key)) return { kind: "ignore" };
  const shortcut = e.metaKey || (e.ctrlKey && !e.altKey); // Ctrl+Alt is AltGr on Windows: that types characters
  if (shortcut && e.key.toLowerCase() === "v") return { kind: "ignore" };
  const printable = [...e.key].length === 1;
  if (printable && !shortcut && e.key !== " ") return { kind: "text" };
  const msg: LiveClientMessage = { type: "key", action: "down", key: e.key, code: e.code, modifiers: modifiersOf(e) };
  // The text makes the key type: a Return key needs "\r" to insert a newline or submit a form.
  if (!shortcut) {
    if (e.key === "Enter") msg.text = "\r";
    else if (e.key === " ") msg.text = " ";
  }
  return { kind: "key", down: msg };
}

/** The release of a key that was sent down; `modifiers` are those held now (Shift may be let go first). */
export function keyUpOf(
  down: Extract<LiveClientMessage, { type: "key" }>,
  modifiers = down.modifiers,
): LiveClientMessage {
  return { type: "key", action: "up", key: down.key, code: down.code, modifiers };
}

// ---- pointer -----------------------------------------------------------------------------------------------------------

export interface PointerLike {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  button: number;
}

export interface Geometry {
  box: Box;
  viewport: Viewport;
}

const BUTTONS: Record<number, MouseButton> = { 0: "left", 1: "middle", 2: "right" };
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_PX = 6;
const MOVE_INTERVAL_MS = 33;
/** A touch that moves less than this (screen px) is still a tap. */
const TAP_SLOP = 10;

interface Touch {
  startX: number;
  startY: number;
  x: number;
  y: number;
}

/**
 * Pointer input to mouse and wheel messages.
 * - mouse/pen: down, up and (throttled) move with the button and a click count (double and triple clicks by timing);
 * - touch: a tap is a down+up at the finger; a one-finger drag is a mouse drag (sliders, text selection); a two-finger drag
 *   scrolls with wheel messages (the picture is scaled down, so the movement is scaled up to page pixels).
 */
export class PointerMapper {
  private touches = new Map<number, Touch>();
  private touchMode: "none" | "tap" | "drag" | "scroll" = "none";
  private held: MouseButton | null = null;
  private lastDown = { at: 0, x: 0, y: 0, button: "left" as MouseButton, count: 0 };
  private lastMoveAt = 0;
  private trailing: ReturnType<typeof setTimeout> | undefined;
  private pendingMove: { x: number; y: number } | null = null;

  private send: (msg: LiveClientMessage) => void;
  private geometry: () => Geometry;
  private now: () => number;

  constructor(
    send: (msg: LiveClientMessage) => void,
    geometry: () => Geometry,
    now: () => number = () => performance.now(),
  ) {
    this.send = send;
    this.geometry = geometry;
    this.now = now;
  }

  private point(clientX: number, clientY: number) {
    const g = this.geometry();
    return toPagePoint(clientX, clientY, g.box, g.viewport);
  }
  /** Page pixels per screen pixel. */
  private scale(): number {
    const g = this.geometry();
    return g.box.width > 0 ? g.viewport.width / g.box.width : 1;
  }

  down(e: PointerLike): void {
    if (e.pointerType === "touch") return this.touchDown(e);
    const button = BUTTONS[e.button];
    if (!button) return;
    this.flushMove();
    const { x, y } = this.point(e.clientX, e.clientY);
    const t = this.now();
    const d = this.lastDown;
    const again =
      d.button === button &&
      t - d.at < MULTI_CLICK_MS &&
      Math.abs(x - d.x) <= MULTI_CLICK_PX &&
      Math.abs(y - d.y) <= MULTI_CLICK_PX;
    const count = again ? d.count + 1 : 1;
    this.lastDown = { at: t, x, y, button, count };
    this.held = button;
    this.send({ type: "mouse", action: "down", x, y, button, clickCount: count });
  }

  move(e: PointerLike): void {
    if (e.pointerType === "touch") return this.touchMove(e);
    const { x, y } = this.point(e.clientX, e.clientY);
    const t = this.now();
    if (t - this.lastMoveAt >= MOVE_INTERVAL_MS) {
      this.lastMoveAt = t;
      this.pendingMove = null;
      this.emitMove(x, y);
      return;
    }
    // Too soon: keep the newest position and send it when the interval is over, so hover ends where the pointer stopped.
    this.pendingMove = { x, y };
    if (this.trailing === undefined) {
      this.trailing = setTimeout(() => {
        this.trailing = undefined;
        this.flushMove();
      }, MOVE_INTERVAL_MS);
    }
  }

  up(e: PointerLike): void {
    if (e.pointerType === "touch") return this.touchUp(e);
    const button = BUTTONS[e.button];
    if (!button) return;
    this.flushMove();
    const { x, y } = this.point(e.clientX, e.clientY);
    this.held = null;
    this.send({
      type: "mouse",
      action: "up",
      x,
      y,
      button,
      clickCount: this.lastDown.button === button ? this.lastDown.count : 1,
    });
  }

  /** The browser took the pointer away (a system gesture, the panel closed). Release whatever is held so nothing stays pressed. */
  cancel(e: PointerLike): void {
    if (e.pointerType === "touch") return this.touchUp(e, true);
    const button = this.held;
    if (!button) return;
    this.held = null;
    const { x, y } = this.point(e.clientX, e.clientY);
    this.send({ type: "mouse", action: "up", x, y, button, clickCount: this.lastDown.count });
  }

  dispose(): void {
    if (this.trailing !== undefined) clearTimeout(this.trailing);
    this.trailing = undefined;
    this.pendingMove = null;
  }

  private emitMove(x: number, y: number) {
    // The protocol has no "no button" value; a move while nothing is held carries "left" and the server treats it as hover.
    this.send({ type: "mouse", action: "move", x, y, button: this.held ?? "left", clickCount: 0 });
  }
  private flushMove() {
    if (this.trailing !== undefined) clearTimeout(this.trailing);
    this.trailing = undefined;
    if (this.pendingMove) {
      const { x, y } = this.pendingMove;
      this.pendingMove = null;
      this.lastMoveAt = this.now();
      this.emitMove(x, y);
    }
  }

  // ---- touch ----

  private centroid(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const t of this.touches.values()) {
      x += t.x;
      y += t.y;
    }
    const n = Math.max(1, this.touches.size);
    return { x: x / n, y: y / n };
  }

  private touchDown(e: PointerLike) {
    this.touches.set(e.pointerId, { startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY });
    if (this.touches.size === 1) {
      this.touchMode = "tap";
      return;
    }
    // A second finger turns the gesture into a scroll. A drag that had started is released first.
    if (this.touchMode === "drag") {
      const first = [...this.touches.entries()].find(([id]) => id !== e.pointerId)?.[1];
      if (first) {
        const { x, y } = this.point(first.x, first.y);
        this.send({ type: "mouse", action: "up", x, y, button: "left", clickCount: 1 });
      }
    }
    this.touchMode = "scroll";
  }

  private touchMove(e: PointerLike) {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    const before = this.centroid();
    t.x = e.clientX;
    t.y = e.clientY;
    if (this.touchMode === "scroll") {
      const after = this.centroid();
      const k = this.scale();
      const { x, y } = this.point(after.x, after.y);
      // Content follows the fingers, so a drag up scrolls the page down.
      const dx = Math.round((before.x - after.x) * k);
      const dy = Math.round((before.y - after.y) * k);
      if (dx !== 0 || dy !== 0) this.send({ type: "wheel", x, y, dx, dy });
      return;
    }
    if (this.touchMode === "tap" && Math.hypot(t.x - t.startX, t.y - t.startY) > TAP_SLOP) {
      this.touchMode = "drag";
      const start = this.point(t.startX, t.startY);
      this.send({ type: "mouse", action: "down", x: start.x, y: start.y, button: "left", clickCount: 1 });
    }
    if (this.touchMode === "drag") {
      const { x, y } = this.point(t.x, t.y);
      this.send({ type: "mouse", action: "move", x, y, button: "left", clickCount: 0 });
    }
  }

  private touchUp(e: PointerLike, cancelled = false) {
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    this.touches.delete(e.pointerId);
    const { x, y } = this.point(e.clientX, e.clientY);
    if (this.touchMode === "tap" && !cancelled) {
      const s = this.point(t.startX, t.startY);
      this.send({ type: "mouse", action: "down", x: s.x, y: s.y, button: "left", clickCount: 1 });
      this.send({ type: "mouse", action: "up", x: s.x, y: s.y, button: "left", clickCount: 1 });
      this.touchMode = "none";
    } else if (this.touchMode === "drag") {
      this.send({ type: "mouse", action: "up", x, y, button: "left", clickCount: 1 });
      this.touchMode = "none";
    }
    if (this.touches.size === 0) this.touchMode = "none"; // scroll mode ends only when every finger is up
  }
}
