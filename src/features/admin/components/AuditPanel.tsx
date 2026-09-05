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

   ⭐⭐⭐ THE FILTERS ARE THE SAME PROBLEM WEARING A DISGUISE, AND THEY ARE THE
   EASIEST PLACE ON THIS SCREEN TO SHIP A LIE.

   A filter applied to rows already fetched is not a filter on the log. Fifty
   rows read might hold three removals, and an honest-looking footer beneath —
   *"showing 3 removals"* — would be a count of the removals that happen to sit
   in the newest fifty rows, presented as a count of the company's removals. On
   a busy company it is an EMPTY LIST under the word "removals", which a reader
   will quite reasonably take to mean nothing has ever been deleted. That is
   strictly worse than offering no filter at all, because a missing feature is
   visible and a wrong answer is not.

   ⭐⭐⭐ SO THE FILTER IS IN THE QUERY, AND THAT IS WHAT MAKES THE FOOTER'S
   ARITHMETIC TRIVIAL RATHER THAN CLEVER. `fetchAuditPage` takes the period,
   the action and the kind of thing and sends `.gte("at", …)`, `.lt("at", …)`
   and `.in(…)`. A page is therefore fifty MATCHES, and `hasMore` — still
   measured by asking for one row more than the page shows — means *"there are
   older rows that MATCH"*. The scan and the match are the same number now, and
   the whole footer rests on one server-computed boolean:

       searchComplete === !hasNextPage

   ⭐ WHY THAT IS SOUND, IN ONE LINE: `hasNextPage` is false exactly when the
   server, applying the same predicate the list was drawn from, found no row
   older than the cursor that satisfies it. There is then nothing unread that
   could match — so "all" is a statement about the FILTERED SET, which is what
   the reader is looking at, and it needs no argument about ordering at all.

   ⚠️⚠️ AND THE ARGUMENT IT REPLACED WAS WEAKER THAN IT LOOKED. The old proof
   was: the read is newest-first on `id`, every period ends at NOW, so the
   period's rows are a PREFIX of the scan and one row older than the cutoff
   proves the rest cannot match. That silently assumed `at` rises with `id`. It
   does not always: `at` is the TRANSACTION's start time, two rows written in
   one transaction share it exactly, and a long transaction can commit — taking
   a later `id` — after a shorter one that started later. One such row inside
   the period, sitting below a row outside it, and the old screen would have
   said "the whole of the last 7 days has been searched" with that change
   unread. The predicate in the query has no such assumption: `id < cursor` is
   a boundary and the filter is a test on each row, and neither depends on the
   other.

   ⚠️ WHICH IS ALSO WHY A PERIOD WITH BOTH ENDS CAN BE OFFERED NOW —
   "Yesterday", "last month". Such a period is a MIDDLE slice of the log and can
   never be a prefix of anything, which is exactly why the old screen refused to
   offer one. The server does not care where the slice sits.

   ⚠️ AND THE SELF-READ IS GONE WITH IT. The panel used to page towards the
   period's floor by itself, up to ten requests, because that walk was the only
   way to earn the word "all". The first page now carries the proof, so a chosen
   period costs ONE request; ten would be ten pages of matches nobody asked to
   see. What is left is the ordinary "load older" button, which means what it
   says: there are more MATCHES.

   ⚠️ THE KIND PICKER REMEMBERS WHAT IT HAS SEEN, and that is a consequence of
   the same change rather than a nicety. The list of kinds is built from rows
   actually read — never a hand-written list of table names, because the audited
   set is decided by triggers on the database and grew by four in one migration.
   Once the SERVER narrows, the rows read under "Products" are all products, so
   a picker rebuilt from them would offer "Products" alone and leave the reader
   no control to undo the filter with.

   ⭐ A DELETION IS VISIBLE AT A GLANCE, AND NOT BY COLOUR ALONE. The maintainer
   read the struck-through fields of a delete row as damage — which is fair,
   because a strikethrough means "this value was replaced" and on a delete every
   field carries one at once. So each row gets a coloured left accent keyed to
   its action (added / changed / removed, red reserved for removed) BESIDE the
   word already in the What column, never instead of it: the row still reads
   correctly to a colour-blind reader and in a black-and-white print. All three
   actions get an accent rather than deletions alone, so a reader learns one
   system instead of one exception; and the per-field strikethrough is switched
   off inside a delete, where it is redundant once the row says "deleted", and
   kept for an edit, where it is doing real work.

   ⚠️ THE FOUR OMITTED COLUMNS ARE NAMED ON SCREEN. `id`, `org_id`, `created_at`
   and `updated_at` are left out of every change list — `updated_at` moves on
   every single update (`set_updated_at`, 0003), which is why `write_audit_log`
   itself subtracts it before deciding whether anything changed. Omitting them is
   defensible; omitting them SILENTLY, in a log, is not.

   ⚠️ THE ACTOR LOOKUP IS ALLOWED TO FAIL. It is a decoration on one column; the
   changes are the screen. It is a separate query for exactly that reason.

   ⭐⭐⭐ AND THE PLANT FILTER IS THE SAME PROBLEM A THIRD TIME, WEARING THE
   HARDEST DISGUISE OF ALL. The maintainer: *"in the activity tab, the filter to
   select the plant is not doing anything."* It was not: this file never called
   `usePlantFilter`, so `AdminPage`'s one plant control sat above a list of the
   whole company with a header chip naming one plant. It does now — and the
   whole difficulty is that **`audit_log` has no place column**. See
   `src/lib/api/audit.ts` for the measured shape of every snapshot; the two
   facts that decide this screen are:

     · a `products` row carries NO place at all (0034 moved a product's plants
       into `product_sites`, and a deleted product's links are gone too), and
     · **64 of the 201 attributable rows in the live database name a node that
       no longer exists** — a rebuilt seed, a deleted line. An audit row
       outliving its place is the audit log working, not failing.

   ⭐⭐⭐ SO THE RULE IS A COMPLEMENT AND IT IS DELIBERATE: a change is hidden
   only when every place it names is a place the company still has and none of
   them is in the chosen plant. A change that names no place, and a change whose
   place has been removed, are shown under EVERY plant — and are MARKED on the
   row, so nobody reads one as a Plant A change. Over-showing a log is a
   nuisance; hiding is deleting evidence, and 95 rows quietly leaving every
   plant's view under a footer saying "the whole log has been searched" is the
   worst version of this screen's one failure mode.

   ⚠️⚠️ AND IT IS IN THE QUERY, LIKE THE OTHER THREE. A plant filter applied to
   rows already fetched would put back exactly the lie the paragraphs above
   describe: `hasMore` would mean "the log has more rows" and say nothing about
   whether any of them could be Plant A's. `fetchAuditPage` sends the clause, so
   a page is still fifty MATCHES and `searchComplete === !lastPage.hasMore` is
   still the whole proof, unchanged.

   ⚠️ THE ONE PLACE IT GIVES UP, AND IT SAYS SO ON SCREEN. The clause repeats
   the id list once per snapshot column and Kong caps a request line at 8 KB —
   measured with a whole real page request beside it, not assumed: a clause of
   7328 characters is served and one of 7624 comes back 414. That works out at
   about 44 places outside the chosen plant; each of the live database's four
   plants leaves 36, so it is comfortable today and not by a wide margin. Past
   the ceiling the panel does NOT quietly send an unnarrowed read: it says the
   filter could not be applied and that every plant is therefore on screen. The
   durable fix is a place column on `audit_log` written by `write_audit_log`,
   which is a migration and so the maintainer's call.

   ⚠️ `AUDIT_PANEL_READY` LIVES HERE, not in `AdminPage.tsx`, exactly as every
   other panel's flag does: a section cannot be switched on without a panel
   behind it.

   ⚠️ THE PICKERS ARE THE SHARED FIELD (R-318), `Field.module.css`'s `.select`,
   not a copy of the skin — same call `SettingsPanel` makes. This stylesheet is
   not on `FIELD_LEGACY` and that list may only ever shrink, so hand-rolling a
   control here would be a build failure as well as a wrong look.

   DECIDES NOTHING ITSELF about what a change SAYS: every sentence in the table
   comes out of `src/features/admin/lib/auditView.ts`, which is pure and is what
   `src/test/auditView.test.ts` tests. This file holds layout, the two gates, and
   the arithmetic of how much of the log has been searched.
   --------------------------------------------------------------------------- */
import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery, type InfiniteData } from "@tanstack/react-query";
import {
  describeSchedulerError,
  fetchActorIdentities,
  fetchAdminProducts,
  fetchAuditPage,
  fetchHierarchyTree,
  fetchOperatorsAdmin,
  entryPlaceIds,
  placeFilterFits,
  type AuditAction,
  type AuditEntry,
  type AuditFilter,
  type AuditPage,
  type SchedulerError,
} from "@/lib/api";
import { formatCalendarMonth, type DateFormat } from "@/lib/format/dates";
import fieldStyles from "@/components/Field.module.css";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { useDateFormat } from "../hooks/useOrgSettings";
import { usePlantFilter } from "../hooks/usePlantFilter";
import { nodesInPlant } from "../lib/plantFilter";
import { type ScopeNode } from "../lib/scope";
import { hierarchyKeys } from "../hooks/useHierarchyMutations";
import { operatorKeys } from "../hooks/useOperators";
import { productKeys } from "../hooks/useProducts";
import {
  OMITTED_FIELDS,
  type AuditNames,
  describeActor,
  describeEntry,
  describeTable,
  formatInstant,
  type AuditFieldChange,
} from "../lib/auditView";
import styles from "./AuditPanel.module.css";

