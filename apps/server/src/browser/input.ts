// The PWA's input messages as DevTools Input.dispatch* parameters (takeover). Portable and pure but for the held
// buttons, which it tracks per window: a hover is a mouseMoved with no button unless one is down, so a drag works and a
// plain move never looks like a held click.
import type { LiveClientMessage, MouseButton } from "@rei/protocol";

export interface MouseParams {
  type: "mousePressed" | "mouseReleased" | "mouseMoved";
  x: number;
  y: number;
  button: MouseButton | "none";
  /** Bitmask of the buttons held: 1 left, 2 right, 4 middle. */
  buttons: number;
  clickCount: number;
  modifiers: number;
}
export interface WheelParams {
  type: "mouseWheel";
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  button: "none";
  buttons: number;
  modifiers: number;
}
export interface KeyParams {
  type: "keyDown" | "rawKeyDown" | "keyUp";
  modifiers: number;
  key: string;
  code: string;
  text?: string;
  unmodifiedText?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  commands?: string[];
}

const BUTTON_BIT: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

/** Windows virtual-key codes: Chromium ignores a key event without one for these keys. */
const VK: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
};
const PUNCTUATION: Record<string, number> = {
  ";": 186,
  "=": 187,
  ",": 188,
  "-": 189,
  ".": 190,
  "/": 191,
  "`": 192,
  "[": 219,
  "\\": 220,
  "]": 221,
  "'": 222,
};

export function virtualKeyCode(key: string, code: string): number | undefined {
  const named = VK[key];
  if (named !== undefined) return named;
  if (/^F([1-9]|1[0-2])$/.test(key)) return 111 + Number(key.slice(1));
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (/^[A-Z0-9]$/.test(upper)) return upper.charCodeAt(0);
    if (PUNCTUATION[key] !== undefined) return PUNCTUATION[key];
  }
  // A key whose `key` is localized or composed: the physical key still says which one it is.
  const m = /^Key([A-Z])$/.exec(code) ?? /^Digit([0-9])$/.exec(code);
  return m ? m[1]!.charCodeAt(0) : undefined;
}

/** Editing shortcuts Chromium only runs when the event names the command (CDP events do not go through the OS keymap). */
const COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo", y: "redo" };

export class InputMapper {
  #buttons = 0;

  /** The held buttons, for tests. */
  get buttons(): number {
    return this.#buttons;
  }

  mouse(m: Extract<LiveClientMessage, { type: "mouse" }>, modifiers = 0): MouseParams {
    const bit = BUTTON_BIT[m.button] ?? 0;
    if (m.action === "down") {
      this.#buttons |= bit;
      return {
        type: "mousePressed",
        x: m.x,
        y: m.y,
        button: m.button,
        buttons: this.#buttons,
        clickCount: Math.max(1, m.clickCount | 0),
        modifiers,
      };
    }
    if (m.action === "up") {
      this.#buttons &= ~bit;
      return {
        type: "mouseReleased",
        x: m.x,
        y: m.y,
        button: m.button,
        buttons: this.#buttons,
        clickCount: Math.max(1, m.clickCount | 0),
        modifiers,
      };
    }
    // A move: the held buttons decide the button, whatever the message said (a hover arrives as button "left", count 0).
    const held = this.#buttons & 1 ? "left" : this.#buttons & 4 ? "middle" : this.#buttons & 2 ? "right" : "none";
    return { type: "mouseMoved", x: m.x, y: m.y, button: held, buttons: this.#buttons, clickCount: 0, modifiers };
  }

  wheel(m: Extract<LiveClientMessage, { type: "wheel" }>): WheelParams {
    return {
      type: "mouseWheel",
      x: m.x,
      y: m.y,
      deltaX: m.dx,
      deltaY: m.dy,
      button: "none",
      buttons: this.#buttons,
      modifiers: 0,
    };
  }

  key(m: Extract<LiveClientMessage, { type: "key" }>): KeyParams {
    const vk = virtualKeyCode(m.key, m.code);
    const base: KeyParams = {
      type: m.action === "up" ? "keyUp" : m.text ? "keyDown" : "rawKeyDown",
      modifiers: m.modifiers,
      key: m.key,
      code: m.code,
      ...(vk !== undefined ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}),
    };
    if (m.action === "down" && m.text) {
      base.text = m.text;
      base.unmodifiedText = m.text;
    }
    const command = m.action === "down" && m.key.length === 1 ? COMMANDS[m.key.toLowerCase()] : undefined;
    // Ctrl or Meta with the letter, and no Alt.
    if (command && m.modifiers & (2 | 4) && !(m.modifiers & 1)) base.commands = [command];
    return base;
  }
}
