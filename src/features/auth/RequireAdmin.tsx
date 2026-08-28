import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { adminAccess } from "./session";
import { useSession } from "./useSession";

/**
 * D97 (design plan §19.38) — the admin screen is admin-only.
 *
 * Measured before this existed: there was NOT ONE role check anywhere in
 * `src/`. `/admin` was an ordinary route with no guard and an unconditional
 * nav link, so a supervisor's session loaded the hierarchy admin screen
 * fully populated — 1 structure, 4 levels, 8 nodes on the seeded data. Every
 * WRITE was correctly refused server-side (`not_permitted`), so nothing could
 * be damaged; the screen simply had no business being on their display.
 *
 * THIS IS A SECOND LOCK, NOT THE LOCK. The database is the authority and
 * always was: every admin RPC opens with `app_is_admin()`. This stops the
 * screen being rendered to someone who cannot use it — it is not what keeps
 * the data safe, and must never be treated as though it were.
 *
 * The `pending` branch renders the SAME "Loading…" as the route's Suspense
 * fallback on purpose, so an admin arriving directly sees one uninterrupted
 * loading state rather than a flash of refusal followed by the page.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { profile, loading } = useSession();
  const access = adminAccess(profile?.role, profile?.adminAnywhere, loading);

  if (access === "pending") return <p>Loading…</p>;

  if (access === "denied") {
    return (
      <>
        <h1>Not available</h1>
        <p>
          Admin settings are only available to administrators. If you need a change made to your
          site structure, ask an administrator.
        </p>
        <p>
          <Link to="/">Back to Board</Link>
        </p>
      </>
    );
  }

  return <>{children}</>;
}
