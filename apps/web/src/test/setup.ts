import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Radix (tooltips, menus, dialogs) leans on a few browser APIs happy-dom lacks; stub only what is missing.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof globalThis.DOMRect === "undefined") {
  globalThis.DOMRect = class {
    x: number;
    y: number;
    width: number;
    height: number;
    constructor(x = 0, y = 0, width = 0, height = 0) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
    }
    get top() {
      return this.y;
    }
    get left() {
      return this.x;
    }
    get right() {
      return this.x + this.width;
    }
    get bottom() {
      return this.y + this.height;
    }
    toJSON() {
      return { x: this.x, y: this.y, width: this.width, height: this.height };
    }
  } as typeof DOMRect;
}
const proto = Element.prototype;
proto.hasPointerCapture ??= () => false;
proto.setPointerCapture ??= () => {};
proto.releasePointerCapture ??= () => {};
proto.scrollIntoView ??= () => {};

afterEach(() => {
  cleanup();
  try {
    localStorage.clear(); // per-device UI state (sidebar, expanded browser) must not leak between tests
  } catch {
    // no storage in this environment
  }
});
