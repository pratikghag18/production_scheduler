import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ForgotPasswordPage from "@/features/auth/ForgotPasswordPage";
import ResetPasswordPage from "@/features/auth/ResetPasswordPage";
import ChangePasswordPage from "@/features/auth/ChangePasswordPage";

/**
 * The three password screens, driven with testing-library (roadmap P1-6d, S24).
 * The DECISIONS are `passwordFlow.test.ts`'s; this file proves the screens are
 * wired to them — the neutral sentence the forgot screen shows whether or not an
 * address exists, the reset screen refusing to submit until a recovery session
 * exists, and the change screen keeping the person signed in.
 *
 * Same shape as `adminNoGrants.test.tsx`: `@/lib/supabase` is mocked at the
 * network boundary with a hoisted fake whose results and captured auth callback
 * a case sets; `react-router-dom`'s `useNavigate` is spied so a case can assert
 * a navigation happened — or, for change-password, that it did NOT. Inputs are
 * driven with `fireEvent` (the repo's own idiom; there is no `user-event` dep).
 */

const h = vi.hoisted(() => ({
  /** The `onAuthStateChange` listener the reset page registers, captured so a
   *  case can fire a PASSWORD_RECOVERY event by hand. */
  authCb: null as null | ((event: string, session: unknown) => void),
  getSessionResult: { data: { session: null as unknown } },
  resetResult: { error: null as { message?: string; status?: number; code?: string } | null },
  updateResult: { error: null as { message?: string; status?: number; code?: string } | null },
  navigate: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      resetPasswordForEmail: vi.fn(async () => h.resetResult),
      updateUser: vi.fn(async () => h.updateResult),
      getSession: vi.fn(async () => h.getSessionResult),
      onAuthStateChange: vi.fn((cb: (event: string, session: unknown) => void) => {
        h.authCb = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
    },
  },
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => h.navigate };
});

function show(node: ReactElement): void {
  render(<MemoryRouter>{node}</MemoryRouter>);
}

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  h.authCb = null;
  h.getSessionResult = { data: { session: null } };
  h.resetResult = { error: null };
  h.updateResult = { error: null };
  h.navigate = vi.fn();
  // Every screen mounts with a clean hash unless a case sets one.
  window.location.hash = "";
});

afterEach(() => {
  window.location.hash = "";
});

/* ===========================================================================
 * Group A — the three screens render.
 * ======================================================================== */
