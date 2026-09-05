/* ---------------------------------------------------------------------------
   Settings — the system admin's org-wide preferences.

   The first setting is the DATE-DISPLAY FORMAT (R-308-adjacent, settled Sep 3):
   one choice, made once for the whole company, that decides how every calendar
   date the app shows as text reads. The underlying data stays ISO in the
   database; this only changes the rendering, through the seam in
   `src/lib/format/dates.ts`.

   The second is the ELIGIBILITY POLICY (R-014, migration 0049), and it is a
   different KIND of setting: the date format changes what a screen looks like,
   this changes what the plant may do. It decides whether somebody who is not
   certified for a job can be scheduled onto it at all. The enforcement is not
   here and never was -- `create_assignment` / `move_run` /
   `apply_split_coverage` read `orgs.settings->>'eligibility_policy'` on the
   server and `CreatePopover` mirrors them on the board. What was missing until
   0049 was any way to CHANGE it: `orgs.settings` had exactly one write function
   (`set_org_date_format`), so every org sat on the 0001 default of "warn". This
   panel is that switch, and the block above `POLICY_CHOICES` is about the only
   hard part of it, which is the wording.

   ⭐ ONE SETTING IS ONE ROW (R-320, settled Sep 3). The eight formats were eight
   radio rows, which is most of a screen spent on one preference; as more
   settings land here that layout crowds them out. Each setting is now a labelled
   row -- name and hint on the left, one control on the right -- so a second
   setting is another row, not another screenful. A closed enum picks with a
   `<select>`; a toggle or a number would sit in the same slot.

   ⭐ AND THE ROW IS ONE SHARED DEFINITION (R-332). The rows were laid out by
   this section's own stylesheet, as a flex box whose control column was
   `flex: 0 0 auto` -- sized by its own content, so the eligibility picker and
   the date picker sat on two different edges and the maintainer said so. The
   layout now comes from `@/components/SettingRow.module.css`: `.row`, `.text`,
   `.name`, `.hint`, `.control` and `.controlField`, with ONE control-column
   width shared by every setting on the screen. A third setting composes the
   same six classes and lands on the same column with nothing to decide.

   ⭐ THE PICKER IS THE SHARED FIELD (R-318), `Field.module.css`'s `.select`,
   not a copy of the skin: this stylesheet came off `FIELD_LEGACY` in the same
   commit, because the block that put it there was the radio row this replaced.

   ⭐ THE SAMPLE MOVED INTO THE OPTIONS. The radio list showed a live sample
   beside every format at once, which is how a reader picks one -- by what they
   will actually see, not by a token's name. Each `<option>` therefore reads
   "Day/Month/Year -- 03/09/2026", so the closed control shows the sample for the
   current choice and opening it shows all eight. Nothing is lost by collapsing.

   ⭐ `SETTINGS_PANEL_READY` LIVES HERE, NOT IN `AdminPage.tsx`, exactly as the
   other panels' flags do. The rail entry reads it, so a section cannot be
   switched on without a panel behind it.

   ⚠️ THIS SECTION IS SYSTEM-ADMIN ONLY, and `AdminPage.tsx` is what hides it
   from a site admin (whose `adminSectionsFor` would otherwise return "all"). The
   gate here is the belt to that suspenders: the server RPC `set_org_date_format`
   refuses a non-admin regardless (migration 0037), so a site admin who reached
   this pane by any means sees the setting DISABLED and is told why -- never a
   control that silently does nothing.

   DECIDES NOTHING ITSELF about how a date renders: every token maps to a string
   in `src/lib/format/dates.ts`, which is pure and is what `src/test/dateFormat.
   test.ts` tests. This file offers the choice and shows a live sample.
   --------------------------------------------------------------------------- */
import { describeSchedulerError, type EligibilityPolicy } from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { DATE_FORMATS, formatCalendarDay, type DateFormat } from "@/lib/format/dates";
import {
  useDateFormat,
  useEligibilityPolicy,
  useSetDateFormat,
  useSetEligibilityPolicy,
} from "../hooks/useOrgSettings";
import fieldStyles from "@/components/Field.module.css";
import rowStyles from "@/components/SettingRow.module.css";
import styles from "./SettingsPanel.module.css";

/** Read by `AdminPage`'s rail, the same way `TRAININGS_PANEL_READY` is. */
export const SETTINGS_PANEL_READY = true;

/** The human label for each format, shown with a live sample beside it. */
const FORMAT_LABEL: Record<DateFormat, string> = {
  d_mon_yyyy: "Day Month Year",
  dmy_slash: "Day/Month/Year",
  mdy_slash: "Month/Day/Year",
  iso: "ISO (Year-Month-Day)",
  dmy_dash_mon: "Day-Mon-Year",
  d_month_yyyy: "Day Month Year (full)",
  month_d_yyyy: "Month Day, Year",
  ymd_slash: "Year/Month/Day",
};

