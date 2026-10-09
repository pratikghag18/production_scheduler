/**
 * The password RESET / CHANGE flow's PURE half (roadmap P1-6d, S24).
 *
 * A sibling of `authFlow.ts` and built to the same contract: no React, no CSS,
 * no `supabase` import, no snake_case. Everything load-bearing about the two
 * new things a person can do — recover a forgotten password by email, and
 * change their own password while signed in — that can be decided from plain
 * values lives here so it is unit-testable under vitest with no browser and no
 * network, exactly as `attemptSignIn` is (see `authFlow.ts`'s header).
 *
 * FIVE things live here:
 *   1. `MIN_PASSWORD_LENGTH` / `passwordFormError` — the two-field new-password
 *      form validation (both fields match, a length floor) before a round trip.
 *   2. `nextRecoveryStatus` — the recovery-screen state machine: waiting for a
 *      recovery session, session present (ready), done, failed. A crafted or
 *      expired link must land on `failed`, never on a blank form.
 *   3. `parseRecoveryHash` — reads the tokens-or-error the auth redirect leaves
 *      in `window.location.hash`, as a plain value so it is testable.
 *   4. `describePasswordError` — turns a raw Supabase auth error from
 *      `updateUser` into a supervisor-readable sentence (the expired-link, weak-
 *      password and rate-limit branches the brief names), never a raw provider
 *      string. A SIBLING of `describeSignInError`, not a widening of it.
 *   5. `attemptReset` / `attemptChange` — run the two browser calls against any
 *      auth-like object and return a plain outcome, the way `attemptSignIn`
 *      does, so a fake drives them with no module mocking.
 */

import type { AuthErrorLike, SignInOutcome } from "./authFlow";

/* ===========================================================================
 * 1. THE NEW-PASSWORD FORM (two fields) — VALIDATION BEFORE A ROUND TRIP.
 * ======================================================================== */

/**
 * The minimum password length. `supabase/config.toml`'s `[auth]` block carries
 * no `minimum_password_length`, and Supabase's own default is 6, so that is the
 * number here. It is a NAMED constant, not a literal buried in a guard, so the
 * form, its error sentence and the tests all read the same value — and the day
 * the config grows a `minimum_password_length`, this is the one line to change.
 */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * A person-readable complaint about the new-password form, or `null` when it is
 * good enough to submit. Both a forgotten-password reset and a signed-in change
 * present the SAME two fields — a new password and its confirmation — so they
 * share this one validator.
 *
 * Order matters: an empty field is complained about before a short one, and a
 * short one before a mismatch, so the reader is told the first thing to fix
 * rather than the last.
 */
export function passwordFormError(
  password: string,
  confirm: string,
  minLength: number = MIN_PASSWORD_LENGTH,
): string | null {
  if (password.length === 0) return "Enter a new password.";
  if (password.length < minLength) {
    return `Your password must be at least ${minLength} characters.`;
  }
  if (confirm.length === 0) return "Re-enter your new password to confirm it.";
  if (password !== confirm) return "Those passwords do not match.";
  return null;
}

/* ===========================================================================
 * 2. THE RECOVERY-SCREEN STATE MACHINE.
 * ======================================================================== */

/**
 * The four states of the reset-password screen, in the order a person moves
 * through them:
 *
 *   waiting  The page has mounted but supabase-js has not yet read the tokens
 *            from the URL and established the recovery session. The form is NOT
 *            shown — submitting before the session exists would fail — so this
 *            renders a neutral "checking your link" line instead.
 *   ready    ⭐ The recovery session is present (`onAuthStateChange` fired
 *            `PASSWORD_RECOVERY`, or `getSession` already had it). The two-field
 *            form is shown and may be submitted.
 *   done     `updateUser` succeeded; the password is set and the person is
 *            signed in. The page hands off to the board.
 *   failed   ⚠️ The link itself is bad — expired, already used, or malformed —
 *            so no recovery session will ever arrive. This is a terminal screen
 *            offering a fresh "request a new link", NEVER a blank form that
 *            would submit into nothing.
 */
export type RecoveryStatus = "waiting" | "ready" | "done" | "failed";

