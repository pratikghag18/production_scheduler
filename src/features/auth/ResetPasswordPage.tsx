import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import {
  attemptChange,
  describePasswordError,
  MIN_PASSWORD_LENGTH,
  nextRecoveryStatus,
  parseRecoveryHash,
  type RecoveryStatus,
} from "./lib/passwordFlow";
import styles from "./ResetPasswordPage.module.css";
import fieldStyles from "@/components/Field.module.css";

/**
 * The set-a-new-password screen a reset email lands on (roadmap P1-6d, S24).
 * Lives OUTSIDE the app shell and OUTSIDE the auth gate at `/reset-password`.
 *
 * ⚠️⚠️ IT MUST SIT OUTSIDE `RequireAuth`, AND IT MUST NOT NAVIGATE ITSELF AWAY
 * UNTIL THE PASSWORD IS SET. supabase-js reads the recovery tokens from the URL
 * hash (`detectSessionInUrl`) and establishes a SESSION — a real one. So the
 * person arriving here IS signed in, which means:
 *   - inside `RequireAuth` the gate would send them to the board (or the
 *     no-access dead-end) before they ever saw this form — hence the route sits
 *     beside `/sign-in`, outside the gate; and
 *   - this page must have NO "navigate once a session exists" effect of the kind
 *     `SignInPage` carries, or it would bounce itself the same way. It navigates
 *     only after `updateUser` succeeds.
 *
 * The recovery lifecycle is the pure `nextRecoveryStatus` machine
 * (`passwordFlow.ts`): `waiting` until the recovery session lands, `ready` with
 * the form shown, `done` once the password is set (hand off to the board),
 * `failed` for a link that expired, was used, or was malformed — a terminal
 * screen offering a fresh link, never a blank form that submits into nothing.
 */
/**
 * Did we arrive from an INVITE rather than a password reset? Read from the
 * landing hash's `type=invite` (P1-6c). Only the COPY differs — the recovery
 * lifecycle, the gate and `updateUser` are identical, because an invite owes a
 * password exactly as a reset does. Captured in the `useState` initializer so
 * it is read at first render, the same point the recovery hash is still present
 * (supabase-js consumes it on a later tick); when the F-106 redirect drops the
 * tokens on `/` and the gate forwards here without the hash, this reads false
 * and the copy falls back to the reset wording, which is a safe default.
 */
function landedFromInvite(): boolean {
  if (typeof window === "undefined") return false;
  return /(^#|[&#])type=invite(&|$)/.test(window.location.hash ?? "");
}

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [fromInvite] = useState(landedFromInvite);
  const [status, setStatus] = useState<RecoveryStatus>("waiting");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failedMessage, setFailedMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Resolve where the recovery link left us: a good link carries tokens the
  // client turns into a session (and fires PASSWORD_RECOVERY); a bad one carries
  // an error in the hash and no session ever arrives. This effect runs once.
  useEffect(() => {
    let active = true;
    const hash = parseRecoveryHash(window.location.hash);

    if (hash.kind === "error") {
      setFailedMessage(
        describePasswordError({ code: hash.code, message: hash.description ?? undefined }),
      );
      setStatus((s) => nextRecoveryStatus(s, "link-error"));
      return;
    }

    // A recovery session may arrive via the auth event (PASSWORD_RECOVERY, or an
    // INITIAL_SESSION/SIGNED_IN that already carries it once the hash is read).
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY" || session) {
        setStatus((s) => nextRecoveryStatus(s, "session-arrived"));
      }
    });

    // …and it may already be present by the time this runs. If it is not, and
    // there were no tokens in the URL to wait for, the link is not a real
    // recovery link (a bare visit, or a stale one) — say so rather than sit on
    // "checking" forever.
    void supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      if (data.session) {
        setStatus((s) => nextRecoveryStatus(s, "session-arrived"));
      } else if (hash.kind === "none") {
        setFailedMessage("This reset link is invalid or has expired. Request a new one.");
        setStatus((s) => nextRecoveryStatus(s, "link-error"));
      }
      // hash.kind === "recovery" with no session yet: the tokens are still being
      // read; wait for the auth event above.
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting || status !== "ready") return;
    setSubmitting(true);
    setError(null);
    const outcome = await attemptChange(supabase.auth, password, confirm, MIN_PASSWORD_LENGTH);
    if (!outcome.ok) {
      setError(outcome.message);
      setSubmitting(false);
      return;
    }
    // Set, and the recovery session is now a full session — hand off to the
    // board. `RequireAuth` decides board vs no-access from there.
    setStatus("done");
    navigate("/", { replace: true });
  }

  return (
    <div className={styles.screen}>
      <div className={styles.card}>
        <h1 className={styles.title}>{fromInvite ? "Set your password" : "Set a new password"}</h1>

        {fromInvite && status === "ready" && (
          <p className={styles.subtitle}>Welcome — choose a password to finish joining.</p>
        )}

        {status === "failed" && (
          <>
            <p className={styles.error} role="alert">
              {failedMessage ?? "That reset link has expired. Request a new one."}
            </p>
            <p className={styles.back}>
              <Link to="/forgot-password">Request a new link</Link>
            </p>
          </>
        )}

        {status === "waiting" && (
          <p className={styles.subtitle} role="status">
            Checking your reset link…
          </p>
        )}

        {status === "ready" && (
          <form className={styles.form} onSubmit={onSubmit}>
            <div className={styles.field}>
              <label htmlFor="reset-password" className={styles.label}>
                New password
              </label>
              <input
                id="reset-password"
                className={fieldStyles.field}
                type="password"
                autoComplete="new-password"
                value={password}
                disabled={submitting}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <div className={styles.field}>
              <label htmlFor="reset-password-confirm" className={styles.label}>
                Confirm new password
              </label>
              <input
                id="reset-password-confirm"
                className={fieldStyles.field}
                type="password"
                autoComplete="new-password"
                value={confirm}
                disabled={submitting}
                onChange={(e) => setConfirm(e.target.value)}
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
              {submitting ? "Setting…" : "Set password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
