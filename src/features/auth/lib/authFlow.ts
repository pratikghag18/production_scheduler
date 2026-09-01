/**
 * The production front door's PURE half (roadmap P1-6b).
 *
 * Dependency-free by design — no React, no CSS, no `supabase`, no
 * snake_case. Everything load-bearing about the sign-in flow that can be
 * decided from plain values lives here so it is unit-testable under vitest
 * with no browser and no network, exactly as `src/features/admin/lib/*` do
 * (see `siteAccess.ts`'s header for the same contract).
 *
 * FOUR things live here:
 *   1. `sanitizeRedirect` — the open-redirect guard. THE security-critical
 *      one: a crafted `?redirect=` must never send a signed-in user off-site.
 *   2. `decideAuthScreen` — session state -> which screen to render. The
 *      "signed in but no profile in this org" dead-end is a REAL state (see
 *      its own note), not a hypothetical, and it must not loop.
 *   3. `signInFormError` — client-side form validation before a round trip.
 *   4. `attemptSignIn` / `describeSignInError` — run a sign-in against any
 *      auth-like object and turn a failure into a person-readable sentence
 *      rather than a raw Supabase string (brief's error contract, §4 of
 *      `src/lib/api/errors.ts`: UI code never assembles error prose from a
 *      raw provider error itself).
 */

/* ===========================================================================
 * 1. THE OPEN-REDIRECT GUARD.
 * ======================================================================== */

/**
 * Reduce an untrusted `?redirect=` value to a SAME-ORIGIN, in-app path, or to
 * `/` when it is anything else.
 *
 * ⚠️ SECURITY-CRITICAL, AND THE ONE FUNCTION HERE THAT MUST FAIL CLOSED. After
 * a successful sign-in the app navigates to whatever this returns; if it ever
 * returned an absolute or protocol-relative URL, a link like
 * `/sign-in?redirect=//evil.com` would bounce a freshly-authenticated user
 * onto an attacker's page (the classic open-redirect). So the ONLY thing
 * allowed through is a path that starts with a single `/` and cannot be
 * re-read by a browser as a host:
 *
 *   - must start with `/`                     (root-relative)
 *   - second char is neither `/` nor `\`      (`//host` and `/\host` are both
 *                                              protocol-relative to a browser)
 *   - no control chars / whitespace           (a `\n` or NUL can defeat naive
 *                                              downstream checks)
 *   - not `/sign-in` itself                    (redirecting back to the door
 *                                              after signing in is an infinite
 *                                              bounce — fall back to `/`)
 *
 * Anything else collapses to `/`. Query string and hash on an otherwise-valid
 * path are kept, so `/admin?x=1#y` survives intact.
 */
