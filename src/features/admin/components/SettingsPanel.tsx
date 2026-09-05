/* ---------------------------------------------------------------------------
   Settings — the company's answers, or one plant's, decided by the control at
   the top of the admin screen.

   ⭐⭐ THIS TAB FOLLOWS THE PLANT FILTER; IT DOES NOT LIST PLANTS (R-333).
   The maintainer, session 62: *"There is a filter at the top for selecting
   plants. Once we select the plant at the top we should be able to assign the
   settings to that particular plant, and it should be all types of settings on
   the settings tab, not just this one."*

   ⛔ THIS OVERRULES THE SHAPE R-331 SHIPPED, WHICH WAS MINE AND WAS WRONG.
   `AdminPage` has had ONE plant control since §19.77, and `ProductsPanel`,
   `ShiftsPanel` and `OperatorsPanel` all read it through `usePlantFilter`
   taking no props — "which plant am I showing" is a question the app answers
   once. Settings ignored that and grew a second answer: a card at the bottom
   with a row per plant, so a reader who had already narrowed the whole admin
   screen to Plant B still had to find Plant B again in a column. One control,
   two answers, and they could disagree. Deleted rather than kept beside the new
   one — a screen that offers two ways to say the same thing has to explain
   which one wins, and there is no good explanation.

   So: **a plant chosen at the top → this tab edits that plant. "All plants" →
   this tab edits the company defaults everything falls back to.** Which of the
   two is spelled out at the top of the tab in words, because a screen that
   silently edits a different scope depending on a control somewhere else is
   worse than one that lists everything. `settingsScope` in
   `../hooks/useOrgSettings.ts` is the rule, including the case where the plant
   control is not on screen at all, and carries the argument for it.

   ⭐ AND EVERY SETTING ON THE TAB IS PER-PLANT, not just the eligibility rule.
   The date format moved with it (migration 0052), which overrules 0050's stated
   reasoning that a display convention is not a plant's business. Both settings
   have the same three states — inheriting / set here to X / set here to Y — and
   `clear_node_setting` is the way back to the first.

   ⚠️ WHAT IS DELIBERATELY NOT HERE: `capacity_cap`, `week_start` and
   `default_snap_minutes`. They live in `orgs.settings` and have never had a
   control on this tab; giving them one is new product surface, not this task.
   Turning one on now costs a `WHEN` in each of migration 0052's two CHECK
   constraints, its key in both writers' key lists and one more `WHEN` in
   `set_node_setting`'s value CASE, a member of `NodeSettingKey`, a coercer
   beside `asDateFormat`, a field on `PlantOverrides`, and a third row here —
   plus, unlike the date format, a server-side READER to move onto
   `app_resolve_node_setting`, because all three of them are read by the
   functions that decide whether a write is allowed.

   ---------------------------------------------------------------------------
   THE TWO SETTINGS.

   The DATE-DISPLAY FORMAT (R-308-adjacent, settled Sep 3) decides how every
   calendar date the app shows as text reads. The underlying data stays ISO in
   the database; this only changes the rendering, through the seam in
   `src/lib/format/dates.ts`.

   The ELIGIBILITY POLICY (R-014, migration 0049) is a different KIND of
   setting: the date format changes what a screen looks like, this changes what
   the plant may do. It decides whether somebody who is not certified for a job
   can be scheduled onto it at all. The enforcement is not here and never was —
   `create_assignment` / `move_run` / `apply_split_coverage` resolve it on the
   server, per node, through `app_resolve_node_setting`. This panel is the
   switch, and the block above `POLICY_CHOICES` is about the only hard part of
   it, which is the wording.

   ⭐ ONE SETTING IS ONE ROW (R-320), AND THE ROW IS ONE SHARED DEFINITION
   (R-332). The layout comes from `@/components/SettingRow.module.css`: `.row`,
   `.text`, `.name`, `.hint`, `.control` and `.controlField`, with ONE
   control-column width shared by every setting on the screen. A third setting
   composes the same six classes and lands on the same column with nothing to
   decide. ⚠️ `src/test/settingRowStandard.test.ts` counts those classes against
   the number of `<select>`s in this file, so each setting must be ONE row with
   ONE control — which is why the company and per-plant variants of a row are
   the same `<select>` with different options, not two.

   ⭐ `SETTINGS_PANEL_READY` LIVES HERE, NOT IN `AdminPage.tsx`, exactly as the
   other panels' flags do. The rail entry reads it, so a section cannot be
   switched on without a panel behind it.

   ⚠️⚠️ A SITE ADMIN REACHES THIS PANE — `adminSectionsFor` returns "all" for
   anyone with `adminAnywhere === true`, and a site admin holds an admin GRANT.
   On the company scope they see both controls DISABLED with the reason in words
   (`set_org_date_format` and `set_org_eligibility_policy` are both
   `app_is_admin()`, so a live control there would silently do nothing); on
   THEIR OWN plant they get working pickers, because `set_node_setting`'s gate
   is `app_is_admin() or app_is_admin_for(node)`. On a plant they may READ but
   not administer they get no control at all and are told whose place it is —
   D106: a greyed control is a control named after something it does not do.
   --------------------------------------------------------------------------- */
