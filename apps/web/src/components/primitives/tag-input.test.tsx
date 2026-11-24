import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TagInput } from "./tag-input.tsx";

function Harness({ initial = [], onSubmit }: { initial?: string[]; onSubmit?: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <label htmlFor="tags">Models</label>
      <TagInput id="tags" value={value} onChange={setValue} placeholder="Type a model ID and press Enter" />
    </form>
  );
}

describe("TagInput", () => {
  it("turns Enter into a tag without submitting the form, and clears the field", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Models") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "gpt-x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("gpt-x")).toBeTruthy();
    expect(input.value).toBe("");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("removes a tag with its × button", () => {
    render(<Harness initial={["a", "b"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove a" }));
    expect(screen.queryByText("a")).toBeNull();
    expect(screen.getByText("b")).toBeTruthy();
  });

  it("removes only the tag whose × was clicked, and clicking the box or a tag removes nothing", () => {
    render(<Harness initial={["a", "b", "c"]} />);
    fireEvent.click(screen.getByText("b"));
    fireEvent.click(screen.getByText("a").closest("div") as HTMLElement);
    expect(screen.getAllByRole("button")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Remove b" }));
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.queryByText("b")).toBeNull();
    expect(screen.getByText("c")).toBeTruthy();
  });

  it("ignores duplicates and blank entries", () => {
    render(<Harness initial={["a"]} />);
    const input = screen.getByLabelText("Models");
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getAllByRole("button", { name: /Remove/ })).toHaveLength(1);
  });

  it("removes the last tag on Backspace in an empty field", () => {
    render(<Harness initial={["a", "b"]} />);
    fireEvent.keyDown(screen.getByLabelText("Models"), { key: "Backspace" });
    expect(screen.queryByText("b")).toBeNull();
    expect(screen.getByText("a")).toBeTruthy();
  });

  it("splits a pasted list into tags", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Models");
    fireEvent.paste(input, { clipboardData: { getData: () => "one, two\nthree" } });
    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.getByText("two")).toBeTruthy();
    expect(screen.getByText("three")).toBeTruthy();
  });

  it("turns typed text into a tag when the field loses focus", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Models");
    fireEvent.change(input, { target: { value: "pending-model" } });
    fireEvent.blur(input);
    expect(screen.getByText("pending-model")).toBeTruthy();
  });
});
