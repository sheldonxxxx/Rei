import { fireEvent } from "@testing-library/react";

/** Opens a Radix dropdown menu from its trigger. Radix opens on pointer-down (a plain click does nothing), so tests press it that way. */
export function openMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}
