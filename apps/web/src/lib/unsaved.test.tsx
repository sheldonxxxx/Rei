import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnsavedChangesProvider, useAnyUnsaved, useDirtyBaseline, useReportUnsaved } from "./unsaved.tsx";

describe("useDirtyBaseline", () => {
  it("is clean until a snapshot is taken, then dirty when the value differs", () => {
    const { result, rerender } = renderHook(({ value }) => useDirtyBaseline(value), {
      initialProps: { value: { a: 1 } as unknown },
    });
    expect(result.current.dirty).toBe(false);
    act(() => result.current.markSaved({ a: 1 }));
    expect(result.current.dirty).toBe(false);
    rerender({ value: { a: 2 } });
    expect(result.current.dirty).toBe(true);
    rerender({ value: { a: 1 } });
    expect(result.current.dirty).toBe(false);
  });

  it("clears after a new snapshot of the edited value", () => {
    const { result, rerender } = renderHook(({ value }) => useDirtyBaseline(value), {
      initialProps: { value: "old" as unknown },
    });
    act(() => result.current.markSaved("old"));
    rerender({ value: "new" });
    expect(result.current.dirty).toBe(true);
    act(() => result.current.markSaved("new"));
    expect(result.current.dirty).toBe(false);
  });
});

function Form({ dirty }: { dirty: boolean }) {
  useReportUnsaved(dirty);
  return null;
}

function Watcher() {
  return <output data-testid="any">{String(useAnyUnsaved())}</output>;
}

describe("UnsavedChangesProvider", () => {
  it("is dirty while any form reports unsaved edits, and clean once they all clear", () => {
    const { rerender } = render(
      <UnsavedChangesProvider>
        <Form dirty={false} />
        <Form dirty={true} />
        <Watcher />
      </UnsavedChangesProvider>,
    );
    expect(screen.getByTestId("any").textContent).toBe("true");
    rerender(
      <UnsavedChangesProvider>
        <Form dirty={false} />
        <Form dirty={false} />
        <Watcher />
      </UnsavedChangesProvider>,
    );
    expect(screen.getByTestId("any").textContent).toBe("false");
  });

  it("clears a form's edits when it unmounts", () => {
    const { rerender } = render(
      <UnsavedChangesProvider>
        <Watcher />
        <Form dirty={true} />
      </UnsavedChangesProvider>,
    );
    expect(screen.getByTestId("any").textContent).toBe("true");
    rerender(
      <UnsavedChangesProvider>
        <Watcher />
      </UnsavedChangesProvider>,
    );
    expect(screen.getByTestId("any").textContent).toBe("false");
  });

  it("asks the browser before the page unloads only while something is dirty", () => {
    render(
      <UnsavedChangesProvider>
        <Form dirty={false} />
      </UnsavedChangesProvider>,
    );
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    render(
      <UnsavedChangesProvider>
        <Form dirty={true} />
      </UnsavedChangesProvider>,
    );
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});
