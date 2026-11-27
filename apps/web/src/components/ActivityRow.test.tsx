import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { toolStep } from "../test/fixtures.ts";
import { ActivityRow } from "./ActivityRow.tsx";

describe("ActivityRow badges", () => {
  const fetched = toolStep({
    id: "st7",
    toolName: "web_fetch",
    actionClass: "read_external",
    summary: "Fetch https://guide.example/kyoto",
    web: { title: "Kyoto guide", host: "guide.example" },
  });
  const knowledge = toolStep({
    id: "st8",
    toolName: "knowledge_read",
    actionClass: "read_internal",
    summary: "Read Trip plan",
    page: { id: "pg_1", title: "Trip plan", trashed: false },
  });

  it("omits page and web badges in simple mode", () => {
    const { container } = render(
      <ul>
        <ActivityRow step={fetched} />
        <ActivityRow step={knowledge} />
      </ul>,
    );
    expect(container.querySelector(".activity-web")).toBeNull();
    expect(container.querySelector(".activity-page")).toBeNull();
    expect(container.textContent).not.toMatch(/readability|tokens|HTTP/);
  });

  it("shows page and web badges on Inspect's row button in detail mode", () => {
    render(
      <ul>
        <ActivityRow step={fetched} onOpen={() => {}} />
        <ActivityRow step={knowledge} onOpen={() => {}} />
      </ul>,
    );
    const rows = screen.getAllByRole("button", { name: /^Inspect step:/ });
    const webChip = rows[0]!.querySelector(".activity-web")!;
    expect(webChip.textContent).toBe("Kyoto guideguide.example");
    expect(webChip.getAttribute("title")).toBe("Kyoto guide — guide.example");
    expect(rows[1]!.querySelector(".activity-page")?.textContent).toBe("Trip plan");
  });

  it("draws no chip for a step that read no web page or knowledge page", () => {
    const { container } = render(
      <ul>
        <ActivityRow step={toolStep({ toolName: "web_fetch" })} onOpen={() => {}} />
      </ul>,
    );
    expect(container.querySelector(".activity-web")).toBeNull();
    expect(container.querySelector(".activity-page")).toBeNull();
  });
});
