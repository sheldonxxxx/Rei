import { describe, expect, it } from "vitest";
import { fieldRefusal } from "../src/browser/effects.ts";
import { InputMapper, virtualKeyCode } from "../src/browser/input.ts";
import { el } from "./helpers/browser.ts";

// How the PWA's live input becomes DevTools input (the conventions of the finished PWA).
describe("InputMapper", () => {
  it("sends a hover as mouseMoved with no button, and a drag with the held one", () => {
    const m = new InputMapper();
    expect(m.mouse({ type: "mouse", action: "move", x: 5, y: 6, button: "left", clickCount: 0 })).toEqual({
      type: "mouseMoved",
      x: 5,
      y: 6,
      button: "none",
      buttons: 0,
      clickCount: 0,
      modifiers: 0,
    });
    expect(m.mouse({ type: "mouse", action: "down", x: 5, y: 6, button: "left", clickCount: 1 })).toMatchObject({
      type: "mousePressed",
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    expect(m.mouse({ type: "mouse", action: "move", x: 9, y: 9, button: "left", clickCount: 0 })).toMatchObject({
      type: "mouseMoved",
      button: "left",
      buttons: 1,
    });
    expect(m.mouse({ type: "mouse", action: "up", x: 9, y: 9, button: "left", clickCount: 1 })).toMatchObject({
      type: "mouseReleased",
      button: "left",
      buttons: 0,
    });
    expect(m.mouse({ type: "mouse", action: "move", x: 1, y: 1, button: "left", clickCount: 0 })).toMatchObject({
      button: "none",
      buttons: 0,
    });
    expect(m.buttons).toBe(0);
  });

  it("tracks several buttons", () => {
    const m = new InputMapper();
    m.mouse({ type: "mouse", action: "down", x: 1, y: 1, button: "left", clickCount: 1 });
    expect(m.mouse({ type: "mouse", action: "down", x: 1, y: 1, button: "right", clickCount: 1 })).toMatchObject({
      button: "right",
      buttons: 3,
    });
    expect(m.mouse({ type: "mouse", action: "up", x: 1, y: 1, button: "left", clickCount: 1 })).toMatchObject({
      buttons: 2,
    });
    expect(m.mouse({ type: "mouse", action: "move", x: 1, y: 1, button: "left", clickCount: 0 })).toMatchObject({
      button: "right",
      buttons: 2,
    });
  });

  it("types Enter and Space as keyDown with their text, and other keys without text as rawKeyDown", () => {
    const m = new InputMapper();
    expect(m.key({ type: "key", action: "down", key: "Enter", code: "Enter", text: "\r", modifiers: 0 })).toMatchObject(
      { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 },
    );
    expect(m.key({ type: "key", action: "down", key: " ", code: "Space", text: " ", modifiers: 0 })).toMatchObject({
      type: "keyDown",
      text: " ",
      windowsVirtualKeyCode: 32,
    });
    expect(m.key({ type: "key", action: "down", key: "Backspace", code: "Backspace", modifiers: 0 })).toEqual({
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      modifiers: 0,
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    expect(m.key({ type: "key", action: "up", key: "Enter", code: "Enter", modifiers: 0 })).toMatchObject({
      type: "keyUp",
      windowsVirtualKeyCode: 13,
    });
    expect(m.key({ type: "key", action: "up", key: "Enter", code: "Enter", modifiers: 0 })).not.toHaveProperty("text");
  });

  it("passes the modifiers of a key up straight through", () => {
    const m = new InputMapper();
    expect(m.key({ type: "key", action: "up", key: "a", code: "KeyA", modifiers: 2 | 8 })).toMatchObject({
      type: "keyUp",
      modifiers: 10,
    });
    expect(m.key({ type: "key", action: "down", key: "A", code: "KeyA", text: "A", modifiers: 8 })).toMatchObject({
      type: "keyDown",
      modifiers: 8,
      text: "A",
      windowsVirtualKeyCode: 65,
    });
  });

  it("names the editing commands for Ctrl/Meta shortcuts and not for Alt combinations", () => {
    const m = new InputMapper();
    expect(m.key({ type: "key", action: "down", key: "a", code: "KeyA", modifiers: 2 })).toMatchObject({
      type: "rawKeyDown",
      commands: ["selectAll"],
    });
    expect(m.key({ type: "key", action: "down", key: "v", code: "KeyV", modifiers: 4 })).toMatchObject({
      commands: ["paste"],
    });
    expect(m.key({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 2 | 1 })).not.toHaveProperty(
      "commands",
    );
    expect(m.key({ type: "key", action: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 })).not.toHaveProperty(
      "commands",
    );
  });

  it("gives the virtual key codes of the common keys", () => {
    const code = (key: string, c = key) => virtualKeyCode(key, c);
    expect(
      [
        "Enter",
        "Backspace",
        "Tab",
        "Escape",
        "ArrowLeft",
        "ArrowUp",
        "ArrowRight",
        "ArrowDown",
        "Delete",
        " ",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ].map((k) => code(k)),
    ).toEqual([13, 8, 9, 27, 37, 38, 39, 40, 46, 32, 36, 35, 33, 34]);
    expect(code("F5")).toBe(116);
    expect(code("é", "KeyE")).toBe(69);
    expect(code("你", "KeyN")).toBe(78);
    expect(code("Unidentified", "Whatever")).toBeUndefined();
  });

  it("scrolls with the wheel at the pointer", () => {
    expect(new InputMapper().wheel({ type: "wheel", x: 3, y: 4, dx: 1, dy: -50 })).toEqual({
      type: "mouseWheel",
      x: 3,
      y: 4,
      deltaX: 1,
      deltaY: -50,
      button: "none",
      buttons: 0,
      modifiers: 0,
    });
  });
});

describe("field refusal", () => {
  it("refuses to type into password, one-time-code and card fields", () => {
    expect(fieldRefusal(el("textbox", "Password", { type: "password" }))).toMatch(/Never type passwords/);
    expect(fieldRefusal(el("textbox", "Code", { autocomplete: "one-time-code" }))).toMatch(/Never type/);
    expect(fieldRefusal(el("textbox", "Number", { autocomplete: "cc-number" }))).toMatch(/Never type/);
    expect(fieldRefusal(el("textbox", "Pass", { autocomplete: "current-password" }))).toMatch(/Never type/);
    expect(fieldRefusal(el("textbox", "Search", { type: "search" }))).toBeUndefined();
  });
});
