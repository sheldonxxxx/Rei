import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../api/client.ts";
import { ApiError } from "../api/client.ts";
import { LoginForm } from "./LoginForm.tsx";
import { SetupFlow } from "./SetupFlow.tsx";

const fakeApi = (over: Partial<Record<keyof Api, unknown>>) => over as unknown as Api;
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("LoginForm", () => {
  const submit = async (err: ApiError) => {
    const login = vi.fn().mockRejectedValue(err);
    render(<LoginForm totpEnabled api={fakeApi({ login })} onSignedIn={() => {}} />);
    type("Password", "correct horse battery");
    type("6-digit code", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    return login;
  };

  it("shows 'Wrong password or code' for bad_credentials", async () => {
    const login = await submit(new ApiError(401, "bad_credentials", ""));
    expect((await screen.findByRole("alert")).textContent).toBe("Wrong password or code");
    expect(login).toHaveBeenCalledWith({ password: "correct horse battery", totpCode: "123456" });
  });

  it("shows a wait message for rate_limited", async () => {
    await submit(new ApiError(429, "rate_limited", ""));
    expect((await screen.findByRole("alert")).textContent).toMatch(/wait/i);
  });

  it("signs in and calls onSignedIn", async () => {
    const onSignedIn = vi.fn();
    render(
      <LoginForm totpEnabled api={fakeApi({ login: vi.fn().mockResolvedValue(undefined) })} onSignedIn={onSignedIn} />,
    );
    type("Password", "pw");
    type("6-digit code", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  });

  it("keeps Sign in disabled until the code has 6 digits", () => {
    render(<LoginForm totpEnabled api={fakeApi({})} onSignedIn={() => {}} />);
    type("Password", "pw");
    type("6-digit code", "12345");
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("SetupFlow", () => {
  const uri = "otpauth://totp/rei:me?secret=JBSWY3DPEHPK3PXP&issuer=rei";
  const setup = () => {
    const setupStart = vi.fn().mockResolvedValue({ totpUri: uri, totpSecret: "JBSWY3DPEHPK3PXP" });
    const onDone = vi.fn();
    render(<SetupFlow api={fakeApi({ setupStart })} onDone={onDone} onAlreadySetUp={() => {}} />);
    return { setupStart, onDone };
  };

  it("rejects short passwords and mismatched confirmation before calling the server", async () => {
    const { setupStart } = setup();
    type("Setup code", "abc");
    type(/^Password/, "short");
    type("Confirm password", "short");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/12 characters/);
    type(/^Password/, "a-long-enough-password");
    type("Confirm password", "different-password-1");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/don't match/));
    expect(setupStart).not.toHaveBeenCalled();
  });

  it("creates the account without authenticator enrollment", async () => {
    const { setupStart, onDone } = setup();
    type("Setup code", " abc123 ");
    type(/^Password/, "a-long-enough-password");
    type("Confirm password", "a-long-enough-password");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(setupStart).toHaveBeenCalledWith({ setupCode: "abc123", password: "a-long-enough-password" });
    expect(screen.queryByLabelText("6-digit code")).toBeNull();
  });

  it("shows a server error for a wrong setup code", async () => {
    const setupStart = vi.fn().mockRejectedValue(new ApiError(400, "bad_setup_code", ""));
    render(<SetupFlow api={fakeApi({ setupStart })} onDone={() => {}} onAlreadySetUp={() => {}} />);
    type("Setup code", "nope");
    type(/^Password/, "a-long-enough-password");
    type("Confirm password", "a-long-enough-password");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/setup code/i);
  });
});
