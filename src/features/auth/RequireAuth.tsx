import { Navigate, Outlet, useLocation } from "react-router-dom";
import { decideAuthScreen } from "./lib/authFlow";
import { SignOutButton } from "./SignOutButton";
import { useSession } from "./useSession";
import styles from "./RequireAuth.module.css";

/**
 * The route gate for every protected route (roadmap P1-6b). A layout route:
 * renders the app (`<Outlet />`) only for a signed-in user WITH a profile,
 * and otherwise stands in the right screen. The four outcomes are decided by
 * the pure `decideAuthScreen` (see its note for why the order matters).
 *
 * ⭐ WHY THIS AND NOT `RequireAdmin`'S SHAPE. `RequireAdmin` guards ONE route
 * and renders a refusal in place. This guards the whole app and, for the
 * signed-out case, must both redirect AND remember where the visitor was
 * going — so it is a layout route wrapping the shell, not a per-route wrapper.
 *
 * ⚠️ THE `redirect` PARAM IS SANITISED AT THE READING END, in `SignInPage` via
 * `sanitizeRedirect`, NOT here. Here we only WRITE our own current path into
 * it, which is trusted; the untrusted read is the one that navigates, and that
 * is where the open-redirect guard belongs.
 */
export function RequireAuth() {
  const { session, profile, loading } = useSession();
  const location = useLocation();

  const screen = decideAuthScreen({
    loading,
    hasSession: session !== null,
    hasProfile: profile !== null,
  });

  if (screen === "loading") {
    // The same "Loading…" the admin route's Suspense/RequireAdmin shows, so an
    // arriving user sees one uninterrupted loading state, not a flash.
    return <p>Loading…</p>;
  }

  if (screen === "sign-in") {
    // Remember where they were going so sign-in can send them back. `pathname`
    // + `search` is a same-origin in-app path by construction; `SignInPage`
    // still re-sanitises it before using it.
    const from = `${location.pathname}${location.search}`;
    return <Navigate to={`/sign-in?redirect=${encodeURIComponent(from)}`} replace />;
  }

  if (screen === "no-access") {
    // ⭐ THE REAL DEAD-END, NOT A REDIRECT. `user_profiles` is unique on
    // (org_id, user_id), so an authenticated user can legitimately have NO row
    // in this workspace — `useSession`'s `.maybeSingle()` comes back empty.
    // Redirecting to /sign-in would loop (they are already signed in), so this
    // is a plain terminal page that offers the one thing that helps: Sign out.
    return (
      <div className={styles.screen}>
        <div className={styles.card}>
          <h1 className={styles.title}>No access in this workspace</h1>
          <p className={styles.body}>
            You&rsquo;re signed in, but this account isn&rsquo;t set up with access to this
            workspace yet. Ask an administrator to add you, or sign out and try a different account.
          </p>
          <div className={styles.actions}>
            <SignOutButton />
          </div>
        </div>
      </div>
    );
  }

  return <Outlet />;
}
