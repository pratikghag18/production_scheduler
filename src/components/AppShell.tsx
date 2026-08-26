import { NavLink, Outlet } from "react-router-dom";
import { HealthPill } from "@/components/HealthPill";
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
  const { profile, loading } = useSession();
  const canSeeAdmin = adminAccess(profile?.role, loading) === "granted";

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
      </header>
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