/* ---------------------------------------------------------------------------
   THE ELIGIBILITY POLICY, IN WORDS (R-014; the switch arrived with migration
   0049, the enforcement had shipped long before).

   ⛔ "WARN" AND "BLOCK" ARE THE DATABASE'S WORDS, NOT A READER'S, and neither
   appears on this screen. They are the two tokens `orgs.settings.
   eligibility_policy` accepts and they mean nothing to the person choosing
   between them: "warn" in particular does NOT mean "show a warning and carry
   on" — it means the placement is ALLOWED, on a typed reason that is then kept
   against the assignment for good. Somebody scanning a settings page and
   picking "Warn" because it sounded like the cautious one would have chosen the
   permissive option. So each choice is written as its CONSEQUENCE, and the
   consequence of the current choice is spelled out in full underneath the
   picker rather than hidden behind opening it.

   This is a decision about how a plant behaves — whether an uncertified person
   can be put on a job at all — so the cost of a reader guessing wrong is not a
   cosmetic one. `src/test/settingsPanel.test.tsx` asserts that neither bare
   word is offered as a label.
   --------------------------------------------------------------------------- */
interface PolicyChoice {
  value: EligibilityPolicy;
  /** What the option says in the closed control. */
  label: string;
  /** What actually happens, shown for whichever choice is current. */
  consequence: string;
}

const POLICY_CHOICES: readonly PolicyChoice[] = [
  {
    value: "warn",
    label: "Allow it, with a reason on record",
    consequence:
      "A planner can still put someone on a job they are not certified for, but only by ticking an " +
      "override and typing why. The reason is saved with the assignment, so anyone reading the " +
      "schedule later can see who was placed without the training and on whose word.",
  },
  {
    value: "block",
    label: "Refuse it — no exceptions",
    consequence:
      "The assignment is refused. There is no override to tick and no reason that gets past it — " +
      "the person cannot be scheduled onto that job until their training is on record.",
  },
];

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

  const policy = useEligibilityPolicy(canQuery);
  const setPolicy = useSetEligibilityPolicy();
  const currentPolicy = POLICY_CHOICES.find((c) => c.value === policy) ?? POLICY_CHOICES[0];

  return (
    <div className={styles.panel}>
      <section className={styles.card}>
        <h2 className={styles.h2}>Display</h2>

        <div className={rowStyles.row}>
          <div className={rowStyles.text}>
            <label className={rowStyles.name} htmlFor="settings-date-format">
              Date format
            </label>
            <p className={rowStyles.hint}>
              How dates read across the app — training expiry, records and more. Data is stored the
              same way regardless; this only changes what is shown.
            </p>
          </div>

          <div className={rowStyles.control}>
            <select
              id="settings-date-format"
              className={`${fieldStyles.select} ${rowStyles.controlField}`}
              value={current}
              disabled={!isSystemAdmin || setFormat.isPending}
              onChange={(e) => {
                // ⚠️ THE GUARD IS NOT THE `disabled` ATTRIBUTE. `disabled` is
                // what a person meets; a change event can still arrive without
                // one (a test, an extension, a script), and the client must
                // refuse the write itself rather than rely on the server's
                // refusal to be the only "no". The RPC refuses it too.
                if (!isSystemAdmin) return;
                setFormat.mutate(e.target.value as DateFormat);
              }}
            >
              {DATE_FORMATS.map((fmt) => (
                <option key={fmt} value={fmt}>
                  {FORMAT_LABEL[fmt]} — {formatCalendarDay(today, fmt)}
                </option>
              ))}
            </select>
            {!isSystemAdmin && (
              <p className={styles.status}>Only a system admin can change the date format.</p>
            )}
            {setFormat.isPending && <p className={styles.status}>Saving…</p>}
            {setFormat.isError && (
              <p className={styles.error}>{describeSchedulerError(setFormat.error)}</p>
            )}
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <h2 className={styles.h2}>Scheduling</h2>

        <div className={rowStyles.row}>
          <div className={rowStyles.text}>
            <label className={rowStyles.name} htmlFor="settings-eligibility-policy">
              Putting someone on a job they are not certified for
            </label>
            <p className={rowStyles.hint}>
              Jobs can require training, and the board knows who holds it. This decides what happens
              when a planner picks someone who does not.
            </p>
          </div>

          <div className={rowStyles.control}>
            <select
              id="settings-eligibility-policy"
              className={`${fieldStyles.select} ${rowStyles.controlField}`}
              value={policy}
              disabled={!isSystemAdmin || setPolicy.isPending}
              onChange={(e) => {
                // ⚠️ THE GUARD IS NOT THE `disabled` ATTRIBUTE — the same
                // reasoning as the date picker above, and it matters more here:
                // the server refuses a non-admin either way (migration 0049),
                // so a change that slipped through would be a control that
                // silently does nothing about how the plant is scheduled.
                if (!isSystemAdmin) return;
                setPolicy.mutate(e.target.value as EligibilityPolicy);
              }}
            >
              {POLICY_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
            {/* The consequence of the CURRENT choice, in full and unopened —
                the picker's own label is a summary and this is what it means. */}
            <p className={styles.consequence}>{currentPolicy.consequence}</p>
            {!isSystemAdmin && (
              <p className={styles.status}>Only a system admin can change this.</p>
            )}
            {setPolicy.isPending && <p className={styles.status}>Saving…</p>}
            {setPolicy.isError && (
              <p className={styles.error}>{describeSchedulerError(setPolicy.error)}</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
