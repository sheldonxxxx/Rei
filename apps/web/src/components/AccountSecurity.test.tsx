import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { AccountSecurity } from "./AccountSecurity.tsx";
import { LoginForm } from "./LoginForm.tsx";

it("signs in without a code when two-factor authentication is off", async () => {
  const login = vi.fn().mockResolvedValue({});
  render(<LoginForm api={{ login } as unknown as Api} onSignedIn={() => {}} />);
  expect(screen.queryByLabelText("6-digit code")).toBeNull();
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "a-long-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(login).toHaveBeenCalledWith({ password: "a-long-password" }));
});
it("requires confirmation before showing TOTP as enabled and allows disabling it", async () => {
  const confirmTotp = vi.fn().mockResolvedValue({}),
    disableTotp = vi.fn().mockResolvedValue({});
  const api = {
    getAuthState: async () => ({ totpEnabled: false }),
    startTotp: vi
      .fn()
      .mockResolvedValue({ totpUri: "otpauth://totp/Rei?secret=JBSWY3DPEHPK3PXP", totpSecret: "JBSWY3DPEHPK3PXP" }),
    confirmTotp,
    disableTotp,
  } as unknown as Api;
  render(<AccountSecurity api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Set up authenticator" }));
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "password" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeTruthy();
  expect(confirmTotp).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Enable authenticator" }));
  fireEvent.click(await screen.findByRole("button", { name: "Disable two-factor authentication" }));
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "password" } });
  fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "654321" } });
  fireEvent.click(screen.getByRole("button", { name: "Disable authenticator" }));
  await screen.findByRole("button", { name: "Set up authenticator" });
  expect(confirmTotp).toHaveBeenCalledWith("password", "123456");
  expect(disableTotp).toHaveBeenCalledWith("password", "654321");
});
