import type { Agent } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import { AvatarPicker } from "./AvatarPicker.tsx";

const agent: Agent = {
  id: "a1",
  name: "Dot",
  avatar: "bot:round",
  model: null,
  thinkingLevel: "off",
  networkMode: "block",
  defaultProfile: "standard",
  homeSessionId: "h1",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(updateAgent = vi.fn().mockResolvedValue({ agent })) {
  const onClose = vi.fn();
  const view = render(<AvatarPicker agent={agent} api={{ updateAgent } as unknown as Api} onClose={onClose} />);
  return { updateAgent, onClose, view };
}

describe("AvatarPicker", () => {
  it("lists the six bots, focuses the current choice, and waits for a change to enable Save", async () => {
    setup();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(6);
    const current = screen.getByRole<HTMLInputElement>("radio", { name: "River Stone" });
    expect(current.checked).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(current));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves a chosen bot with PATCH through the api, then closes", async () => {
    const { updateAgent, onClose } = setup();
    fireEvent.click(screen.getByRole("radio", { name: "Lucky Cat" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateAgent).toHaveBeenCalledWith("a1", { avatar: "bot:cat" });
  });

  it("saves an emoji typed in the field, and a bot choice clears it", async () => {
    const { updateAgent } = setup();
    const field = screen.getByLabelText("Or an emoji or a few letters") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "🦊" } });
    expect(field.value).toBe("🦊");
    fireEvent.click(screen.getByRole("radio", { name: "Paper Crane" }));
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "🦊" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith("a1", { avatar: "🦊" }));
  });

  it("resizes an uploaded picture and saves it as a data URL", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 300, height: 300, close() {} }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {}, fillRect() {} } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/webp;base64,AAAA");
    const { updateAgent, view } = setup();
    const input = screen.getByLabelText("Picture file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "me.png", { type: "image/png" })] } });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith("a1", { avatar: "data:image/webp;base64,AAAA" }));
  });

  it("says so, inline, when the file is not a picture", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("bad")));
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", BrokenImage);
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = () => "blob:x";
        static revokeObjectURL = () => {};
      },
    );
    const { view } = setup();
    const input = screen.getByLabelText("Picture file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/isn't a picture/);
  });

  it("shows a server refusal inline and stays open", async () => {
    const { onClose } = setup(vi.fn().mockRejectedValue(new ApiError(400, "bad_avatar", "")));
    fireEvent.click(screen.getByRole("radio", { name: "Moon Rabbit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/can't be used/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Cancel and Escape", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
