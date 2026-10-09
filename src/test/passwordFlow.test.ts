import type { AuthErrorLike } from "@/features/auth/lib/authFlow";
import { describe, expect, it, vi } from "vitest";
import {
  attemptChange,
  attemptReset,
  describePasswordError,
  MIN_PASSWORD_LENGTH,
  nextRecoveryStatus,
  parseRecoveryHash,
  passwordFormError,
  type RecoveryStatus,
  type ResetRequestAuth,
  type UpdateUserAuth,
} from "@/features/auth/lib/passwordFlow";

/**
 * The password RESET / CHANGE flow's pure half (roadmap P1-6d, S24). The
 * browser wiring (`ForgotPasswordPage`, `ResetPasswordPage`, `ChangePasswordPage`)
 * is a thin shell over these; everything load-bearing — the two-field form
 * validation, the recovery state machine, reading the redirect hash, the error
 * describer's every branch, and running the two calls against a fake auth — is
 * decided here and tested without a browser or a network, exactly as
 * `authFlow.test.ts` does for sign-in.
 */

/* ===========================================================================
 * Group P — `passwordFormError`, the two-field new-password validation.
 * ======================================================================== */
describe("passwordFlow: passwordFormError", () => {
  it("P1: an empty new password complains about the new password first", () => {
    expect(passwordFormError("", "")).toBe("Enter a new password.");
  });

  it("P2: a password below the length floor is refused before it is sent", () => {
    // The floor is MIN_PASSWORD_LENGTH (6), and the sentence names the number.
    expect(passwordFormError("abc", "abc")).toBe(
      `Your password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
    expect(passwordFormError("12345", "12345")).toMatch(/at least 6 characters/);
  });

  it("P3: a length floor passed in overrides the default", () => {
    expect(passwordFormError("abcdef", "abcdef", 10)).toMatch(/at least 10 characters/);
    expect(passwordFormError("abcdefghij", "abcdefghij", 10)).toBeNull();
  });

  it("P4: an empty confirmation is called out once the password is long enough", () => {
    expect(passwordFormError("abcdef", "")).toBe("Re-enter your new password to confirm it.");
  });

  it("P5 ⭐: two long-enough passwords that do not MATCH are refused", () => {
    expect(passwordFormError("abcdef", "abcdeg")).toBe("Those passwords do not match.");
  });

  it("P6: a matching, long-enough pair is accepted", () => {
    expect(passwordFormError("abcdef", "abcdef")).toBeNull();
    expect(passwordFormError("a-longer-one", "a-longer-one")).toBeNull();
  });
});

/* ===========================================================================
 * Group M — `nextRecoveryStatus`, the recovery-screen state machine. The
 * cases that must NOT collapse: a bad link goes to `failed`, never a blank
 * form; the terminal states stay terminal.
 * ======================================================================== */
describe("passwordFlow: nextRecoveryStatus", () => {
  it("M1: waiting + a recovery session -> ready", () => {
    expect(nextRecoveryStatus("waiting", "session-arrived")).toBe("ready");
  });

  it("M2 ⚠️: waiting + a link error -> failed (the terminal screen, not a form)", () => {
    expect(nextRecoveryStatus("waiting", "link-error")).toBe("failed");
  });

  it("M3: ready + the password set -> done", () => {
    expect(nextRecoveryStatus("ready", "password-set")).toBe("done");
  });

  it("M4 ⚠️: ready + a link error (an expired/used token on submit) -> failed", () => {
    expect(nextRecoveryStatus("ready", "link-error")).toBe("failed");
  });

  it("M5: the terminal states stay put, and stray events are no-ops", () => {
    const terminals: RecoveryStatus[] = ["done", "failed"];
    for (const t of terminals) {
      expect(nextRecoveryStatus(t, "session-arrived")).toBe(t);
      expect(nextRecoveryStatus(t, "password-set")).toBe(t);
      expect(nextRecoveryStatus(t, "link-error")).toBe(t);
    }
    // A stray password-set while still waiting does not skip the form.
    expect(nextRecoveryStatus("waiting", "password-set")).toBe("waiting");
    // A stray session-arrived while ready does not undo readiness.
    expect(nextRecoveryStatus("ready", "session-arrived")).toBe("ready");
  });
});

/* ===========================================================================
 * Group H — `parseRecoveryHash`, reading the redirect fragment.
 * ======================================================================== */
describe("passwordFlow: parseRecoveryHash", () => {
  it("H1: the success fragment (tokens, type=recovery) reads as recovery", () => {
    expect(parseRecoveryHash("#access_token=abc&refresh_token=def&type=recovery")).toEqual({
      kind: "recovery",
    });
    // An access_token alone is enough.
    expect(parseRecoveryHash("#access_token=abc")).toEqual({ kind: "recovery" });
  });

  it("H2 ⚠️: the error fragment reads as error, carrying the code", () => {
    const parsed = parseRecoveryHash(
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
    expect(parsed.kind).toBe("error");
    if (parsed.kind === "error") {
      expect(parsed.code).toBe("otp_expired");
      expect(parsed.description).toMatch(/invalid or has expired/);
    }
  });

  it("H3: an empty / missing / unrelated fragment reads as none", () => {
    expect(parseRecoveryHash("")).toEqual({ kind: "none" });
    expect(parseRecoveryHash("#")).toEqual({ kind: "none" });
    expect(parseRecoveryHash(null)).toEqual({ kind: "none" });
    expect(parseRecoveryHash(undefined)).toEqual({ kind: "none" });
    expect(parseRecoveryHash("#foo=bar")).toEqual({ kind: "none" });
  });

  it("H4: a leading ? instead of # is tolerated", () => {
    expect(parseRecoveryHash("?type=recovery&access_token=x")).toEqual({ kind: "recovery" });
  });
});

/* ===========================================================================
 * Group E — `describePasswordError`, every branch. No raw provider string
 * ever reaches the UI, and the branches are distinct from sign-in's.
 * ======================================================================== */
describe("passwordFlow: describePasswordError", () => {
  it("E1 ⭐: an expired/used recovery token reads as the request-a-new-one sentence", () => {
    expect(describePasswordError({ code: "otp_expired" })).toBe(
      "That reset link has expired. Request a new one.",
    );
    expect(describePasswordError({ status: 401, message: "Auth session missing!" })).toMatch(
      /reset link has expired/,
    );
    expect(describePasswordError({ message: "Email link is invalid or has expired" })).toMatch(
      /reset link has expired/,
    );
  });

  it("E2 ⭐: a weak password (code / 422 / message) reads as the strength sentence", () => {
    expect(describePasswordError({ code: "weak_password" })).toMatch(/does not meet/);
    expect(describePasswordError({ status: 422 })).toMatch(/does not meet/);
    expect(describePasswordError({ message: "Password should be at least 6 characters" })).toMatch(
      /does not meet/,
    );
  });

  it("E3: rate limiting is called out", () => {
    expect(describePasswordError({ status: 429 })).toMatch(/Too many attempts/);
    expect(describePasswordError({ message: "rate limit exceeded" })).toMatch(/Too many attempts/);
  });

  it("E4: anything unrecognised falls back to a generic sentence, never the raw string", () => {
    expect(describePasswordError({ message: "kaboom internal xyz" })).toBe(
      "Could not update your password. Please try again.",
    );
    expect(describePasswordError(null)).toBe("Could not update your password. Please try again.");
    expect(describePasswordError(undefined)).toBe(
      "Could not update your password. Please try again.",
    );
  });

  it("E6: re-entering the current password is its own sentence, not the strength one", () => {
    expect(describePasswordError({ code: "same_password", status: 422 })).toBe(
      "That is already your password. Choose a different one.",
    );
    expect(
      describePasswordError({
        status: 422,
        message: "New password should be different from the old password.",
      }),
    ).toBe("That is already your password. Choose a different one.");
    // And a plain 422 without that code is still the strength sentence.
    expect(describePasswordError({ status: 422 })).toMatch(/does not meet/);
  });

  it("E5: weak is checked before expired, so a 422 is never mistaken for a bad link", () => {
    // A 422 with an 'expired'-ish message must still read as weak, since 422 is
    // the strength status; the order in the describer is what guarantees it.
    expect(describePasswordError({ status: 422, message: "invalid token expired" })).toMatch(
      /does not meet/,
    );
  });
});

/* ===========================================================================
 * Group R — `attemptReset` against a mocked auth.
 * ======================================================================== */
describe("passwordFlow: attemptReset (mocked supabase.auth)", () => {
  function fakeReset(result: { error: { message?: string; status?: number } | null }): {
    auth: ResetRequestAuth;
    fn: ReturnType<typeof vi.fn>;
  } {
    const fn = vi.fn().mockResolvedValue(result);
    return { auth: { resetPasswordForEmail: fn }, fn };
  }

  it("R1: a successful request returns ok with no message (the screen shows the neutral line)", async () => {
    const { auth, fn } = fakeReset({ error: null });
    const outcome = await attemptReset(auth, "person@example.test", "http://x/reset-password");
    expect(outcome).toEqual({ ok: true, message: null });
    expect(fn).toHaveBeenCalledWith("person@example.test", {
      redirectTo: "http://x/reset-password",
    });
  });

  it("R2 ⭐: an unknown-address success is INDISTINGUISHABLE from a known one", async () => {
    // Supabase returns success for an address with no account, so the neutrality
    // is the server's; attemptReset just relays the ok either way.
    const { auth } = fakeReset({ error: null });
    const outcome = await attemptReset(auth, "nobody@example.test", "http://x/reset-password");
    expect(outcome).toEqual({ ok: true, message: null });
  });

  it("R3: an invalid email short-circuits and never calls the network", async () => {
    const { auth, fn } = fakeReset({ error: null });
    const outcome = await attemptReset(auth, "", "http://x/reset-password");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("Enter your email address.");
    expect(fn).not.toHaveBeenCalled();
  });

  it("R4: the email is trimmed before it reaches the network", async () => {
    const { auth, fn } = fakeReset({ error: null });
    await attemptReset(auth, "  a@b.com  ", "http://x/reset-password");
    expect(fn).toHaveBeenCalledWith("a@b.com", { redirectTo: "http://x/reset-password" });
  });

  it("R5: a provider error is described, not relayed raw", async () => {
    const { auth } = fakeReset({ error: { status: 429 } });
    const outcome = await attemptReset(auth, "a@b.com", "http://x/reset-password");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/Too many attempts/);
  });

  it("R6: a rejected promise (network failure) becomes a described error, not a throw", async () => {
    const auth: ResetRequestAuth = {
      resetPasswordForEmail: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const outcome = await attemptReset(auth, "a@b.com", "http://x/reset-password");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("Could not update your password. Please try again.");
  });
});

/* ===========================================================================
 * Group C — `attemptChange` against a mocked auth (used by both the change
 * screen and the reset screen's final step).
 * ======================================================================== */
describe("passwordFlow: attemptChange (mocked supabase.auth)", () => {
  function fakeUpdate(result: { error: AuthErrorLike | null }): {
    auth: UpdateUserAuth;
    fn: ReturnType<typeof vi.fn>;
  } {
    const fn = vi.fn().mockResolvedValue(result);
    return { auth: { updateUser: fn }, fn };
  }

  it("C1: a successful change returns ok with no message", async () => {
    const { auth, fn } = fakeUpdate({ error: null });
    const outcome = await attemptChange(auth, "abcdef", "abcdef");
    expect(outcome).toEqual({ ok: true, message: null });
    expect(fn).toHaveBeenCalledWith({ password: "abcdef" });
  });

  it("C2: an invalid form short-circuits and never calls the network", async () => {
    const { auth, fn } = fakeUpdate({ error: null });
    const outcome = await attemptChange(auth, "abc", "abc");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/at least 6 characters/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("C3: a mismatch short-circuits before the network too", async () => {
    const { auth, fn } = fakeUpdate({ error: null });
    const outcome = await attemptChange(auth, "abcdef", "abcdeg");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("Those passwords do not match.");
    expect(fn).not.toHaveBeenCalled();
  });

  it("C4: a provider error is described, not relayed raw", async () => {
    const { auth } = fakeUpdate({ error: { code: "weak_password" } });
    const outcome = await attemptChange(auth, "abcdef", "abcdef");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/does not meet/);
  });

  it("C5: a rejected promise (network failure) becomes a described error, not a throw", async () => {
    const auth: UpdateUserAuth = {
      updateUser: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const outcome = await attemptChange(auth, "abcdef", "abcdef");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBe("Could not update your password. Please try again.");
  });
});
