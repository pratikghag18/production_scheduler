/* ---------------------------------------------------------------------------
   ACTIVITY — the audit log, read for the first time.

   ⭐⭐ EVERY CHANGE WAS ALREADY RECORDED AND NOTHING SHOWED IT. `write_audit_log`
   has been on `runs` and `assignments` since migration 0007 and on `products`,
   `operators`, `skills` and `shift_templates` since 0029 §6, capturing the WHOLE
   row as jsonb on every insert, update and delete. `audit_log` appeared in
   `src/` only as a generated type. This is the screen.

   ⭐⭐ IT IS A COMPANY ADMIN'S SCREEN AND NOBODY ELSE'S, AND THAT IS THE
   POLICY'S DECISION, NOT THIS FILE'S. `audit_log_select` (0008) is
   `app_is_admin() and org_id = app_current_org()`, and `app_is_admin()` is
   `user_profiles.role = 'admin'` (0018) — the ORG-WIDE role. A SITE admin
   carries the org-wide role `viewer` plus an admin grant, so for them this read
   returns ZERO ROWS: no error, no refusal, an empty list that reads exactly like
   *"nothing has ever changed here"*. **That is the quietest possible form of the
   failure `CLAUDE.md` §4 names.** So there are two gates and they test the same
   predicate the policy does: `AdminPage`'s `companyAdminOnly` hides the tab (as
   it does for Settings, and for the same reason `adminSectionsFor` cannot
   express this — it returns "all" for any site admin), and the gate below stops
   the query and says why to anyone who reaches this pane by another route.

   ⭐⭐ AND IT NEVER CLAIMS TO BE SHOWING MORE THAN IT IS. PostgREST caps every
   response at `max_rows = 1000`; before `src/lib/api/audit.ts` there was no
   paging anywhere in `src/lib/api/`, because every other read is of a catalogue
   with a natural size. An audit log has none — it grows by one row per write,
   forever, and is the first table here that will pass a thousand. Fetching
   "everything" would silently show the newest thousand changes and go on calling
   that the history. So it pages (keyset, on `id`; see the api file for why not
   `.range()`), and the footer states in words which of the two states it is in:
   more to load, or the whole log.

   ⚠️ THE FOUR OMITTED COLUMNS ARE NAMED ON SCREEN. `id`, `org_id`, `created_at`
   and `updated_at` are left out of every change list — `updated_at` moves on
   every single update (`set_updated_at`, 0003), which is why `write_audit_log`
   itself subtracts it before deciding whether anything changed. Omitting them is
   defensible; omitting them SILENTLY, in a log, is not.

   ⚠️ THE ACTOR LOOKUP IS ALLOWED TO FAIL. It is a decoration on one column; the
   changes are the screen. It is a separate query for exactly that reason.

   ⚠️ `AUDIT_PANEL_READY` LIVES HERE, not in `AdminPage.tsx`, exactly as every
   other panel's flag does: a section cannot be switched on without a panel
   behind it.

   DECIDES NOTHING ITSELF about what a change SAYS: every sentence on this screen
   comes out of `src/features/admin/lib/auditView.ts`, which is pure and is what
   `src/test/auditView.test.ts` tests. This file holds layout and the two gates.
   --------------------------------------------------------------------------- */
import { useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query";
import {
  describeSchedulerError,
  fetchAuditActors,
  fetchAuditPage,
  type AuditPage,
  type SchedulerError,
} from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { useDateFormat } from "../hooks/useOrgSettings";
import {
  OMITTED_FIELDS,
  describeActor,
  describeEntry,
  formatInstant,
  type AuditFieldChange,
} from "../lib/auditView";
import styles from "./AuditPanel.module.css";

/** Read by `AdminPage`'s rail, the same way `SETTINGS_PANEL_READY` is. */
export const AUDIT_PANEL_READY = true;

/** Stable identity so an empty roles map never re-renders the list. */
const NO_ACTORS: ReadonlyMap<string, string> = new Map();

export const auditKeys = {
  all: ["audit-log"] as const,
  actors: ["audit-log", "actors"] as const,
};

/** One field that moved, as one line. A missing side is left out rather than
 *  rendered as a dash: on an insert there IS no before, and "— → WX-1" invites
 *  the reader to wonder what the dash means. */
function ChangeLine({ change }: { change: AuditFieldChange }) {
  return (
    <li className={styles.change}>
      <span className={styles.field}>{change.label}</span>
      {change.before !== null && <span className={styles.from}>{change.before}</span>}
      {change.before !== null && change.after !== null && (
        <span className={styles.arrow} aria-hidden="true">
          →
        </span>
      )}
      {change.after !== null && <span className={styles.to}>{change.after}</span>}
    </li>
  );
}

export function AuditPanel() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  // ⚠️ THE CLIENT MIRROR OF `app_is_admin()`, not a looser rule of this screen's
  // own. Same expression `AdminPage` filters `companyAdminOnly` on.
  const isCompanyAdmin = profile?.role === "admin";
  const enabled = canQuery && isCompanyAdmin;
  const fmt = useDateFormat(canQuery);

  /* ⚠️ THE ERROR TYPE IS SPELLED OUT, and it is not decoration. `fetchAuditPage`
     throws through `toSchedulerError`, so every failure here IS a
     `SchedulerError` — but React Query's default error generic is `Error`, and
     `describeSchedulerError` (which switches on `kind`) would then be handed a
     type it cannot read. Same explicit-generic contract `useOrgSettings` keeps. */
  const log = useInfiniteQuery<
    AuditPage,
    SchedulerError,
    InfiniteData<AuditPage>,
    typeof auditKeys.all,
    number | null
  >({
    queryKey: auditKeys.all,
    queryFn: ({ pageParam }) => fetchAuditPage(pageParam),
    initialPageParam: null as number | null,
    // ⚠️ THE CURSOR IS THE LAST ID ON SCREEN, never a row offset — a change
    // landing while somebody reads moves every offset by one, so offset paging
    // repeats a row on one page and skips one on the next. See the api file.
    getNextPageParam: (last) =>
      last.hasMore && last.entries.length > 0
        ? last.entries[last.entries.length - 1].id
        : undefined,
    enabled,
  });

  // Separate on purpose: this one may fail without taking the log with it.
  const actors = useQuery({
    queryKey: auditKeys.actors,
    queryFn: fetchAuditActors,
    enabled,
  });
  const roles = actors.data ?? NO_ACTORS;
  const viewerUserId = profile?.userId ?? null;

  /* ⭐ THE GATE, AND IT SAYS WHY. An empty list would be a lie here: the log is
     not empty, it is filtered to nothing by a policy this person does not
     satisfy. Same contract `SettingsPanel` keeps for its disabled control. */
  if (profile != null && !isCompanyAdmin) {
    return (
      <div className={styles.panel}>
        <p className={styles.status}>
          Only a system admin can read the activity log. Your account administers places rather than
          the whole company, so the record of changes is not yours to read — this is decided by the
          database, not by this screen.
        </p>
      </div>
    );
  }

  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];
  /* ⚠️⚠️ `!canQuery || …` — NOT `log.isPending` ALONE, and this is D91 a third
     time. With `enabled: false` React Query v5 reports `isPending` with
     `fetchStatus: "idle"`, so the pending flag is FALSE for the whole window in
     which the session is still resolving. Narrowing this to the query's own flag
     renders the EMPTY branch for a beat — and this screen's empty branch is the
     sentence *"Nothing has been changed yet."*, which is a claim about the
     company, made before a single row has been asked for. Same condition
     `AdminPage` spells out for its own read. */
  const showLoading = !canQuery || log.isPending;

  return (
    <div className={styles.panel}>
      <p className={styles.intro}>
        Every change to a run, an assignment, a person, a product, a training or a shift pattern,
        newest first. Times are shown in your own timezone.
      </p>
      {/* ⚠️ NAMED, NOT HIDDEN — see the header. Built from the list itself so the
          sentence cannot drift from what is actually left out. */}
      <p className={styles.note}>
        Four bookkeeping columns are never listed: {OMITTED_FIELDS.join(", ")}. Everything else the
        row carried is shown.
      </p>

      {log.isError && (
        <p className={styles.error} role="alert">
          Couldn&rsquo;t load the activity log — {describeSchedulerError(log.error)}. Nothing is
          missing from the record; this screen failed to read it. Try refreshing the page.
        </p>
      )}

      {showLoading && <p className={styles.status}>Loading…</p>}

      {/* ⚠️ AN EMPTY LOG AND A FAILED READ MUST NOT SHARE A SENTENCE: one is a
          fact about the company, the other is worth retrying. */}
      {!showLoading && !log.isError && entries.length === 0 && (
        <p className={styles.status}>Nothing has been changed yet.</p>
      )}

      {entries.length > 0 && (
        <>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col" className={styles.th}>
                    When
                  </th>
                  <th scope="col" className={styles.th}>
                    Who
                  </th>
                  <th scope="col" className={styles.th}>
                    What
                  </th>
                  <th scope="col" className={styles.th}>
                    Change
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const line = describeEntry(e, fmt);
                  return (
                    <tr key={e.id} className={styles.row}>
                      <td className={styles.when}>{formatInstant(e.at, fmt)}</td>
                      <td className={styles.who}>
                        {describeActor(e.actorId, viewerUserId, roles)}
                      </td>
                      <td className={styles.what}>
                        <span className={styles.headline}>{line.headline}</span>
                        <span className={styles.subject}>{line.subject}</span>
                      </td>
                      <td className={styles.changes}>
                        {line.changes.length === 0 ? (
                          <span className={styles.muted}>No listed field changed.</span>
                        ) : (
                          <ul className={styles.changeList}>
                            {line.changes.map((c) => (
                              <ChangeLine key={c.field} change={c} />
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ⭐⭐ THE SCREEN STATES ITS OWN COMPLETENESS. The count is the number
              of rows actually rendered, so the sentence cannot drift from the
              list it describes, and the two states are worded so they cannot be
              confused for one another. */}
          {log.hasNextPage ? (
            <div className={styles.footer}>
              <p className={styles.status}>
                Showing the most recent {entries.length} change
                {entries.length === 1 ? "" : "s"}. There are older ones.
              </p>
              <button
                type="button"
                className={styles.more}
                disabled={log.isFetchingNextPage}
                onClick={() => void log.fetchNextPage()}
              >
                {log.isFetchingNextPage ? "Loading…" : "Load older changes"}
              </button>
            </div>
          ) : (
            <div className={styles.footer}>
              <p className={styles.status}>
                Showing the most recent {entries.length} change
                {entries.length === 1 ? "" : "s"} — this is the whole log.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