/**
 * The events that move the recovery screen between states:
 *
 *   session-arrived  A recovery session now exists.
 *   link-error       The link carried an error, or no session arrived.
 *   password-set     `updateUser` succeeded.
 *
 * A transition that does not apply to the current state leaves it unchanged —
 * e.g. a stray `session-arrived` after `done` is a no-op, not a slide back to
 * `ready`.
 */
export type RecoveryEvent = "session-arrived" | "link-error" | "password-set";

export function nextRecoveryStatus(current: RecoveryStatus, event: RecoveryEvent): RecoveryStatus {
  switch (current) {
    case "waiting":
      if (event === "session-arrived") return "ready";
      if (event === "link-error") return "failed";
      return current;
    case "ready":
      if (event === "password-set") return "done";
      // ⚠️ A link-error while READY is a token that expired between landing and
      // submitting (or a used-once token): it too ends on the terminal screen.
      if (event === "link-error") return "failed";
      return current;
    // `done` and `failed` are terminal; nothing moves out of them.
    default:
      return current;
  }
}

/* ===========================================================================
 * 3. READING THE REDIRECT HASH.
 * ======================================================================== */

/**
 * What the auth redirect left in the URL fragment.
 *
 * On success the fragment carries the recovery tokens (`#access_token=…&
 * type=recovery&…`); supabase-js's `detectSessionInUrl` consumes them and fires
 * `PASSWORD_RECOVERY`. On failure it carries an error instead
 * (`#error=access_denied&error_code=otp_expired&error_description=…`) and no
 * session is ever established, so the page must read the error itself.
 *
 * PURE: it is handed the raw `location.hash` string and never touches the DOM,
 * so the branch that decides "this link is broken" is unit-testable.
 */
export type RecoveryHash =
  { kind: "recovery" } | { kind: "error"; code?: string; description?: string } | { kind: "none" };