/** Read by `AdminPage`'s rail, the same way `SETTINGS_PANEL_READY` is. */
export const AUDIT_PANEL_READY = true;

/** Stable identity so an empty map never re-renders the list. */
const NO_ACTORS: ReadonlyMap<string, string> = new Map();

/** The same, for the kinds the screen has seen — the effect that fills it
 *  compares against this, so a first render cannot loop. */
const NO_KINDS: ReadonlyMap<string, string> = new Map();

/**
 * ⚠️⚠️ ONE ARRAY, NOT `?? []` AT THE CALL SITE, AND IT IS NOT TIDYING.
 * `usePlantFilter` memoises on the array it is handed, and the plant choice
 * ends up inside this screen's QUERY KEY. A fresh `[]` every render would
 * therefore mint a new key every render and the log would refetch forever.
 * `OperatorsPanel` keeps the same rule and says the same thing.
 */
const NO_NODES: readonly ScopeNode[] = [];

/*
 * ⚠️ `AUDIT_AUTO_SCAN_PAGES` USED TO SIT HERE AND IS GONE. It bounded a
 * self-read that paged towards the chosen period's floor, up to ten requests,
 * because reading past that floor was the only way the screen could prove a
 * filtered search had finished. The server now applies the filter, so the first
 * page's `hasMore` IS the proof and the walk has nothing left to do. Removed in
 * the same commit as the filter moved into the query, rather than left behind
 * as a bound on a loop nobody runs.
 */