export function sanitizeRedirect(raw: string | null | undefined): string {
  const FALLBACK = "/";
  if (typeof raw !== "string" || raw.length === 0) return FALLBACK;
  // Root-relative only. A bare path, never a `http://…`, `mailto:` or
  // `javascript:` — none of those start with `/`.
  if (raw[0] !== "/") return FALLBACK;
  // `//host` and `/\host` are protocol-relative: a browser resolves both to a
  // different origin. The second character is what separates them from a real
  // path like `/admin`.
  if (raw[1] === "/" || raw[1] === "\\") return FALLBACK;
  // Control characters and whitespace have no place in an in-app path and are
  // exactly what is used to smuggle a second line past a naive check. Covers
  // NUL..space (0x00-0x20) and DEL (0x7f).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(raw)) return FALLBACK;
  // Never redirect back to the sign-in screen itself — that is the infinite
  // loop. Compare only the path portion, before any `?` or `#`.
  const pathOnly = raw.split(/[?#]/, 1)[0];
  if (pathOnly === "/sign-in") return FALLBACK;
  return raw;
}

/* ===========================================================================
 * 2. WHICH SCREEN TO SHOW.
 * ======================================================================== */

export type AuthScreen = "loading" | "sign-in" | "no-access" | "app";

export interface AuthState {
  /** `useSession`'s `loading`. Starts true with no identity resolved yet. */
  loading: boolean;
  /** Is there an authenticated Supabase session? */
  hasSession: boolean;
  /** Did `useSession` find a `user_profiles` row for that session? */
  hasProfile: boolean;
}

/**
 * FOUR states, in this order, because collapsing any pair is a real bug.
 *
 *   loading   -> "loading"    Nothing is known yet; both boolean answers below
 *                             are premature (this is the same three-state
 *                             discipline `adminAccess` uses — a guess here
 *                             bounces a real user or flashes a screen).
 *   no session -> "sign-in"   The production door. RequireAuth turns this into
 *                             a redirect that remembers where they were going.
 *   session, no profile -> "no-access"
 *                             ⭐ THE DEAD-END, AND IT IS REAL, NOT HYPOTHETICAL.
 *                             `user_profiles` is UNIQUE ON (org_id, user_id),
 *                             not user_id (see `useSession`'s `.maybeSingle()`),
 *                             so an authenticated user with no row IN THIS
 *                             workspace legitimately loads a null profile. That
 *                             must NOT redirect to /sign-in — they ARE signed
 *                             in, so the gate would send them straight back and
 *                             loop forever. It renders a plain page offering
 *                             Sign out instead.
 *   otherwise -> "app"        Signed in, has a profile: render the app.
 */
export function decideAuthScreen(state: AuthState): AuthScreen {
  if (state.loading) return "loading";
  if (!state.hasSession) return "sign-in";
  if (!state.hasProfile) return "no-access";
  return "app";
}

/* ===========================================================================
 * 3. FORM VALIDATION (before any round trip).
 * ======================================================================== */

/**
 * A person-readable complaint about the sign-in form, or `null` when it is
 * good enough to submit.
 *
 * Deliberately lenient on the email shape — the SERVER is the authority on
 * whether an address exists, and a regex that rejects a real address the
 * server would accept is worse than a wasted round trip. This only catches the
 * obviously-empty and the obviously-not-an-address, so the button does
 * something sensible before we bother the network.
 */
export function signInFormError(email: string, password: string): string | null {
  const trimmed = email.trim();
  if (trimmed.length === 0) return "Enter your email address.";
  // The one structural fact every email shares: an `@` with something on each
  // side of it. Not a full RFC 5322 matcher on purpose (see above).
  const at = trimmed.indexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return "Enter a valid email address.";
  if (password.length === 0) return "Enter your password.";
  return null;
}

/* ===========================================================================
 * 4. RUNNING THE SIGN-IN AND DESCRIBING A FAILURE.
 * ======================================================================== */

/** The one raw auth-error shape this module reads. Kept minimal so the test
 *  can hand in a plain object and the real `AuthError` is assignable to it. */
export interface AuthErrorLike {
  message?: string;
  status?: number;
  code?: string;
}

/**
 * The slice of `supabase.auth` this flow needs. Structural, so the real client
 * is assignable and a test can pass a two-line fake — this is what "mock
 * supabase.auth" means here, with no module mocking required.
 */
export interface AuthLike {
  signInWithPassword(credentials: {
    email: string;
    password: string;
  }): Promise<{ error: AuthErrorLike | null }>;
}

export interface SignInOutcome {
  ok: boolean;
  /** Present (a person-readable sentence) only when `ok` is false. */
  message: string | null;
}

/**
 * Turn a raw Supabase auth error into a supervisor-readable sentence, so the
 * sign-in screen never shows a raw provider string (which leaks internals and
 * reads like a stack trace). Mirrors `describeSchedulerError`'s job for the
 * data layer.
 *
 * The markers are English message text / HTTP status, the same signals
 * `toSchedulerError` leans on. If a marker ever stops matching, this falls back
 * to the generic sentence rather than to a raw string.
 */
export function describeSignInError(err: AuthErrorLike | null | undefined): string {
  const message = typeof err?.message === "string" ? err.message : "";
  const status = typeof err?.status === "number" ? err.status : undefined;

  // The overwhelmingly common one: wrong email or password. Supabase returns
  // "Invalid login credentials" with status 400. Say it without revealing
  // WHICH half was wrong — telling an attacker "the email exists" is a leak.
  if (status === 400 || /invalid login credentials/i.test(message)) {
    return "That email or password is not correct.";
  }
  if (/email not confirmed/i.test(message)) {
    return "Your email address has not been confirmed yet. Check your inbox for the confirmation link.";
  }
  // Rate limiting.
  if (status === 429 || /rate limit|too many/i.test(message)) {
    return "Too many attempts. Please wait a moment and try again.";
  }
  return "Could not sign you in. Please try again.";
}

/**
 * Validate the form, then run the sign-in against any `AuthLike`. Returns a
 * plain outcome — never throws, never leaks a raw provider string.
 *
 * Kept here rather than in the component so the whole decision (validate ->
 * call -> describe the failure) is one testable unit that a fake auth object
 * drives directly.
 */
export async function attemptSignIn(
  auth: AuthLike,
  email: string,
  password: string,
): Promise<SignInOutcome> {
  const formError = signInFormError(email, password);
  if (formError !== null) return { ok: false, message: formError };
  try {
    const { error } = await auth.signInWithPassword({ email: email.trim(), password });
    if (error) return { ok: false, message: describeSignInError(error) };
    return { ok: true, message: null };
  } catch (e) {
    // A network failure rejects rather than returning `{ error }`.
    return { ok: false, message: describeSignInError(e as AuthErrorLike) };
  }
}
