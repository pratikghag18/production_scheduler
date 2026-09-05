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

   `fetchAuditPage` returns fifty ROWS, not fifty MATCHES. Filter its result in
   the browser and the honest-looking footer beneath — *"showing 3 removals"* —
   is a count of the removals that happen to sit in the newest fifty rows of the
   log, presented as a count of the company's removals. On a busy company it is
   an EMPTY LIST under the word "removals", which a reader will quite reasonably
   take to mean nothing has ever been deleted. That is strictly worse than
   offering no filter at all, because a missing feature is visible and a wrong
   answer is not.

   So this panel keeps TWO numbers apart and never lets one stand in for the
   other:

     - the SCAN — how many rows it has actually read out of the log, and
     - the MATCH — how many of those rows the filter keeps.

   and it may print the word "all" only when it can PROVE the scan covered every
   row the filter could possibly have matched. The proof is the ordering:

   ⚠️⚠️ EVERY PERIOD OFFERED IS ANCHORED AT NOW, AND THAT IS A CORRECTNESS
   DECISION RATHER THAN A TASTE ONE. The read is newest-first on `id`, so the
   rows inside "the last 7 days" are a PREFIX of the scan. The moment the scan
   reaches one row older than the cutoff, every row that could have matched has
   already been read and the screen may say "all". A period that did NOT end at
   now — "August", "last month" — sits in the MIDDLE of the log and cannot be
   completed without reading every row newer than it, so none is offered. When
   `fetchAuditPage` learns to take a `since`, that changes; until then, offering
   one would be offering a filter this screen cannot finish.

   ⚠️ "ALL TIME" HAS NO CUTOFF, so under a filter it is complete only once the
   whole log has been read. Until then the footer says what it SEARCHED, never
   what it found, and keeps the control that searches further.

   ⚠️ AND THE SCREEN FINISHES A BOUNDED PERIOD BY ITSELF. Once a period is
   chosen the scan has a floor, so the panel pages towards it without being
   asked — up to `AUDIT_AUTO_SCAN_PAGES`, because an unbounded self-read is a
   screen that hammers the database on a company with a long history. When it
   stops short it says so in the same sentence it always uses.

   ⚠️ WHAT THIS COSTS, SAID PLAINLY: a narrow filter over a long log is many
   round trips, because the server is filtering nothing. `src/lib/api/audit.ts`
   taking `since` / `tables` / `actions` and pushing them into `.gte("at", …)`
   and `.in(…)` would make a page fifty MATCHES instead of fifty rows, and would
   also let a bounded period be offered. That is a change to a file this panel
   does not own; it is flagged, not invented here.

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
  type AuditPage,
  type SchedulerError,
} from "@/lib/api";
import fieldStyles from "@/components/Field.module.css";
import { useSession } from "@/features/auth/useSession";
import { canQueryAsUser } from "@/features/auth/session";
import { useDateFormat } from "../hooks/useOrgSettings";
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

/**
 * How many pages the screen will read on its own to finish a chosen period.
 *
 * ⚠️ A CEILING, NOT A TARGET, and it exists because the alternative is a screen
 * that walks the entire history of a busy company fifty rows at a time the
 * moment somebody picks "last 30 days". Ten pages is five hundred changes; past
 * that the reader is told the search is unfinished and drives it themselves.
 * Exported so the case that pins the bound reads the same number the code does.
 */
export const AUDIT_AUTO_SCAN_PAGES = 10;

export const auditKeys = {
  all: ["audit-log"] as const,
  actors: ["audit-log", "actors"] as const,
};

/* ---------------------------------------------------------------------------
   THE PERIODS — AND WHY THESE FOUR
   ------------------------------------------------------------------------ */

interface AuditPeriod {
  id: string;
  /** In the picker. */
  label: string;
  /** In the footer: "the whole of ___ has been searched." */
  phrase: string;
  /** How far back from NOW. `null` is no cutoff at all. */
  hours: number | null;
}

/**
 * ⚠️ ALL FOUR END AT NOW. See the header: that is what makes them a prefix of a
 * newest-first scan, and therefore the only kind of period this screen can
 * finish without a server-side filter.
 *
 * The set is what somebody troubleshooting actually reaches for — "it worked
 * this morning" (24 hours), "it worked last week" (7 days), "since the last
 * time anyone looked" (30 days) — plus the whole log, which stays the default so
 * that arriving at this screen shows the same thing it always did.
 */
