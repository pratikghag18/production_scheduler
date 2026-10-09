import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { attemptChange, MIN_PASSWORD_LENGTH } from "./lib/passwordFlow";
import styles from "./ChangePasswordPage.module.css";
import fieldStyles from "@/components/Field.module.css";

/**
 * Change your own password while signed in (roadmap P1-6d, S24). A small page
 * INSIDE the app shell, reached from the "Change password" link in the header
 * next to Sign out. Two new-password fields calling
 * `supabase.auth.updateUser({ password })` — the same browser call the reset
 * screen's final step makes, so it shares `attemptChange` and its describer.
 *
 * ⚠️ THE PERSON STAYS SIGNED IN. `updateUser` refreshes the tokens for the same
 * user, so `onAuthStateChange` fires a same-identity event the session provider
 * treats as a no-op — no cache reset, no redirect. On success this shows a
 * sentence and leaves them exactly where they were; it never navigates.
 */
export default function ChangePasswordPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const outcome = await attemptChange(supabase.auth, password, confirm, MIN_PASSWORD_LENGTH);
    if (!outcome.ok) {
      setError(outcome.message);
      setSubmitting(false);
      return;
    }
    // Changed, and still signed in. Clear the fields and say so.
    setPassword("");
    setConfirm("");
    setDone(true);
    setSubmitting(false);
  }

  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.title}>Change password</h1>
        <p className={styles.subtitle}>
          Set a new password for your account. You&rsquo;ll stay signed in.
        </p>

        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.field}>
            <label htmlFor="change-password" className={styles.label}>
              New password
            </label>
            <input
              id="change-password"
              className={fieldStyles.field}
              type="password"
              autoComplete="new-password"
              value={password}
              disabled={submitting}
              onChange={(e) => {
                setPassword(e.target.value);
                setDone(false);
              }}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="change-password-confirm" className={styles.label}>
              Confirm new password
            </label>
            <input
              id="change-password-confirm"
              className={fieldStyles.field}
              type="password"
              autoComplete="new-password"
              value={confirm}
              disabled={submitting}
              onChange={(e) => {
                setConfirm(e.target.value);
                setDone(false);
              }}
            />
          </div>

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          {done && (
            <p className={styles.done} role="status">
              Your password has been changed.
            </p>
          )}

          <button
            type="submit"
            className={`${fieldStyles.primaryBtn} ${styles.submit}`}
            disabled={submitting}
          >
            {submitting ? "Saving…" : "Change password"}
          </button>
        </form>

        <p className={styles.back}>
          <Link to="/">Back to the board</Link>
        </p>
      </div>
    </div>
  );
}
