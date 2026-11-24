import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SetupServices } from "./SetupServices.tsx";

it("saves memory choices inline and keeps API failures visible", async () => {
  const onSaved = vi.fn();
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Save failed"))
    .mockResolvedValue({ enabled: false, available: true, model: "embedding" });
  render(
    <SetupServices
      kind="memory"
      onSaved={onSaved}
      api={
        {
          getMemorySetup: vi.fn().mockResolvedValue({ enabled: true, available: true, model: "embedding" }),
          saveMemorySetup: save,
        } as never
      }
    />,
  );
  fireEvent.change(await screen.findByLabelText("Search conversations"), { target: { value: "keyword" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(onSaved).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(save).toHaveBeenLastCalledWith(false);
});
