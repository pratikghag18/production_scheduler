import { useMemo } from "react";
import { describeSchedulerError, isSchedulerError } from "@/lib/api";
import { DevProfileSwitcher } from "@/features/auth/DevProfileSwitcher";
import { useSession } from "@/features/auth/useSession";
import { useBoardWindow } from "./hooks/useBoardWindow";
import { BoardProof } from "./BoardProof";
import styles from "./BoardPage.module.css";

/** The seeded org's root node path (supabase/seed.sql: Plant 1 -> `plant_1`). */
const ORG_ROOT_PATH = "plant_1";

/**
 * Monday 00:00 UTC of the current week — matches supabase/seed.sql's own
 * anchor (`date_trunc('week', current_date)`, D10) so this panel's window
 * always covers the seeded runs regardless of when it's viewed.
 */
function mondayOfCurrentWeekUTC(): Date {
  const now = new Date();
  const truncated = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = truncated.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  truncated.setUTCDate(truncated.getUTCDate() - daysSinceMonday);
  return truncated;
}

/**
 * TEMPORARY data-proof panel (brief P1-3b §10). This is deliberately NOT
 * the board — no grid, no drag, no timeline. It exists so real Postgres
 * rows are visible in the browser, and so switching dev profiles visibly
 * changes what RLS returns (Admin 7 cells, Ana 5, Marco 2 — brief §11
 * acceptance items 2-3). P1-4 replaces this file (and BoardProof.tsx)
 * wholesale with the actual board.
 */
export default function BoardPage() {
  const { session, profile, loading: sessionLoading } = useSession();
  const weekStart = useMemo(() => mondayOfCurrentWeekUTC(), []);
  const weekEnd = useMemo(
    () => new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000),
    [weekStart],
  );

  const boardQuery = useBoardWindow(ORG_ROOT_PATH, weekStart, weekEnd);

  if (sessionLoading) {
    return <p>Loading session…</p>;
  }

  if (!session) {
    return (
      <div className={styles.panel}>
        <h1>Board (data proof — temporary)</h1>
        <p>Sign in with a dev profile to see schedule data.</p>
        <DevProfileSwitcher />
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <h1>Board (data proof — temporary)</h1>
        <DevProfileSwitcher />
      </div>
      {/* profile.role is shown alongside the signed-in user's email — the
          closest available stand-in for a "name": user_profiles carries no
          display-name column (database.types.ts). See the brief report's
          assumptions list. */}
      <p className={styles.who}>
        Signed in as <strong>{session.user.email}</strong>
        {profile ? ` — role: ${profile.role}` : ""}
      </p>

      {boardQuery.status === "pending" && <p>Loading board window…</p>}

      {boardQuery.status === "error" && (
        <p className={styles.error}>
          {isSchedulerError(boardQuery.error)
            ? describeSchedulerError(boardQuery.error)
            : "Something went wrong loading the board."}
        </p>
      )}

      {boardQuery.status === "success" && <BoardProof data={boardQuery.data} />}
    </div>
  );
}