export const auditKeys = {
  all: ["audit-log"] as const,
  actors: ["audit-log", "actors"] as const,
  /**
   * ⚠️ THE FILTER IS PART OF THE KEY, because it is now part of the QUERY. Two
   * filters are two different reads and must not share a cache entry — and
   * because they do not, going back to a filter already seen is instant.
   * Still under the `["audit-log"]` prefix, so every existing invalidation
   * reaches it.
   */
  page: (filter: AuditFilter) => ["audit-log", "page", filter] as const,
};

/* ---------------------------------------------------------------------------
   THE PERIODS — AND WHY THESE SIX
   ------------------------------------------------------------------------ */

interface AuditPeriod {
  id: string;
  /** In the picker. */
  label: string;
  /** In the footer: "the whole of ___ has been searched." */
  phrase: string;
  /** Inclusive lower bound, ms since the epoch. `null` is the start of the log. */
  fromMs: number | null;
  /**
   * EXCLUSIVE upper bound, ms. `null` is "now, and anything that lands while
   * this is on screen".
   *
   * ⚠️ EXCLUSIVE SO TWO ADJACENT PERIODS CANNOT BOTH CLAIM ONE INSTANT.
   * "Yesterday" ends where today starts; a change written at exactly midnight
   * belongs to one of them, not to both.
   */
  toMs: number | null;
}

/** Midnight at the start of the day `ms` falls in, IN THE READER'S TIMEZONE —
 *  the same timezone the When column is rendered in, so a period boundary and
 *  the dates beside it agree. */
function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The periods offered, resolved against one instant.
 *
 * ⭐⭐ TWO OF THEM HAVE BOTH ENDS, WHICH THIS SCREEN COULD NOT OFFER BEFORE.
 * While the browser did the filtering, only a period anchored at NOW could ever
 * be shown to be finished (see the header); "yesterday" and "last month" sit in
 * the middle of the log and were therefore left out rather than offered
 * unfinishable. With the bounds in the query they are ordinary.
 *
 * The set is what somebody troubleshooting actually reaches for — "it worked
 * this morning" (24 hours), "it worked yesterday", "it worked last week" (7
 * days), "since the last time anyone looked" (30 days), "what happened in
 * August" — plus the whole log, which stays the default so that arriving at
 * this screen shows the same thing it always did.
 */
function buildPeriods(nowMs: number, fmt: DateFormat): readonly AuditPeriod[] {
  const midnight = startOfLocalDay(nowMs);
  const yesterday = new Date(midnight);
  yesterday.setDate(yesterday.getDate() - 1);
  const monthStart = new Date(midnight);
  monthStart.setDate(1);
  const lastMonthStart = new Date(monthStart);
  lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
  // ⚠️ THROUGH THE SEAM, NOT A MONTH ARRAY OF OUR OWN. This file grew twelve
  // English month names and `dateSeam.test.ts` refused them, correctly: the
  // names belong to `dates.ts`, which already owns them for every other date on
  // this screen. `formatCalendarMonth` also follows the ORG's chosen format, so
  // the picker cannot read "August 2026" beside a column reading "2026-08-14".
  const lastMonthDay = `${lastMonthStart.getFullYear()}-${String(
    lastMonthStart.getMonth() + 1,
  ).padStart(2, "0")}-01`;
  const lastMonth = formatCalendarMonth(lastMonthDay, fmt);
  const ago = (hours: number) => nowMs - hours * 3_600_000;
  return [
    { id: "all", label: "All time", phrase: "the log", fromMs: null, toMs: null },
    {
      id: "24h",
      label: "Last 24 hours",
      phrase: "the last 24 hours",
      fromMs: ago(24),
      toMs: null,
    },
    { id: "7d", label: "Last 7 days", phrase: "the last 7 days", fromMs: ago(24 * 7), toMs: null },
    {
      id: "30d",
      label: "Last 30 days",
      phrase: "the last 30 days",
      fromMs: ago(24 * 30),
      toMs: null,
    },
    {
      id: "yesterday",
      label: "Yesterday",
      phrase: "yesterday",
      fromMs: yesterday.getTime(),
      toMs: midnight,
    },
    {
      id: "prev-month",
      label: lastMonth,
      phrase: lastMonth,
      fromMs: lastMonthStart.getTime(),
      toMs: monthStart.getTime(),
    },
  ];
}

/**
 * The three actions, in the product's words.
 *
 * ⚠️ THIS LIST CANNOT DRIFT FROM THE DATABASE. `audit_log_action_check` (0007)
 * allows exactly these three and `parseAuditEntry` rejects anything else, so a
 * fourth cannot arrive without a migration — which is why a fixed list is safe
 * here and a fixed list of TABLE names below would not be.
 */
