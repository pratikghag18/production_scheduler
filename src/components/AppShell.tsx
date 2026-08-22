import { NavLink, Outlet } from "react-router-dom";
import { HealthPill } from "@/components/HealthPill";
import styles from "./AppShell.module.css";

export function AppShell() {
  const navLinkClassName = ({ isActive }: { isActive: boolean }) =>
    isActive ? `${styles.active}` : undefined;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.title}>Production Scheduler</h1>
        <nav className={styles.nav}>
          <NavLink to="/" end className={navLinkClassName}>
            Board
          </NavLink>
          <NavLink to="/admin" className={navLinkClassName}>
            Admin
          </NavLink>
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