const PERIODS: readonly AuditPeriod[] = [
  { id: "all", label: "All time", phrase: "the log", hours: null },
  { id: "24h", label: "Last 24 hours", phrase: "the last 24 hours", hours: 24 },
  { id: "7d", label: "Last 7 days", phrase: "the last 7 days", hours: 24 * 7 },
  { id: "30d", label: "Last 30 days", phrase: "the last 30 days", hours: 24 * 30 },
];

/**
 * The three actions, in the product's words.
 *
 * ⚠️ THIS LIST CANNOT DRIFT FROM THE DATABASE. `audit_log_action_check` (0007)
 * allows exactly these three and `parseAuditEntry` rejects anything else, so a
 * fourth cannot arrive without a migration — which is why a fixed list is safe
 * here and a fixed list of TABLE names below would not be.
 */
const ACTION_FILTERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "all", label: "Any change" },
  { id: "insert", label: "Added" },
  { id: "update", label: "Changed" },
  { id: "delete", label: "Removed" },
];

/**
 * An audit row's `at`, in milliseconds, or `null` when it cannot be read.
 *
 * ⚠️ `at` COMES BACK PROPERLY ISO on the audit row itself, but the same
 * normalisation `auditView` applies to jsonb timestamps is done anyway — one
 * parser that accepts both beats two that can disagree, and a value this cannot
 * read must degrade to "unknown when", never to zero (which would be 1970 and
 * would silently drop the row out of every period).
 */