const ACTION_FILTERS: ReadonlyArray<{ id: "all" | AuditAction; label: string }> = [
  { id: "all", label: "Any change" },
  { id: "insert", label: "Added" },
  { id: "update", label: "Changed" },
  { id: "delete", label: "Removed" },
];

/*
 * ⚠️ `instantMs()` USED TO SIT HERE AND IS GONE, AND ITS ABSENCE IS A PROPERTY
 * WORTH NAMING. It parsed an audit row's `at` so this file could decide whether
 * the row was inside the chosen period — a SECOND parser for a value the
 * database had already compared perfectly well, and one whose failure mode had
 * to be written round carefully ("a row whose timestamp cannot be read is
 * always shown, never hidden, and never counted as proof the window is
 * exhausted"). The comparison happens in Postgres now, against the column's own
 * type. No row on this screen can be hidden by a parse this code got wrong,
 * because this code no longer parses anything.
 */

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

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

/**
 * ⭐⭐ THE TWO WAYS A RECORDED CHANGE CANNOT BE PUT IN A PLANT, said in words on
 * the row rather than left to the reader to infer.
 *
 * The maintainer's steer, and the whole reason this screen over-shows: *in a
 * log, over-showing is a nuisance and hiding is deleting evidence.* But a row
 * listed under Plant A that has nothing to do with Plant A is only honest if the
 * row SAYS SO — otherwise the screen has swapped an under-count for a wrong one.
 *
 * ⚠️ TWO REASONS, NOT ONE, BECAUSE THEY ARE DIFFERENT FACTS. "No place
 * recorded" is a permanent property of the kind of thing (every `products` row,
 * forever). "Place since removed" is a property of this one row's history and
 * would go away if the place came back. Collapsing them into "unknown plant"
 * would tell a reader troubleshooting a deleted line nothing at all.
 */
const UNPLACED = {
  none: {
    label: "no place recorded",
    why:
      "This change records no place at all — a product belongs to its plants through a separate " +
      "list, which the record of the change does not carry — so it cannot be narrowed to one " +
      "plant. It is listed under every plant.",
  },
  gone: {
    label: "place since removed",
    why:
      "This change was recorded against a place that no longer exists, so it can no longer be " +
      "put in a plant. It is listed under every plant rather than dropped from all of them.",
  },
} as const;

/**
 * Why this entry could not be placed, or `null` when it could be.
 *
 * ⚠️ THE SAME TEST THE SERVER RAN, ON THIS SIDE. `buildPlaceClause` shows a row
 * whose places are all unresolvable; this decides whether to mark it. They read
 * the same two keys, through the same `entryPlaceIds`, so the mark cannot end up
 * on a different set of rows than the query let through.
 */
function unplacedReason(
  entry: AuditEntry,
  known: ReadonlySet<string>,
): (typeof UNPLACED)[keyof typeof UNPLACED] | null {
  const places = entryPlaceIds(entry);
  if (places.length === 0) return UNPLACED.none;
  return places.some((id) => known.has(id)) ? null : UNPLACED.gone;
}