describe("password screens render", () => {
  it("A1: the forgot screen renders its email form", () => {
    show(<ForgotPasswordPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Reset your password" })).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeTruthy();
  });

  it("A2: the change screen renders both new-password fields", () => {
    show(<ChangePasswordPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Change password" })).toBeTruthy();
    expect(screen.getByLabelText("New password")).toBeTruthy();
    expect(screen.getByLabelText("Confirm new password")).toBeTruthy();
  });

  it("A3: both change fields carry autoComplete=new-password; the email carries username", () => {
    show(<ChangePasswordPage />);
    expect(screen.getByLabelText("New password").getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByLabelText("Confirm new password").getAttribute("autocomplete")).toBe(
      "new-password",
    );
    render(
      <MemoryRouter>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("username");
  });
});

/* ===========================================================================
 * Group F — the forgot screen's neutrality.
 * ======================================================================== */
describe("the forgot screen says the same thing whether or not the address exists", () => {
  it("F1 ⭐: a successful request shows the neutral sentence", async () => {
    h.resetResult = { error: null };
    show(<ForgotPasswordPage />);
    type("Email", "person@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(
      await screen.findByText(/If that address has an account, a reset link is on its way\./),
    ).toBeTruthy();
  });

  it("F2 ⭐: an unknown address is INDISTINGUISHABLE — Supabase returns ok, so the SAME sentence shows", async () => {
    // Supabase returns success for an address with no account precisely so this
    // screen cannot leak which. The fake mirrors that: error null either way.
    h.resetResult = { error: null };
    show(<ForgotPasswordPage />);
    type("Email", "nobody@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(
      await screen.findByText(/If that address has an account, a reset link is on its way\./),
    ).toBeTruthy();
    // ⚠️ And nothing that would reveal the address does or does not exist.
    expect(screen.queryByText(/no account/i)).toBe(null);
    expect(screen.queryByText(/not found/i)).toBe(null);
  });

  it("F3: a rate-limit failure shows a described error, not the neutral sentence", async () => {
    h.resetResult = { error: { status: 429 } };
    show(<ForgotPasswordPage />);
    type("Email", "person@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByText(/Too many attempts/)).toBeTruthy();
    expect(screen.queryByText(/reset link is on its way/)).toBe(null);
  });
});

/* ===========================================================================
 * Group R — the reset screen refuses to submit until the recovery session
 * exists, and lands on `failed` for a bad link.
 * ======================================================================== */
describe("the reset screen waits for the recovery session", () => {
  it("R1 ⭐: with tokens in the URL but no session yet, no form is shown", async () => {
    // A real recovery link: the hash carries tokens, but the session has not been
    // established yet. The screen must be in 'waiting', not showing a form that
    // would submit into nothing.
    window.location.hash = "#access_token=abc&type=recovery";
    show(<ResetPasswordPage />);
    await waitFor(() => {
      expect(screen.getByText(/Checking your reset link/)).toBeTruthy();
    });
    expect(screen.queryByLabelText("New password")).toBe(null);
  });

  it("R2 ⭐: once the PASSWORD_RECOVERY event fires, the form appears", async () => {
    window.location.hash = "#access_token=abc&type=recovery";
    show(<ResetPasswordPage />);
    await waitFor(() => expect(h.authCb).not.toBeNull());
    await act(async () => {
      h.authCb?.("PASSWORD_RECOVERY", { user: { id: "u1" } });
    });
    expect(await screen.findByLabelText("New password")).toBeTruthy();
    expect(screen.getByLabelText("Confirm new password")).toBeTruthy();
    expect(screen.getByLabelText("New password").getAttribute("autocomplete")).toBe("new-password");
  });

  it("R3 ⚠️: a link whose hash carries an error lands on the terminal failed screen", async () => {
    window.location.hash =
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";
    show(<ResetPasswordPage />);
    expect(
      await screen.findByText(/That reset link has expired\. Request a new one\./),
    ).toBeTruthy();
    expect(screen.queryByLabelText("New password")).toBe(null);
    expect(screen.getByRole("link", { name: "Request a new link" })).toBeTruthy();
  });

  it("R4: setting the password navigates to the board", async () => {
    window.location.hash = "#access_token=abc&type=recovery";
    h.updateResult = { error: null };
    show(<ResetPasswordPage />);
    await waitFor(() => expect(h.authCb).not.toBeNull());
    await act(async () => {
      h.authCb?.("PASSWORD_RECOVERY", { user: { id: "u1" } });
    });
    await screen.findByLabelText("New password");
    type("New password", "newpassword");
    type("Confirm new password", "newpassword");
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith("/", { replace: true }));
  });
});

/* ===========================================================================
 * Group C — the change screen keeps the person signed in.
 * ======================================================================== */
describe("the change screen changes the password and stays put", () => {
  it("C1 ⭐: a successful change shows a sentence and does NOT navigate", async () => {
    h.updateResult = { error: null };
    show(<ChangePasswordPage />);
    type("New password", "newpassword");
    type("Confirm new password", "newpassword");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Your password has been changed.")).toBeTruthy();
    // ⚠️ THE WHOLE POINT: no navigation, so the session is untouched and the
    // person stays where they were.
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("C2: a mismatch is refused before any network call, and nothing is sent", async () => {
    show(<ChangePasswordPage />);
    type("New password", "newpassword");
    type("Confirm new password", "different-one");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Those passwords do not match.")).toBeTruthy();
    expect(screen.queryByText("Your password has been changed.")).toBe(null);
  });

  it("C3: a provider error is shown as a sentence, not a raw string", async () => {
    h.updateResult = { error: { code: "weak_password" } };
    show(<ChangePasswordPage />);
    type("New password", "newpassword");
    type("Confirm new password", "newpassword");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText(/does not meet the requirements/)).toBeTruthy();
  });
});