import { useQuery } from "@tanstack/react-query";
import {
  describeSchedulerError,
  fetchHierarchyTree,
  type EligibilityPolicy,
  type SchedulerError,
} from "@/lib/api";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { DATE_FORMATS, formatCalendarDay, type DateFormat } from "@/lib/format/dates";
import {
  canAdministerPlant,
  INHERIT_CHOICE,
  settingsScope,
  useCompanyDateFormat,
  useCompanyEligibilityPolicy,
  usePlantOverrides,
  useSetDateFormat,
  useSetEligibilityPolicy,
  useSetPlantSetting,
} from "../hooks/useOrgSettings";
import { useEditRights } from "../hooks/useEditRights";
import { hierarchyKeys } from "../hooks/useHierarchyMutations";
import { usePlantFilter } from "../hooks/usePlantFilter";
import { notManagedNote } from "../lib/editRights";
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
   appears on this screen. They are the two tokens the setting accepts and they
   mean nothing to the person choosing between them: "warn" in particular does
   NOT mean "show a warning and carry on" — it means the placement is ALLOWED,
   on a typed reason that is then kept against the assignment for good. Somebody
   scanning a settings page and picking "Warn" because it sounded like the
   cautious one would have chosen the permissive option. So each choice is
   written as its CONSEQUENCE, and the consequence of the current choice is
   spelled out in full underneath the picker rather than hidden behind opening
   it.

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

/* ---------------------------------------------------------------------------
   THE SAME TWO ANSWERS, IN THREE WORDS INSTEAD OF TWELVE (R-331).

   `POLICY_CHOICES` above spells each answer as a sentence, which is right for a
   picker where the reader is deciding. A plant's rows have to name an answer
   INSIDE another sentence -- "Inheriting from the company - currently ..." --
   and a full clause there reads as gibberish. These are the same two answers,
   short enough to be a noun.

   ⛔ STILL NOT THE STORED WORDS. "Warn" reads as the cautious option and is the
   permissive one; that trap does not stop being a trap because the label got
   shorter. `src/test/settingsPanel.test.tsx` asserts neither bare token is
   offered on a plant row either.
   --------------------------------------------------------------------------- */