function instantMs(raw: string): number | null {
  const d = new Date(
    raw
      .trim()
      .replace(" ", "T")
      .replace(/([+-]\d{2})$/, "$1:00"),
  );
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

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
  const nodesQuery = useQuery({
    queryKey: [...hierarchyKeys.all, "tree"],
    queryFn: fetchHierarchyTree,
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
  /** Every row READ so far — the SCAN. Not what the reader is looking at. */
  const entries = useMemo(() => pages?.flatMap((p) => p.entries) ?? [], [pages]);

  const period = PERIODS.find((p) => p.id === periodId) ?? PERIODS[0];
  /* ⚠️ FROZEN AT THE MOMENT THE PERIOD IS CHOSEN, not recomputed every render.
     A cutoff that slid forwards while somebody paged would quietly drop rows off
     the bottom of the window they are reading, and the "whole period searched"
     claim would be about a period that no longer exists. */
  const cutoff = useMemo(
    () => (period.hours === null ? null : Date.now() - period.hours * 3_600_000),
    [period],
  );

  /**
   * The oldest instant the scan has reached.
   *
   * ⚠️ THE MINIMUM, NOT THE LAST ROW. `id` and `at` agree in practice but the
   * api file is explicit that ordering is by `id` alone, and a row whose `at`
   * cannot be parsed contributes nothing here rather than a wrong floor — the
   * scan is only ever declared finished on evidence it actually has.
   */
  const oldestReadMs = useMemo(() => {
    let oldest: number | null = null;
    for (const e of entries) {
      const t = instantMs(e.at);
      if (t !== null && (oldest === null || t < oldest)) oldest = t;
    }
    return oldest;
  }, [entries]);

  /**
   * The kinds of thing offered, built from the rows actually read.
   *
   * ⚠️ NOT A HAND-WRITTEN LIST OF TABLE NAMES. `describeTable` is deliberately
   * not an allowlist — the audited set is decided by triggers on the database
   * and grew by four in one migration — so a fixed list here would be a second
   * copy of a list that lives in the schema, and would go silently blind to a
   * seventh table. Derived from the scan, it cannot.
   */
  const kinds = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of entries) {
      if (!seen.has(e.tableName)) seen.set(e.tableName, describeTable(e.tableName));
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries]);

  /** The rows the reader is looking at — the MATCH. */
  const visible = useMemo(
    () =>
      entries.filter((e) => {
        if (cutoff !== null) {
          const t = instantMs(e.at);
          // ⚠️ AN UNREADABLE TIMESTAMP IS SHOWN, NEVER HIDDEN. This is a log:
          // over-showing a row whose date this code cannot parse is a nuisance,
          // hiding it is deleting evidence to keep a filter tidy.
          if (t !== null && t < cutoff) return false;
        }
        if (actionId !== "all" && e.action !== actionId) return false;
        if (kindId !== "all" && e.tableName !== kindId) return false;
        return true;
      }),
    [entries, cutoff, actionId, kindId],
  );

  const filtering = periodId !== "all" || actionId !== "all" || kindId !== "all";
  const hasNextPage = log.hasNextPage;

  /**
   * ⭐⭐ THE ONE PREDICATE THE WHOLE FOOTER RESTS ON: has the scan covered every
   * row the filter could have matched?
   *
   * Either the whole log has been read, or the scan has reached a row strictly
   * older than the cutoff — at which point, the read being newest-first, nothing
   * unread can be inside the period. Nothing else may license the word "all".
   */
  const searchComplete =
    !hasNextPage || (cutoff !== null && oldestReadMs !== null && oldestReadMs < cutoff);

  /* ⚠️ THE SELF-READ, AND ITS TWO BOUNDS. It runs only when a period gives the
     scan a floor to reach, and never past `AUDIT_AUTO_SCAN_PAGES`. Without the
     first bound "all time" plus a narrow filter would read the entire log;
     without the second, "last 30 days" would on a busy company. */
  const pageCount = pages?.length ?? 0;
  const { fetchNextPage, isFetchingNextPage } = log;
  const scanOn =
    cutoff !== null &&
    !searchComplete &&
    hasNextPage === true &&
    !isFetchingNextPage &&
    pageCount > 0 &&
    pageCount < AUDIT_AUTO_SCAN_PAGES;
  /* ⚠️⚠️ `pageCount` IS IN THE DEPS AND IT IS LOAD-BEARING. Depending on
     `scanOn` alone reads as enough — it goes false while a page is in flight and
     true again after — but React batches the start and the end of a fast fetch
     into ONE render, so the flag is never observed false, the deps never change,
     and the effect fires exactly twice and stops. Measured: the self-read
     stopped after two pages instead of ten. The page count is the thing that
     actually moves every time a page lands. */
  useEffect(() => {
    if (!scanOn) return;
    void fetchNextPage();
  }, [scanOn, pageCount, fetchNextPage]);

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

  const scanned = entries.length;
  const matched = visible.length;

  /* ⭐⭐ THE SENTENCE. Three shapes, and which one is printed is decided by
     `searchComplete` and nothing else. The unfiltered pair is word for word what
     this screen has always said, because nothing about it changed. */
  let footerText: string;
  if (!filtering) {
    footerText = hasNextPage
      ? `Showing the most recent ${scanned} change${plural(scanned)}. There are older ones.`
      : `Showing the most recent ${scanned} change${plural(scanned)} — this is the whole log.`;
  } else if (searchComplete) {
    footerText =
      matched === 0
        ? `No changes match this filter — the whole of ${period.phrase} has been searched.`
        : `Showing all ${matched} matching change${plural(matched)} — the whole of ${period.phrase} has been searched.`;
  } else {
    // ⚠️⚠️ NEITHER OF THESE IS AN ANSWER, AND THAT IS THE POINT. The screen has
    // read part of the log; it reports what it read and what it found in it, and
    // says outright that the rest is unsearched. A reader who sees no removals
    // here has been told why they might be seeing none.
    footerText =
      matched === 0
        ? `No match yet in the ${scanned} most recent change${plural(scanned)} read. Older changes have not been searched.`
        : `Showing ${matched} matching change${plural(matched)} found in the ${scanned} most recent change${plural(scanned)} read. Older changes have not been searched.`;
  }

  // ⚠️ NO BUTTON ONCE A BOUNDED PERIOD IS FINISHED: there are older changes, but
  // none of them can be inside the period, so offering to search for them would
  // be offering work that cannot change the answer.
  const showMore = hasNextPage === true && !(filtering && searchComplete);

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
          {/* ⚠️ GATED ON THE SCAN, NOT ON THE MATCH — the controls must survive a
              filter that empties the table, or the reader cannot undo it. */}
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
                {PERIODS.map((p) => (
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

          {visible.length > 0 && (
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
                  {visible.map((e) => {
                    const line = describeEntry(e, fmt, names);
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

          {/* ⭐⭐ THE SCREEN STATES ITS OWN COMPLETENESS — of the LOG when it is
              unfiltered, and of the SEARCH when it is not. The counts are the
              rows actually read and the rows actually rendered, so no sentence
              can drift from the thing it describes. */}
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
        </>
      )}
    </div>
  );
}
