import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { toolStep } from "../test/fixtures.ts";
import { ActivityRow } from "./ActivityRow.tsx";

describe("ActivityRow web chip", () => {
  const fetched = toolStep({
    id: "st7",
    toolName: "web_fetch",
    actionClass: "read_external",
    summary: "Fetch https://guide.example/kyoto",
    web: { title: "Kyoto guide", host: "guide.example" },
  });

  it("shows the page's title and host in simple mode, with no fetch details", () => {
    const { container } = render(
      <ul>
        <ActivityRow step={fetched} />
      </ul>,
    );
    const chip = container.querySelector(".activity-web")!;
    expect(chip.textContent).toBe("Kyoto guideguide.example");
    expect(chip.getAttribute("title")).toBe("Kyoto guide — guide.example");
    expect(container.textContent).not.toMatch(/readability|tokens|HTTP/);
  });

  it("keeps the chip on Inspect's row button in detail mode", () => {
    render(
      <ul>
        <ActivityRow step={fetched} onOpen={() => {}} />
      </ul>,
    );
    const row = screen.getByRole("button", { name: /^Inspect step:/ });
    expect(row.querySelector(".activity-web")?.textContent).toContain("guide.example");
  });

  it("draws no chip for a step that read no web page", () => {
    const { container } = render(
      <ul>
        <ActivityRow step={toolStep({ toolName: "web_fetch" })} />
      </ul>,
    );
    expect(container.querySelector(".activity-web")).toBeNull();
  });
});
