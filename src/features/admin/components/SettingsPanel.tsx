/* ---------------------------------------------------------------------------
   Settings — the system admin's org-wide preferences.

   The first setting is the DATE-DISPLAY FORMAT (R-308-adjacent, settled Sep 3):
   one choice, made once for the whole company, that decides how every calendar
   date the app shows as text reads. The underlying data stays ISO in the
   database; this only changes the rendering, through the seam in
   `src/lib/format/dates.ts`.

   ⭐ `SETTINGS_PANEL_READY` LIVES HERE, NOT IN `AdminPage.tsx`, exactly as the
   other panels' flags do. The rail entry reads it, so a section cannot be
   switched on without a panel behind it.

   ⚠️ THIS SECTION IS SYSTEM-ADMIN ONLY, and `AdminPage.tsx` is what hides it
   from a site admin (whose `adminSectionsFor` would otherwise return "all"). The
   gate here is the belt to that suspenders: the server RPC `set_org_date_format`
   refuses a non-admin regardless (migration 0037), so a site admin who reached
   this pane by any means would see it, not be able to save, and be told why —
   never a control that silently does nothing.

   DECIDES NOTHING ITSELF about how a date renders: every token maps to a string
   in `src/lib/format/dates.ts`, which is pure and is what `src/test/dateFormat.
   test.ts` tests. This file offers the choice and shows a live sample.
   --------------------------------------------------------------------------- */
import { describeSchedulerError } from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { DATE_FORMATS, formatCalendarDay, type DateFormat } from "@/lib/format/dates";
import { useDateFormat, useSetDateFormat } from "../hooks/useOrgSettings";
import styles from "./SettingsPanel.module.css";

/** Read by `AdminPage`'s rail, the same way `TRAININGS_PANEL_READY` is. */
export const SETTINGS_PANEL_READY = true;

/** The human label beside each format's live sample. */
const FORMAT_LABEL: Record<DateFormat, string> = {
  d_mon_yyyy: "Day Month Year",
  dmy_slash: "Day/Month/Year",
  mdy_slash: "Month/Day/Year",
  iso: "ISO (Year-Month-Day)",
};

/** Today as `YYYY-MM-DD` in LOCAL time — the same reasoning as OperatorsPanel's
 *  `todayIso`: `toISOString().slice(0,10)` is the UTC day and is a day out west
 *  of Greenwich. This is date construction, not display formatting, so it is not
 *  a seam concern. */
function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function SettingsPanel() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  const isSystemAdmin = profile?.role === "admin";

  const current = useDateFormat(canQuery);
  const setFormat = useSetDateFormat();
  const today = todayIso();

  return (
    <div className={styles.panel}>
      <section className={styles.card}>
        <h2 className={styles.h2}>Date format</h2>
        <p className={styles.hint}>
          How dates read across the app — training expiry, records and more. Data is stored the same
          way regardless; this only changes what is shown.
        </p>

        {isSystemAdmin ? (
          <>
            <div className={styles.options} role="radiogroup" aria-label="Date format">
              {DATE_FORMATS.map((fmt) => {
                const selected = fmt === current;
                return (
                  <button
                    key={fmt}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={
                      selected ? `${styles.option} ${styles.optionSelected}` : styles.option
                    }
                    disabled={setFormat.isPending || selected}
                    onClick={() => setFormat.mutate(fmt)}
                  >
                    <span>{FORMAT_LABEL[fmt]}</span>
                    <span className={styles.sample}>{formatCalendarDay(today, fmt)}</span>
                  </button>
                );
              })}
            </div>
            {setFormat.isPending && <p className={styles.status}>Saving…</p>}
            {setFormat.isError && (
              <p className={styles.error}>{describeSchedulerError(setFormat.error)}</p>
            )}
          </>
        ) : (
          <p className={styles.status}>Only a system admin can change the date format.</p>
        )}
      </section>
    </div>
  );
}