const POLICY_SHORT: Record<EligibilityPolicy, string> = {
  warn: "Allowed with a reason",
  block: "Refused",
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

/* ---------------------------------------------------------------------------
   THE STATE SENTENCE UNDER A PLANT'S PICKER.

   ⛔⛔ THREE STATES, NOT TWO, AND A PICKER WITH TWO OPTIONS CANNOT SAY THE
   FIRST. A plant is INHERITING (no `node_settings` row), or SET to one of the
   values. A control that showed only the resolved value would make every plant
   nobody has ever touched read as though somebody chose its current behaviour
   -- which is a lie that only shows up on the day the company changes its mind,
   when the untouched plants move and the deliberately-set ones do not.
   --------------------------------------------------------------------------- */
function inheritingNote(current: string): string {
  return (
    `Inheriting from the company — currently ${current}. ` +
    `Change the company answer and this plant follows.`
  );
}

function setHereNote(current: string, company: string): string {
  return (
    `Set for this plant — ${current}. The company is on ${company}, ` +
    `and this plant does not follow the company if that changes.`
  );
}

export function SettingsPanel() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  // Mirrors `app_is_admin()`, which is the gate on BOTH org-wide writers.
  const isSystemAdmin = profile?.role === "admin";
  const today = todayIso();

  /* -- which scope this tab is editing ---------------------------------- */

  // The SAME key `AdminPage`, `ProductsPanel` and `CycleTimesPanel` use, so
  // this costs one shared request and one cache entry rather than a fourth
  // round trip. ⚠️ IT FAILS OPEN WHEN THE READ FAILS: `allNodes` is then `[]`,
  // there are no readable roots, and `settingsScope` answers "company" — the
  // scope every reader can at least SEE, rather than an empty screen.
  const treeQuery = useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
    enabled: canQuery,
  });
  const plantFilter = usePlantFilter(treeQuery.data?.nodes ?? []);
  const scope = settingsScope(plantFilter.choice, plantFilter.plants, isSystemAdmin);
  const onPlant = scope.kind === "plant";

  const { rights } = useEditRights(canQuery, profile?.role ?? null);
  // ⚠️ NOT `canEditNode` — `useOrgSettings.ts` carries the whole argument. The
  // company scope's gate is `app_is_admin()`; a plant's is
  // `app_is_admin() or app_is_admin_for(node)`.
  const mayEdit = scope.kind === "company" ? isSystemAdmin : canAdministerPlant(scope.path, rights);
  // ⚠️ THE TWO REFUSALS ARE NOT THE SAME SHAPE, and the difference is D106's.
  // On the COMPANY scope a non-system-admin still sees the control, disabled,
  // with the reason: the setting exists and somebody can change it, just not
  // them. On a PLANT they may read but not administer there is NO control at
  // all — a greyed picker named after a plant is a control named after
  // something it does not do — and the tab says whose place it is instead. The
  // row still renders, with what is in force there, because dropping it
  // silently is `scope.ts`'s invisible-and-permanent failure.
  const showControl = scope.kind === "company" || mayEdit;

  /* -- what is set where ------------------------------------------------- */

  const companyFormat = useCompanyDateFormat(canQuery);
  const companyPolicy = useCompanyEligibilityPolicy(canQuery);
  // `null` on a field is INHERITING, and it is not the same as the resolved
  // value happening to equal the company's today.
  const own = usePlantOverrides(canQuery, scope.kind === "plant" ? scope.nodeId : null);

  const format = own.dateFormat ?? companyFormat;
  const policy = own.policy ?? companyPolicy;
  const currentPolicy = POLICY_CHOICES.find((c) => c.value === policy) ?? POLICY_CHOICES[0];

  /* -- the writers, and which row each in-flight write belongs to -------- */

  const setOrgFormat = useSetDateFormat();
  const setOrgPolicy = useSetEligibilityPolicy();
  // ⚠️ ONE MUTATION SERVES BOTH PLANT ROWS (a hook per row is not allowed), so
  // the in-flight and failed states have to be attributed to the SETTING they
  // belong to. React Query hands `variables` back; without this, the date
  // format saving would put "Saving…" under the eligibility rule too.
  const setPlant = useSetPlantSetting();
  const plantBusyKey = setPlant.isPending ? (setPlant.variables?.key ?? null) : null;
  const plantFailedKey = setPlant.isError ? (setPlant.variables?.key ?? null) : null;

  const formatBusy = onPlant ? plantBusyKey === "date_format" : setOrgFormat.isPending;
  const policyBusy = onPlant ? plantBusyKey === "eligibility_policy" : setOrgPolicy.isPending;
  const formatError: SchedulerError | null = onPlant
    ? plantFailedKey === "date_format"
      ? setPlant.error
      : null
    : setOrgFormat.isError
      ? setOrgFormat.error
      : null;
  const policyError: SchedulerError | null = onPlant
    ? plantFailedKey === "eligibility_policy"
      ? setPlant.error
      : null
    : setOrgPolicy.isError
      ? setOrgPolicy.error
      : null;

  /* -- one write, dispatched by scope ------------------------------------ */

  // ⚠️ THE GUARD IS NOT THE `disabled` ATTRIBUTE, and it is not the absence of
  // the control either. `disabled` is what a person meets; a change event can
  // still arrive without one (a test, an extension, a script), and the client
  // must refuse the write itself rather than rely on the server's refusal being
  // the only "no". The RPCs refuse it too.
  //
  // ⛔ `INHERIT_CHOICE` NEVER REACHES THE SERVER. `useSetPlantSetting`
  // dispatches it to `clear_node_setting`, the separate verb — there is no "set
  // to nothing" here because there is none on the server.
  function write(key: "date_format" | "eligibility_policy", value: string): void {
    if (!mayEdit) return;
    if (scope.kind === "plant") {
      setPlant.mutate({ nodeId: scope.nodeId, key, choice: value });
    } else if (key === "date_format") {
      setOrgFormat.mutate(value as DateFormat);
    } else {
      setOrgPolicy.mutate(value as EligibilityPolicy);
    }
  }

  /* -- the sentence that says which scope this is ------------------------ */

  const scopeTitle = onPlant ? scope.name : "Company defaults";
  const scopeLead = onPlant
    ? `These are ${scope.name}'s own answers. A setting left on “Use the company setting” follows ` +
      `the company and moves when the company's answer moves.`
    : "These are the answers every plant follows unless it has been given its own.";
  // ⭐ AND HOW TO GET TO THE OTHER ONE. The control is one screen up, so the tab
  // names it rather than assuming the reader connects the two. Omitted when
  // there is no control (`plantFilter.visible` is false below two readable
  // roots) — pointing at a control that is not on screen is worse than silence.
  const scopeSwitch = !plantFilter.visible
    ? null
    : onPlant
      ? "Choose “All plants” in Showing, at the top, to edit the company defaults instead."
      : "Choose a plant in Showing, at the top, to give that plant its own answers.";

  return (
    <div className={styles.panel}>
      <section className={styles.card}>
        <h2 className={styles.h2}>{scopeTitle}</h2>
        <p className={styles.lead}>
          {scopeLead}
          {scopeSwitch !== null && ` ${scopeSwitch}`}
        </p>
        {treeQuery.isError && (
          <p className={styles.status} role="alert">
            Couldn&rsquo;t load which plants you can see, so this is showing the company defaults.
            Try refreshing the page.
          </p>
        )}
        {own.isLoading && <p className={styles.status}>Loading this plant&rsquo;s settings…</p>}
        {own.error !== null && <p className={styles.error}>{describeSchedulerError(own.error)}</p>}
        {onPlant && !mayEdit && <p className={styles.status}>{notManagedNote(scope.name)}</p>}
      </section>

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
            {/* ⭐ ONE `<select>`, TWO OPTION LISTS. The company scope offers the
                eight formats; a plant offers those plus "use the company
                setting" FIRST, which is both the third state and the way back
                to it. Two `<select>` elements here would break the row audit's
                count and would be two bindings to keep in step. */}
            {showControl && (
              <select
                id="settings-date-format"
                className={`${fieldStyles.select} ${rowStyles.controlField}`}
                value={onPlant ? (own.dateFormat ?? INHERIT_CHOICE) : companyFormat}
                disabled={!mayEdit || formatBusy}
                onChange={(e) => write("date_format", e.target.value)}
              >
                {/* ⭐ THE OPTION CARRIES THE COMPANY'S CURRENT ANSWER IN ITS OWN
                    LABEL, so a closed control on an inheriting plant reads "Use
                    the company setting (currently Day Month Year — 03/09/2026)".
                    The state and what it currently means are both visible
                    without opening anything. */}
                {onPlant && (
                  <option value={INHERIT_CHOICE}>
                    Use the company setting (currently {FORMAT_LABEL[companyFormat]} —{" "}
                    {formatCalendarDay(today, companyFormat)})
                  </option>
                )}
                {/* ⭐ THE SAMPLE IS IN THE OPTION. A reader picks a format by
                    what they will actually see, not by a token's name, so each
                    option reads "Day/Month/Year — 03/09/2026". */}
                {DATE_FORMATS.map((fmt) => (
                  <option key={fmt} value={fmt}>
                    {FORMAT_LABEL[fmt]} — {formatCalendarDay(today, fmt)}
                  </option>
                ))}
              </select>
            )}
            {onPlant && (
              <p className={styles.consequence}>
                {own.dateFormat === null
                  ? inheritingNote(FORMAT_LABEL[format])
                  : setHereNote(FORMAT_LABEL[format], FORMAT_LABEL[companyFormat])}
              </p>
            )}
            {!onPlant && !mayEdit && (
              <p className={styles.status}>Only a system admin can change the date format.</p>
            )}
            {formatBusy && <p className={styles.status}>Saving…</p>}
            {formatError !== null && (
              <p className={styles.error}>{describeSchedulerError(formatError)}</p>
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
            {showControl && (
              <select
                id="settings-eligibility-policy"
                className={`${fieldStyles.select} ${rowStyles.controlField}`}
                value={onPlant ? (own.policy ?? INHERIT_CHOICE) : companyPolicy}
                disabled={!mayEdit || policyBusy}
                onChange={(e) => write("eligibility_policy", e.target.value)}
              >
                {onPlant && (
                  <option value={INHERIT_CHOICE}>
                    Use the company setting (currently {POLICY_SHORT[companyPolicy]})
                  </option>
                )}
                {POLICY_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            )}
            {/* The consequence of what is IN FORCE here, in full and unopened —
                the picker's own label is a summary and this is what it means. */}
            <p className={styles.consequence}>
              {onPlant
                ? own.policy === null
                  ? inheritingNote(POLICY_SHORT[policy])
                  : setHereNote(POLICY_SHORT[policy], POLICY_SHORT[companyPolicy])
                : currentPolicy.consequence}
            </p>
            {onPlant && <p className={styles.consequence}>{currentPolicy.consequence}</p>}
            {!onPlant && !mayEdit && (
              <p className={styles.status}>Only a system admin can change this.</p>
            )}
            {policyBusy && <p className={styles.status}>Saving…</p>}
            {policyError !== null && (
              <p className={styles.error}>{describeSchedulerError(policyError)}</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