export function AuditPanel() {
  const { session, profile, loading: sessionLoading } = useSession();
  const canQuery = canQueryAsUser(session?.user.id ?? null, sessionLoading);
  // ⚠️ THE CLIENT MIRROR OF `app_is_admin()`, not a looser rule of this screen's
  // own. Same expression `AdminPage` filters `companyAdminOnly` on.
  const isCompanyAdmin = profile?.role === "admin";
  const enabled = canQuery && isCompanyAdmin;
  const fmt = useDateFormat(canQuery);

  const [periodId, setPeriodId] = useState<string>("all");
  const [actionId, setActionId] = useState<string>("all");
  const [kindId, setKindId] = useState<string>("all");

  /* ⚠️ THE PERIODS ARE RESOLVED ONCE, AT MOUNT, and every bound is frozen with
     them. A bound that slid forwards while somebody paged would quietly drop
     rows off the bottom of the window they are reading, and "the whole of the
     last 7 days has been searched" would be a claim about a period that no
     longer exists. Freezing can only ever make the window slightly WIDER than
     the label promises as the minutes pass, which over-shows rather than
     under-claims — the safe direction for a log. */
  const periods = useMemo(() => buildPeriods(Date.now(), fmt), [fmt]);
  const period = periods.find((p) => p.id === periodId) ?? periods[0];

  /**
   * ⭐⭐ WHAT THE SERVER IS ASKED FOR. All four keys are always present so the
   * request reads the same shape whether or not anything is narrowed, and this
   * object is the query key as well as the argument — the two can therefore
   * never describe different reads.
   */
  /* ⚠️ RESOLVED THROUGH THE LIST, NOT CAST. A `<select>`'s value is a string
     as far as the DOM is concerned; looking it up in the offered set means an
     id this screen does not recognise degrades to "no restriction" instead of
     being posted to the server as an action the CHECK constraint has never
     heard of. Same shape as `period` above. */
  const action = ACTION_FILTERS.find((a) => a.id === actionId)?.id ?? "all";

  /* ---------------------------------------------------------------------
     ⭐⭐ WHICH PLANT THIS SCREEN IS SHOWING.

     The tree is read here rather than passed, exactly as `ProductsPanel`,
     `ShiftsPanel` and the rest read it: the choice lives ONCE on `AdminPage`
     and every section asks `usePlantFilter` for it, so this panel keeps the
     "takes no props" shape every other one keeps.

     ⚠️ THE READ SITS ABOVE THE FILTER BECAUSE THE FILTER DEPENDS ON IT. It is
     the same `["hierarchy","tree"]` query the Change column's name lookup
     already used — moved, not added, so this costs no extra round trip. It is
     ALSO still allowed to fail: while it is loading or broken there are no
     roots, `usePlantFilter` answers "All plants" (its header says why that is
     safe), and the log reads unnarrowed rather than empty.
     ------------------------------------------------------------------ */
  const nodesQuery = useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
    enabled,
  });
  const allNodes: readonly ScopeNode[] = nodesQuery.data?.nodes ?? NO_NODES;
  const plant = usePlantFilter(allNodes);

  /** Every place the reader can name. What separates "this change happened
   *  somewhere else" from "nobody can say where this change happened". */
  const knownPlaceIds = useMemo(() => new Set(allNodes.map((n) => n.id)), [allNodes]);

  /**
   * ⭐⭐ THE COMPLEMENT: every readable place that is NOT in the chosen plant.
   *
   * This is what goes to the server, and sending the complement rather than the
   * plant's own ids is the single decision that keeps this screen honest — see
   * the file header and `buildPlaceClause`. `null` is "All plants", which
   * narrows nothing.
   */
  const elsewhere = useMemo(() => {
    if (plant.choice === null) return null;
    const inPlant = new Set(nodesInPlant(allNodes, plant.choice, plant.plants).map((n) => n.id));
    return allNodes.filter((n) => !inPlant.has(n.id)).map((n) => n.id);
  }, [allNodes, plant.choice, plant.plants]);

  /* ⚠️ ASKED BEFORE THE SERVER IS ASKED. Past the measured request-size ceiling
     the alternative to saying so is a 414 rendered as "couldn't load the
     activity log", which blames the read for a limit this screen can see. */
  const placeFilterTooWide = elsewhere !== null && !placeFilterFits(elsewhere);
  const plantApplied = elsewhere !== null && !placeFilterTooWide;

  const filter: AuditFilter = useMemo(
    () => ({
      since: period.fromMs === null ? null : new Date(period.fromMs).toISOString(),
      until: period.toMs === null ? null : new Date(period.toMs).toISOString(),
      actions: action === "all" ? null : [action],
      tables: kindId === "all" ? null : [kindId],
      elsewhere: plantApplied ? elsewhere : null,
    }),
    [period, action, kindId, plantApplied, elsewhere],
  );

  /* ⚠️ THE ERROR TYPE IS SPELLED OUT, and it is not decoration. `fetchAuditPage`
     throws through `toSchedulerError`, so every failure here IS a
     `SchedulerError` — but React Query's default error generic is `Error`, and
     `describeSchedulerError` (which switches on `kind`) would then be handed a
     type it cannot read. Same explicit-generic contract `useOrgSettings` keeps. */
  const log = useInfiniteQuery<
    AuditPage,
    SchedulerError,
    InfiniteData<AuditPage>,
    ReturnType<typeof auditKeys.page>,
    number | null
  >({
    queryKey: auditKeys.page(filter),
    queryFn: ({ pageParam }) => fetchAuditPage(pageParam, filter),
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
  //
  // ⭐ NAMES, NOT IDS — the maintainer's whole objection to the first version:
  // *"IDs are not fun when trying to troubleshoot something."* Four reads back
  // that up, and all four are DECORATION: every one may fail on its own without
  // taking the log with it, because the CHANGES are the screen and a log that
  // refuses to render because a lookup 401'd would be a worse answer than one
  // showing a uuid.
  //
  // ⚠️ THE KEYS ARE THE OTHER PANELS' KEYS, DELIBERATELY. React Query caches by
  // key, so opening Activity after Operators costs nothing, and a mutation
  // anywhere already invalidates these prefixes — this screen cannot go stale
  // on its own, and nobody has to remember it exists when they add an
  // invalidation.
  const actors = useQuery({
    queryKey: auditKeys.actors,
    queryFn: fetchActorIdentities,
    enabled,
  });
  const operatorsQuery = useQuery({
    queryKey: operatorKeys.all,
    queryFn: fetchOperatorsAdmin,
    enabled,
  });
  const productsQuery = useQuery({
    queryKey: productKeys.all,
    queryFn: fetchAdminProducts,
    enabled,
  });

  const identities = actors.data;
  const roles = useMemo(() => {
    if (identities === undefined) return NO_ACTORS;
    const m = new Map<string, string>();
    for (const [uid, who] of identities) m.set(uid, who.role);
    return m;
  }, [identities]);
  /**
   * ⚠️ AN ABSENT ADDRESS IS LEFT OUT RATHER THAN MAPPED TO `null`. `describeActor`
   * reads "present" as "this is who it was"; a null in the map would be a
   * present answer meaning nothing, and the role-and-tail fallback below is the
   * honest one. `email` is nullable because a profile can exist whose auth row
   * carries no address.
   */
  const actorEmails = useMemo(() => {
    if (identities === undefined) return NO_ACTORS;
    const m = new Map<string, string>();
    for (const [uid, who] of identities) if (who.email !== null) m.set(uid, who.email);
    return m;
  }, [identities]);
  /**
   * ⭐ THE NAME, THIRD MAP OUT OF ONE READ (0047). `describeActor` prefers it
   * over the address; absent is left out rather than mapped to null, exactly as
   * above and for the same reason.
   *
   * ⚠️ EXPECT THIS MAP TO BE EMPTY. Nothing writes `user_profiles.display_name`
   * yet, so every identity arrives with `displayName: null` and the Who column
   * falls through to the address — which is the state the screen shipped in and
   * must keep working in.
   */
  const actorNames = useMemo(() => {
    if (identities === undefined) return NO_ACTORS;
    const m = new Map<string, string>();
    for (const [uid, who] of identities) if (who.displayName !== null) m.set(uid, who.displayName);
    return m;
  }, [identities]);
  const viewerUserId = profile?.userId ?? null;

  /**
   * The lookups the Change column needs to render a name where a snapshot holds
   * an id. `auditView` prefers a name the SNAPSHOT carries over anything here —
   * which is what makes a deleted row still nameable, and what stops a rename
   * rewriting the past — so these answer the ordinary rows and the snapshot
   * answers the deletes.
   */
  const names: AuditNames = useMemo(() => {
    const nodes = new Map<string, string>();
    for (const n of nodesQuery.data?.nodes ?? []) nodes.set(n.id, n.name);
    const operators = new Map<string, string>();
    for (const o of operatorsQuery.data?.operators ?? []) operators.set(o.id, o.displayName);
    const products = new Map<string, string>();
    for (const p of productsQuery.data ?? []) if (p !== null) products.set(p.id, p.name);
    return { nodes, operators, products, actorRoles: roles, actorEmails, actorNames, viewerUserId };
  }, [
    nodesQuery.data,
    operatorsQuery.data,
    productsQuery.data,
    roles,
    actorEmails,
    actorNames,
    viewerUserId,
  ]);

  const pages = log.data?.pages;
  /**
   * The rows on screen. Every one of them MATCHES: the server applied the
   * filter, so there is no longer a scan and a match to keep apart.
   */
  const entries = useMemo(() => pages?.flatMap((p) => p.entries) ?? [], [pages]);

  /**
   * The kinds of thing offered — every kind this screen has SEEN, not the kinds
   * in the current result.
   *
   * ⚠️ NOT A HAND-WRITTEN LIST OF TABLE NAMES. `describeTable` is deliberately
   * not an allowlist — the audited set is decided by triggers on the database
   * and grew by four in one migration — so a fixed list here would be a second
   * copy of a list that lives in the schema, and would go silently blind to a
   * seventh table.
   *
   * ⚠️⚠️ AND IT REMEMBERS, WHICH IT DID NOT HAVE TO WHILE THE BROWSER FILTERED.
   * Every row read under "Products" is a product, so a picker rebuilt from the
   * current rows would offer "Products" and nothing else — a filter with no
   * control left to undo it. It also never shrinks when a period narrows, so a
   * kind with nothing in the chosen window can still be asked for, and gets the
   * honest answer ("no changes match this filter") instead of vanishing.
   */
  const [kindsSeen, setKindsSeen] = useState<ReadonlyMap<string, string>>(NO_KINDS);
  useEffect(() => {
    let found = false;
    const next = new Map(kindsSeen);
    for (const e of entries) {
      if (!next.has(e.tableName)) {
        next.set(e.tableName, describeTable(e.tableName));
        found = true;
      }
    }
    if (found) setKindsSeen(next);
  }, [entries, kindsSeen]);
  const kinds = useMemo(
    () => [...kindsSeen.entries()].sort((a, b) => a[1].localeCompare(b[1])),
    [kindsSeen],
  );
  /** Whether a row has EVER been read — which is what licenses the controls,
   *  not whether the current filter matched anything. */
  const hasEverListed = kindsSeen.size > 0;

  /* ⚠️ READ OFF THE RESOLVED VALUES, so "is anything narrowed?" and "what was
     sent to the server" can never disagree.

     ⚠️⚠️ `plantApplied`, NOT `plant.choice !== null`. A plant that was CHOSEN
     but could not be sent (past the request-size ceiling) narrows nothing, and
     counting it here would put the plant's name into a footer describing a list
     of the whole company — which is the report this work started from, only
     now in the sentence instead of the table. */
  const filtering = period.id !== "all" || action !== "all" || kindId !== "all" || plantApplied;

  /** What the footer calls the narrowing, when a plant is part of it. */
  const scope = plantApplied ? ` in ${plant.label}` : "";
  const hasNextPage = log.hasNextPage;

  /**
   * ⭐⭐ THE ONE PREDICATE THE WHOLE FOOTER RESTS ON, AND IT IS NOW ONE FACT
   * RATHER THAN AN ARGUMENT: has every row the filter could match been read?
   *
   * `hasMore` comes from `fetchAuditPage` asking for one row more than it
   * returns, WITH the filter in the query. False on the last page therefore
   * means the server — applying the same predicate this list was drawn from —
   * found no row older than the cursor that satisfies it, so nothing unread can
   * match and "all" is a true statement about the filtered set. Nothing else may
   * license that word.
   *
   * ⚠️ IT NO LONGER DEPENDS ON THE PERIOD ENDING AT NOW, on `at` rising with
   * `id`, or on this file parsing a timestamp correctly. See the header for the
   * assumption that used to be buried in the version this replaced.
   *
   * ⚠️⚠️ AND IT IS THE PAGE'S OWN `hasMore`, NOT `!hasNextPage`. React Query
   * reports no next page when `getNextPageParam` returns undefined, and that
   * happens for TWO reasons: the server said there is nothing more, or the page
   * carried no row to take a cursor from. The second is reachable — a page whose
   * rows are ALL rejected by `parseAuditEntry` arrives empty with `hasMore`
   * true — and it is precisely the case where the screen knows least and would
   * have claimed most. Reading the flag itself keeps "finished" meaning
   * finished; the reader is told there are older changes and, with no cursor to
   * ask from, is not offered a button that cannot move.
   */
  const lastPage = pages !== undefined && pages.length > 0 ? pages[pages.length - 1] : undefined;
  const searchComplete = lastPage !== undefined && !lastPage.hasMore;

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

  /* ⚠️⚠️ `!canQuery || …` — NOT `log.isPending` ALONE, and this is D91 a third
     time. With `enabled: false` React Query v5 reports `isPending` with
     `fetchStatus: "idle"`, so the pending flag is FALSE for the whole window in
     which the session is still resolving. Narrowing this to the query's own flag
     renders the EMPTY branch for a beat — and this screen's empty branch is the
     sentence *"Nothing has been changed yet."*, which is a claim about the
     company, made before a single row has been asked for. Same condition
     `AdminPage` spells out for its own read. */
  const showLoading = !canQuery || log.isPending;

  const matched = entries.length;

  /* ⭐⭐ THE SENTENCE. Which one is printed is decided by `searchComplete` and
     nothing else. The unfiltered pair is word for word what this screen has
     always said, because nothing about it changed; so is the pair that reports
     a finished search, because what changed is how it is PROVED, not what it
     claims. */
  let footerText: string;
  if (!filtering) {
    footerText = searchComplete
      ? `Showing the most recent ${matched} change${plural(matched)} — this is the whole log.`
      : matched === 0
        ? // Only reachable when a page arrived whose rows the guard all
          // refused. It is a fact about this screen, not about the company,
          // and saying nothing would leave the reader with a blank panel.
          `No changes could be read from this page of the log. There are older ones.`
        : `Showing the most recent ${matched} change${plural(matched)}. There are older ones.`;
  } else if (searchComplete) {
    /* ⚠️ "THE WHOLE OF THE LOG HAS BEEN SEARCHED" IS STILL TRUE WITH A PLANT
       CHOSEN, and that is the point of putting the plant in the query: the
       server read past every row, applying this predicate, and found no other
       match. The plant qualifies WHAT MATCHED, never how far the search got. */
    footerText =
      matched === 0
        ? `No changes match this filter${scope} — the whole of ${period.phrase} has been searched.`
        : `Showing all ${matched} matching change${plural(matched)}${scope} — the whole of ${period.phrase} has been searched.`;
  } else {
    /* ⚠️⚠️ NOT AN ANSWER, AND IT MUST NOT READ AS ONE. The server found MORE
       matches than one page holds, so the count on screen is a page of the
       answer and not the answer. This sentence replaced one that reported a
       scan ("found in the 50 most recent changes read"), because the screen no
       longer reads rows it does not show — the honest report is now about
       matches rather than about how far it looked. */
    footerText =
      matched === 0
        ? `No matching changes${scope} on this page of ${period.phrase}. There are older ones still to read.`
        : `Showing the ${matched} most recent matching change${plural(matched)}${scope} in ${period.phrase}. There are older ones.`;
  }

  // ⚠️ NO BUTTON ONCE THE SEARCH IS FINISHED: there may well be older changes
  // in the log, but none of them can match, so offering to search for them
  // would be offering work that cannot change the answer.
  const showMore = hasNextPage === true;

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

      {/* ⭐⭐ THE SCREEN SAYS WHAT ITS OWN PLANT FILTER MEANS. Without this
          paragraph a reader would meet a product's change under "Plant A" and
          reasonably conclude the product belongs to Plant A. The mark on the
          row is the per-row half; this is the rule. */}
      {plantApplied && (
        <p className={styles.note}>
          Showing {plant.label}. A change that records no place, and a change recorded against a
          place that has since been removed, are listed under every plant and marked below — nobody
          can say which plant they belong to, and a log that hid what it could not place would be
          under-reporting history rather than filtering it.
        </p>
      )}

      {/* ⚠️⚠️ THE CEILING, SAID OUT LOUD RATHER THAN SILENTLY IGNORED. The
          header chip still reads the chosen plant, so a screen that quietly
          showed every plant here would be the bug this filter was built to
          fix. It over-shows, and it says that is what it is doing. */}
      {placeFilterTooWide && (
        <p className={styles.note} role="status">
          {plant.label} is selected, but this company has {elsewhere?.length ?? 0} places outside it
          — more than one request to the server can carry. The activity log below is showing every
          plant, not just {plant.label}. Nothing is hidden.
        </p>
      )}

      {log.isError && (
        <p className={styles.error} role="alert">
          Couldn&rsquo;t load the activity log — {describeSchedulerError(log.error)}. Nothing is
          missing from the record; this screen failed to read it. Try refreshing the page.
        </p>
      )}

      {showLoading && <p className={styles.status}>Loading…</p>}

      {/* ⚠️⚠️ AN EMPTY LOG, AN EMPTY RESULT AND A FAILED READ ARE THREE
          DIFFERENT FACTS AND MAY NEVER SHARE A SENTENCE. One is a claim about
          the company, one is the answer to a question the reader asked, and one
          is worth retrying. `!filtering` is what keeps them apart now that the
          SERVER does the narrowing: a filtered read that matches nothing comes
          back with no rows at all, where the browser-side version always still
          had the scan behind it. */}
      {!showLoading && !log.isError && !filtering && searchComplete && entries.length === 0 && (
        <p className={styles.status}>Nothing has been changed yet.</p>
      )}

      {(hasEverListed || filtering) && (
        <>
          {/* ⚠️⚠️ GATED ON HAVING EVER LISTED ANYTHING, NEVER ON THE CURRENT
              RESULT — the controls must survive a filter that empties the
              table, or the reader cannot undo it and is left looking at
              nothing. This is the same rule the old panel kept by gating on the
              scan; with the filter in the query there IS no scan behind an
              empty result, so the panel remembers instead. */}
          <div className={styles.filters}>
            <div className={styles.filter}>
              <label className={styles.filterLabel} htmlFor="audit-period">
                Time period
              </label>
              <select
                id="audit-period"
                className={`${fieldStyles.select} ${styles.filterSelect}`}
                value={periodId}
                onChange={(e) => setPeriodId(e.target.value)}
              >
                {periods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.filter}>
              <label className={styles.filterLabel} htmlFor="audit-action">
                Kind of change
              </label>
              <select
                id="audit-action"
                className={`${fieldStyles.select} ${styles.filterSelect}`}
                value={actionId}
                onChange={(e) => setActionId(e.target.value)}
              >
                {ACTION_FILTERS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.filter}>
              <label className={styles.filterLabel} htmlFor="audit-kind">
                Kind of thing
              </label>
              <select
                id="audit-kind"
                className={`${fieldStyles.select} ${styles.filterSelect}`}
                value={kindId}
                onChange={(e) => setKindId(e.target.value)}
              >
                <option value="all">Anything</option>
                {kinds.map(([table, noun]) => (
                  <option key={table} value={table}>
                    {noun}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {entries.length > 0 && (
            <div className={styles.scroll}>
              <table className={styles.table}>
                <thead>
                  <tr className={styles.headRow}>
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
                    const line = describeEntry(e, fmt, names);
                    /* ⚠️ ONLY WHILE A PLANT IS APPLIED. On "All plants" every
                       row is in scope and the mark would answer a question
                       nobody asked; it is meaningful exactly when the reader
                       has narrowed and needs to know why this row survived. */
                    const unplaced = plantApplied ? unplacedReason(e, knownPlaceIds) : null;
                    return (
                      /* ⚠️ `data-action` IS THE HOOK FOR THE ACCENT, and the
                         accent is an ADDITION to `line.headline` ("Run deleted"),
                         never a replacement for it. See the header. */
                      <tr key={e.id} className={styles.row} data-action={e.action}>
                        <td className={styles.when}>{formatInstant(e.at, fmt)}</td>
                        <td className={styles.who}>
                          {describeActor(e.actorId, viewerUserId, roles, actorEmails, actorNames)}
                        </td>
                        <td className={styles.what}>
                          <span className={styles.headline}>{line.headline}</span>
                          <span className={styles.subject}>{line.subject}</span>
                          {unplaced !== null && (
                            /* ⚠️ THE REASON IS IN THE TEXT AND ALSO IN `title`,
                               never in colour alone — the same rule the action
                               accent keeps three paragraphs up in the header. */
                            <span className={styles.unplaced} title={unplaced.why}>
                              {unplaced.label}
                            </span>
                          )}
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
          )}
        </>
      )}

      {/* ⭐⭐ THE SCREEN STATES ITS OWN COMPLETENESS — of the LOG when it is
          unfiltered, and of the SEARCH when it is not. The count is the rows
          actually rendered, which are exactly the rows that matched, so no
          sentence can drift from the thing it describes.

          ⚠️ OUTSIDE THE CONTROLS' BLOCK, and that is not tidying. The one state
          with no rows, no filter and an unfinished read — a page whose rows the
          guard all refused — has no controls to sit under and is precisely the
          state the reader most needs a sentence for.

          ⚠️ SILENT WHILE A READ IS IN FLIGHT, rather than describing the page it
          is about to replace: a filter change is a NEW query (the filter is
          part of the key), so the alternative is a sentence counting rows that
          are no longer the answer. */}
      {!showLoading && !log.isError && (hasEverListed || filtering || !searchComplete) && (
        <div className={styles.footer}>
          <p className={styles.status}>{footerText}</p>
          {showMore && (
            <button
              type="button"
              className={styles.more}
              disabled={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}
            >
              {log.isFetchingNextPage
                ? "Loading…"
                : filtering
                  ? "Search older changes"
                  : "Load older changes"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
