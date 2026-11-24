import { AGENT_BOT_AVATARS } from "@rei/protocol";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./Avatar.tsx";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("Avatar", () => {
  it("draws each built-in bot as an svg of its own", () => {
    for (const value of AGENT_BOT_AVATARS) {
      const { container, unmount } = render(<Avatar value={value} size={40} />);
      const svg = container.querySelector("svg.bot");
      expect(svg?.getAttribute("data-bot")).toBe(value.slice(4));
      expect(container.querySelector(".avatar")?.getAttribute("aria-hidden")).toBe("true");
      unmount();
    }
  });

  it("shows the first bot for an id it doesn't know", () => {
    const { container } = render(<Avatar value="bot:unicorn" />);
    expect(container.querySelector("svg.bot")?.getAttribute("data-bot")).toBe("sprout");
  });

  it("marks a working bot, and leaves it still otherwise", () => {
    const { container, rerender } = render(<Avatar value="bot:cat" working />);
    expect(container.querySelector("svg.bot")?.getAttribute("data-working")).toBe("true");
    rerender(<Avatar value="bot:cat" />);
    expect(container.querySelector("svg.bot")?.hasAttribute("data-working")).toBe(false);
  });

  it("renders a picture as a round image", () => {
    const { container } = render(<Avatar value={PNG} size={48} label="Dot" />);
    const img = container.querySelector("img.avatar-img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(PNG);
    expect(img.style.width).toBe("48px");
    expect(screen.getByRole("img", { name: "Dot" })).toBe(img);
  });

  it("does not load a data: URL that isn't a png, jpeg or webp image", () => {
    const { container } = render(<Avatar value="data:text/html;base64,PHNjcmlwdD4=" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg.bot")).not.toBeNull();
  });

  it("renders an emoji or short text as a badge", () => {
    const { container, rerender } = render(<Avatar value="🙂" size={40} />);
    expect(container.querySelector(".avatar")?.textContent).toBe("🙂");
    rerender(<Avatar value="Dot" size={40} />);
    expect(container.querySelector(".avatar")?.textContent).toBe("Do");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("is an image with a name when it has a label", () => {
    render(<Avatar value="bot:ghost" label="Boo" />);
    expect(screen.getByRole("img", { name: "Boo" })).toBeTruthy();
  });
});
