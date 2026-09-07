import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { attemptReset } from "./lib/passwordFlow";
import styles from "./ForgotPasswordPage.module.css";
import fieldStyles from "@/components/Field.module.css";

/**
 * The forgotten-password request screen (roadmap P1-6d, S24). One email field
 * calling `supabase.auth.resetPasswordForEmail`, living OUTSIDE the app shell
 * and OUTSIDE the auth gate at `/forgot-password`, reached from a link on
 * `/sign-in`. Browser-only, no server piece — the same shape as the sign-in
 * screen.
 *
 * ⭐ THE NEUTRAL SENTENCE IS THE WHOLE POINT. On a successful request the screen
 * says "If that address has an account, a reset link is on its way." — the SAME
 * sentence whether or not the address has an account, because "no account with
 * that email" is a leak. Supabase makes that possible by returning success for
 * an unknown address; `attemptReset` relays that `ok` unchanged, so this screen
 * never learns, and so cannot reveal, which it was. Only a real failure (rate
 * limiting, the network) shows a described error instead.
 *
 * The reset link lands on `/reset-password` — `window.location.origin` so it
 * works whether the app is served from `localhost` or `127.0.0.1`.
 */
const SENT_SENTENCE = "If that address has an account, a reset link is on its way.";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const outcome = await attemptReset(
      supabase.auth,
      email,
      window.location.origin + "/reset-password",
    );
    if (!outcome.ok) {
      setError(outcome.message);
      setSubmitting(false);
      return;
    }
    // Success — which, by design, tells us nothing about whether the address
    // exists. Show the neutral sentence and stop offering the form.
    setSent(true);
    setSubmitting(false);
  }

  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.title}>Reset your password</h1>

        {sent ? (
          <>
            <p className={styles.sent} role="status">
              {SENT_SENTENCE}
            </p>
            <p className={styles.back}>
              <Link to="/sign-in">Back to sign in</Link>
            </p>
          </>
        ) : (
          <>
            <p className={styles.subtitle}>
              Enter your email address and we&rsquo;ll send you a link to set a new password.
            </p>

            <form className={styles.form} onSubmit={onSubmit}>
              <div className={styles.field}>
                <label htmlFor="forgot-email" className={styles.label}>
                  Email
                </label>
                <input
                  id="forgot-email"
                  className={fieldStyles.field}
                  type="email"
                  autoComplete="username"
                  value={email}
                  disabled={submitting}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              {error && (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              )}

              <button
                type="submit"
                className={`${fieldStyles.primaryBtn} ${styles.submit}`}
                disabled={submitting}
              >
                {submitting ? "Sending…" : "Send reset link"}
              </button>
            </form>

            <p className={styles.back}>
              <Link to="/sign-in">Back to sign in</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
