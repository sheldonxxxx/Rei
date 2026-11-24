import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import { LoginForm } from "./LoginForm.tsx";
import { PasskeySettings } from "./PasskeySettings.tsx";

const webauthn = vi.hoisted(() => ({
  supported: true,
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => webauthn.supported,
  startAuthentication: webauthn.startAuthentication,
  startRegistration: webauthn.startRegistration,
}));

const asApi = (over: Record<string, unknown>) => over as unknown as Api;
const notAllowed = () => Object.assign(new Error("The operation was cancelled."), { name: "NotAllowedError" });

beforeEach(() => {
  webauthn.supported = true;
  webauthn.startAuthentication.mockReset();
  webauthn.startRegistration.mockReset();
});

describe("LoginForm passkey sign-in", () => {
  const api = () => ({
    passkeyLoginOptions: vi.fn().mockResolvedValue({ challengeId: "c1", options: { challenge: "abc" } }),
    passkeyLogin: vi.fn().mockResolvedValue({}),
  });

  it("offers the passkey only when one is registered and the browser supports it", () => {
    const { rerender } = render(<LoginForm api={asApi(api())} onSignedIn={() => {}} />);
    expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull();
    rerender(<LoginForm api={asApi(api())} passkeys onSignedIn={() => {}} />);
    expect(screen.getByRole("button", { name: "Sign in with a passkey" })).toBeTruthy();
    webauthn.supported = false;
    rerender(<LoginForm api={asApi(api())} passkeys onSignedIn={() => {}} />);
    expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull();
  });

  it("signs in with the browser's answer, needing no password", async () => {
    const fake = api();
    const onSignedIn = vi.fn();
    webauthn.startAuthentication.mockResolvedValue({ id: "cred", type: "public-key" });
    render(<LoginForm api={asApi(fake)} passkeys totpEnabled onSignedIn={onSignedIn} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "abc" } });
    expect(fake.passkeyLogin).toHaveBeenCalledWith({
      challengeId: "c1",
      response: { id: "cred", type: "public-key" },
    });
  });

  it("stays quiet when the person closes the browser prompt, and shows a refusal from the server", async () => {
    const fake = api();
    webauthn.startAuthentication.mockRejectedValueOnce(notAllowed());
    render(<LoginForm api={asApi(fake)} passkeys onSignedIn={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => expect(webauthn.startAuthentication).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Sign in with a passkey" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fake.passkeyLogin).not.toHaveBeenCalled();

    webauthn.startAuthentication.mockResolvedValueOnce({ id: "cred" });
    fake.passkeyLogin.mockRejectedValueOnce(new ApiError(401, "bad_passkey", ""));
    fireEvent.click(screen.getByRole("button", { name: "Sign in with a passkey" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/passkey wasn't accepted/i);
  });
});

describe("PasskeySettings", () => {
  const passkey = { id: "p1", label: "MacBook", createdAt: Date.UTC(2026, 0, 5), synced: true };

  it("lists passkeys and removes one", async () => {
    const listPasskeys = vi
      .fn()
      .mockResolvedValueOnce({ passkeys: [passkey] })
      .mockResolvedValue({ passkeys: [] });
    const removePasskey = vi.fn().mockResolvedValue(undefined);
    render(<PasskeySettings api={asApi({ listPasskeys, removePasskey })} />);
    expect(await screen.findByText(/MacBook/)).toBeTruthy();
    expect(screen.getByText(/synced/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove MacBook" }));
    await waitFor(() => expect(removePasskey).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.queryByText(/MacBook/)).toBeNull());
  });

  it("adds a passkey after the password, with an optional name", async () => {
    const listPasskeys = vi.fn().mockResolvedValue({ passkeys: [] });
    const passkeyRegisterOptions = vi.fn().mockResolvedValue({ challengeId: "c9", options: { challenge: "xyz" } });
    const passkeyRegister = vi.fn().mockResolvedValue(passkey);
    webauthn.startRegistration.mockResolvedValue({ id: "new", type: "public-key" });
    render(<PasskeySettings api={asApi({ listPasskeys, passkeyRegisterOptions, passkeyRegister })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a passkey" }));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "pw-long-enough" } });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: " Work laptop " } });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));
    await waitFor(() => expect(passkeyRegister).toHaveBeenCalled());
    expect(passkeyRegisterOptions).toHaveBeenCalledWith("pw-long-enough");
    expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: "xyz" } });
    expect(passkeyRegister).toHaveBeenCalledWith({
      challengeId: "c9",
      response: { id: "new", type: "public-key" },
      label: "Work laptop",
    });
    await waitFor(() => expect(screen.queryByLabelText("Current password")).toBeNull());
  });

  it("shows a wrong password and keeps the form open", async () => {
    const listPasskeys = vi.fn().mockResolvedValue({ passkeys: [] });
    const passkeyRegisterOptions = vi.fn().mockRejectedValue(new ApiError(401, "bad_credentials", ""));
    render(<PasskeySettings api={asApi({ listPasskeys, passkeyRegisterOptions })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a passkey" }));
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Create passkey" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong password or code");
    expect(screen.getByLabelText("Current password")).toBeTruthy();
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
  });

  it("says so when the browser cannot create passkeys", async () => {
    webauthn.supported = false;
    render(<PasskeySettings api={asApi({ listPasskeys: vi.fn().mockResolvedValue({ passkeys: [] }) })} />);
    expect(await screen.findByText(/can't create passkeys/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
  });
});
