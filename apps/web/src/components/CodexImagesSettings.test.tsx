import type { CodexImagesStatus } from "@rei/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexImagesSettings } from "./CodexImagesSettings.tsx";

const VERIFY = "https://auth.openai.com/codex/device";
const waiting: CodexImagesStatus = {
  enabled: true,
  signedIn: false,
  pending: true,
  userCode: "ABCD-1234",
  verificationUrl: VERIFY,
};
const idle: CodexImagesStatus = { enabled: true, signedIn: false, pending: false };

function setup(first: CodexImagesStatus) {
  let current = first;
  const api = {
    getCodexImages: vi.fn(async () => current),
    startCodexImagesSignIn: vi.fn(async () => {
      current = waiting;
      return { userCode: "ABCD-1234", verificationUrl: VERIFY };
    }),
    cancelCodexImagesSignIn: vi.fn(async () => {
      current = idle;
    }),
    signOutCodexImages: vi.fn(async () => {
      current = idle;
    }),
  };
  render(<CodexImagesSettings api={api as never} />);
  return { api, set: (next: CodexImagesStatus) => (current = next) };
}
afterEach(() => vi.unstubAllGlobals());

it("explains that Codex Images is off when the installation has not enabled it", async () => {
  const { api } = setup({ enabled: false, signedIn: false, pending: false });
  await screen.findByText(/needs the gateway/);
  expect(screen.queryByRole("button", { name: "Sign in to Codex Images" })).toBeNull();
  expect(api.startCodexImagesSignIn).not.toHaveBeenCalled();
});

it("shows the code in a dialog first, opens OpenAI only on request, and closes once signed in", async () => {
  const open = vi.fn(() => null);
  vi.stubGlobal("open", open);
  const { api, set } = setup(idle);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in to Codex Images" }));
  expect((await screen.findByLabelText("Device code")).textContent).toBe("ABCD-1234");
  expect(api.startCodexImagesSignIn).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open OpenAI page" }));
  expect(open).toHaveBeenCalledWith(VERIFY, "_blank", "noopener,noreferrer");
  set({ enabled: true, signedIn: true, pending: false });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 4000 });
  await screen.findByText("Signed in");
});

it("reopens the dialog for an attempt already waiting and cancels it from Cancel", async () => {
  const { api } = setup(waiting);
  await screen.findByLabelText("Device code");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(api.cancelCodexImagesSignIn).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await screen.findByRole("button", { name: "Sign in to Codex Images" });
});

it("cancels the attempt when the dialog is dismissed with its close button", async () => {
  const { api } = setup(waiting);
  await screen.findByLabelText("Device code");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(api.cancelCodexImagesSignIn).toHaveBeenCalledTimes(1));
});

it("offers sign out when signed in", async () => {
  const { api } = setup({ enabled: true, signedIn: true, pending: false });
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(api.signOutCodexImages).toHaveBeenCalled());
  await screen.findByText("Needs sign-in");
});

it("shows why a finished attempt failed", async () => {
  setup({ ...idle, error: "The sign-in code expired. Start again." });
  await screen.findByText("The sign-in code expired. Start again.");
});