export function parseRecoveryHash(hash: string | null | undefined): RecoveryHash {
  if (typeof hash !== "string") return { kind: "none" };
  // Both `#a=b&c=d` and `?a=b&c=d` and a bare `a=b` are tolerated.
  const raw = hash.replace(/^[#?]/, "");
  if (raw.length === 0) return { kind: "none" };
  const params = new URLSearchParams(raw);
  const error = params.get("error") ?? params.get("error_code");
  if (error) {
    return {
      kind: "error",
      code: params.get("error_code") ?? params.get("error") ?? undefined,
      description: params.get("error_description") ?? undefined,
    };
  }
  if (params.get("type") === "recovery" || params.has("access_token")) {
    return { kind: "recovery" };
  }
  return { kind: "none" };
}

/* ===========================================================================
 * 4. DESCRIBING A PASSWORD-UPDATE FAILURE.
 * ======================================================================== */

/**
 * Turn a raw Supabase auth error from `resetPasswordForEmail` or `updateUser`
 * into a supervisor-readable sentence — so neither the reset screen nor the
 * change screen ever shows a raw provider string (the `describeSignInError`
 * contract, one flow over).
 *
 * ⭐ A SIBLING, NOT A WIDENING. `describeSignInError` reads "invalid login
 * credentials"; these calls fail for entirely different reasons (an expired
 * recovery token, a password the server judges too weak, rate limiting), so
 * folding them into the sign-in describer would make one function answer two
 * unrelated questions. The branches, in the order they are checked:
 *
 *   weak password   `weak_password` / HTTP 422 / a "password is too short|weak"
 *                   message — the server's own strength rule, distinct from the
 *                   client length floor.
 *   rate limit      HTTP 429 / "rate limit" — the same sentence sign-in uses.
 *   expired link    `otp_expired` / HTTP 401 / 403 / 410 / an "expired" or
 *                   "session missing" message — a recovery token that is gone.
 *   otherwise       a generic sentence, never the raw string.
 */
export function describePasswordError(err: AuthErrorLike | null | undefined): string {
  const message = typeof err?.message === "string" ? err.message : "";
  const status = typeof err?.status === "number" ? err.status : undefined;
  const code = typeof err?.code === "string" ? err.code : "";

  // GoTrue answers 422 `same_password` when the new password is the current
  // one; it must not read as "too weak" (the reviewer saw exactly that).
  if (code === "same_password" || /should be different from the old/i.test(message)) {
    return "That is already your password. Choose a different one.";
  }
  if (
    code === "weak_password" ||
    status === 422 ||
    /password.*(weak|short|at least|should be)|weak.?password/i.test(message)
  ) {
    return "That password does not meet the requirements. Choose a longer or less common one.";
  }
  if (status === 429 || /rate limit|too many/i.test(message)) {
    return "Too many attempts. Please wait a moment and try again.";
  }
  if (
    code === "otp_expired" ||
    status === 401 ||
    status === 403 ||
    status === 410 ||
    /expired|session (missing|expired|not found)|invalid.*(link|token)/i.test(message)
  ) {
    return "That reset link has expired. Request a new one.";
  }
  return "Could not update your password. Please try again.";
}

/* ===========================================================================
 * 5. RUNNING THE TWO BROWSER CALLS.
 * ======================================================================== */

/**
 * The slice of `supabase.auth` the FORGOT-password request needs. Structural,
 * so the real client is assignable and a test passes a two-line fake — exactly
 * as `AuthLike` does for sign-in.
 */
export interface ResetRequestAuth {
  resetPasswordForEmail(
    email: string,
    options: { redirectTo: string },
  ): Promise<{ error: AuthErrorLike | null }>;
}

/** The slice of `supabase.auth` the SET-new-password and CHANGE calls need. */
export interface UpdateUserAuth {
  updateUser(attributes: { password: string }): Promise<{ error: AuthErrorLike | null }>;
}

/**
 * A minimal email complaint for the forgot form — the same lenient shape
 * `signInFormError` uses (an `@` with something on each side), because the
 * SERVER is the authority on whether an address exists and a regex that rejects
 * a real address is worse than a wasted round trip.
 */
function forgotEmailError(email: string): string | null {
  const trimmed = email.trim();
  if (trimmed.length === 0) return "Enter your email address.";
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return "Enter a valid email address.";
  return null;
}

/**
 * Request a reset email. Validates the address, then calls
 * `resetPasswordForEmail`. Returns a plain outcome — never throws, never leaks
 * a raw provider string.
 *
 * ⚠️ NEUTRALITY IS THE SERVER'S JOB, AND IT ALREADY DOES IT. Supabase returns
 * SUCCESS for an address with no account, precisely so the screen cannot leak
 * "no account with that email". So a successful outcome here means "we asked" —
 * the screen shows its neutral "if that address has an account…" sentence on
 * `ok`, whatever the truth of the address. Only a real failure (rate limiting,
 * the network) comes back `ok: false` with a described sentence.
 */
export async function attemptReset(
  auth: ResetRequestAuth,
  email: string,
  redirectTo: string,
): Promise<SignInOutcome> {
  const formError = forgotEmailError(email);
  if (formError !== null) return { ok: false, message: formError };
  try {
    const { error } = await auth.resetPasswordForEmail(email.trim(), { redirectTo });
    if (error) return { ok: false, message: describePasswordError(error) };
    return { ok: true, message: null };
  } catch (e) {
    return { ok: false, message: describePasswordError(e as AuthErrorLike) };
  }
}

/**
 * Set a new password — both for a signed-in change and for the final step of a
 * recovery, since both are the same `updateUser({ password })` call. Validates
 * the two-field form, then runs the call. Returns a plain outcome.
 */
export async function attemptChange(
  auth: UpdateUserAuth,
  password: string,
  confirm: string,
  minLength: number = MIN_PASSWORD_LENGTH,
): Promise<SignInOutcome> {
  const formError = passwordFormError(password, confirm, minLength);
  if (formError !== null) return { ok: false, message: formError };
  try {
    const { error } = await auth.updateUser({ password });
    if (error) return { ok: false, message: describePasswordError(error) };
    return { ok: true, message: null };
  } catch (e) {
    return { ok: false, message: describePasswordError(e as AuthErrorLike) };
  }
}
