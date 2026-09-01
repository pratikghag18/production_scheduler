import { NavLink, Outlet } from "react-router-dom";
import { HealthPill } from "@/components/HealthPill";
import { SignOutButton } from "@/features/auth/SignOutButton";
import { adminAccess } from "@/features/auth/session";
import { useSession } from "@/features/auth/useSession";
import styles from "./AppShell.module.css";

export function AppShell() {
  const navLinkClassName = ({ isActive }: { isActive: boolean }) =>
    isActive ? `${styles.active}` : undefined;

  // D97 (§19.38): the link and the route ask the SAME function. A nav link
  // that disagrees with its own route is how someone ends up staring at a
  // link that refuses them. Rendered only on "granted" -- during "pending"
  // it stays hidden, so the failure mode is a link appearing a moment late
  // for an admin, never one shown briefly to everyone else.
  const { session, profile, loading } = useSession();
  const canSeeAdmin = adminAccess(profile?.role, profile?.adminAnywhere, loading) === "granted";

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.title}>Production Scheduler</h1>
        <nav className={styles.nav}>
          <NavLink to="/" end className={navLinkClassName}>
            Board
          </NavLink>
          {canSeeAdmin && (
            <NavLink to="/admin" className={navLinkClassName}>
              Admin
            </NavLink>
          )}
        </nav>
        <div className={styles.health}>
          <HealthPill />
        </div>
        {/* P1-6b: the real, non-DEV identity + sign-out, near the health pill
            on the right of the chrome. `DevProfileSwitcher` still handles
            identity SWITCHING in a dev build (rendered inside BoardPage); this
            is the production door out that any signed-in user can reach. */}
        <div className={styles.identity}>
          {session?.user.email && <span className={styles.email}>{session.user.email}</span>}
          <SignOutButton />
        </div>
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
