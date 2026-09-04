import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { DevProfileSwitcher } from "./DevProfileSwitcher";
import { useSession } from "./useSession";
import { attemptSignIn, sanitizeRedirect } from "./lib/authFlow";
import styles from "./SignInPage.module.css";

/**
 * The production front door (roadmap P1-6b). An email + password form calling
 * `supabase.auth.signInWithPassword`, living OUTSIDE the app shell (no
 * rail/nav) at `/sign-in`.
 *
 * ⭐ THIS IS THE PRODUCTION DOOR; `DevProfileSwitcher` IS THE DEV ONE, AND BOTH
 * COEXIST. In a dev build the switcher is rendered below the form (self-gated
 * on `import.meta.env.DEV`) so the one-click dev sign-in that every local
 * drive and test relies on still works from this screen. In a production build
 * `DevProfileSwitcher` returns null and only the real form remains.
 *
 * REDIRECT: `RequireAuth` sends a signed-out visitor here with a
 * `?redirect=<where they were going>`. On a successful sign-in we go there —
 * but only through `sanitizeRedirect`, so a crafted `?redirect=//evil.com`
 * can never bounce a freshly-authenticated user off-site (the open-redirect
 * guard). The navigation itself is driven by the session landing, not by the
 * sign-in call resolving: an effect fires once `useSession` reports a session,
 * which also covers the case of arriving here ALREADY signed in (a stray link,
 * or a second tab) — that just forwards straight to the target.
 */
export default function SignInPage() {
  const { session, loading } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const target = sanitizeRedirect(params.get("redirect"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Once a session exists (whether from submitting the form or from arriving
  // already signed in), leave for the sanitized target. `replace` so the
  // sign-in screen is not left in history behind the app.
  useEffect(() => {
    if (!loading && session) {
      navigate(target, { replace: true });
    }
  }, [loading, session, target, navigate]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const outcome = await attemptSignIn(supabase.auth, email, password);
    if (!outcome.ok) {
      setError(outcome.message);
      setSubmitting(false);
      return;
    }
    // Success: the effect above navigates once the session lands. Leave
    // `submitting` true so the form stays disabled through the hand-off.
  }

  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.title}>Production Scheduler</h1>
        <p className={styles.subtitle}>Sign in to continue.</p>

        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.field}>
            <label htmlFor="sign-in-email" className={styles.label}>
              Email
            </label>
            <input
              id="sign-in-email"
              className={styles.input}
              type="email"
              autoComplete="username"
              value={email}
              disabled={submitting}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="sign-in-password" className={styles.label}>
              Password
            </label>
            <input
              id="sign-in-password"
              className={styles.input}
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={submitting}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          <button type="submit" className={styles.submit} disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {/* Dev-only sign-in, self-gated on `import.meta.env.DEV`. Renders
            nothing in a production build. Kept on this screen so the dev door
            and the production door share one place while signed out. */}
        {import.meta.env.DEV && (
          <div className={styles.devZone}>
            <span className={styles.devNote}>Dev sign-in (local only):</span>
            <DevProfileSwitcher />
          </div>
        )}
      </div>
    </div>
  );
}
