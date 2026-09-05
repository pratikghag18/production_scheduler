/// <reference types="node" />
/**
 * THE ACTIVITY SCREEN — every change is recorded and, until now, nothing showed
 * it.
 *
 * `audit_log` has been filling since migration 0007 (runs, assignments) and
 * 0029 §6 (products, operators, skills, shift patterns): full `before`/`after`
 * jsonb on every insert, update and delete. `src/` had never read one row of it.
 *
 * ⭐⭐ THE TWO THINGS THAT CAN GO WRONG HERE ARE BOTH ABOUT HONESTY, and both
 * have cases below.
 *
 * 1. WHO IS OFFERED THE SCREEN. `audit_log_select` is
 *    `app_is_admin() AND org_id = app_current_org()` — a COMPANY admin and
 *    nobody else. A site admin (org-wide `viewer` with an admin grant) reads
 *    exactly zero rows. `AdminPage` hides the tab (`auditAccess.test.tsx`), and
 *    this panel refuses to fire the read at all, for the same reason
 *    `SettingsPanel` refuses its write: **a screen that shows what the server
 *    will refuse is worse than one that refuses what the server allows.**
 *
 * 2. HOW MUCH IT CLAIMS TO SHOW. PostgREST caps every response at
 *    `max_rows = 1000` and an audit log is the table that passes a thousand
 *    rows first. Reading one page and calling it "the history" would be a
 *    screen lying about its own completeness. So the panel pages — a fixed
 *    number of the most recent changes, and a control that fetches older ones —
 *    and it says in words which of those two states it is in. The cases below
 *    pin both sentences, because a wrong one is invisible.
 *
 * ⚠️ THE RENDERING ITSELF IS NOT RE-TESTED HERE. `auditView.test.ts` owns what
 * a row says; this owns what the SCREEN does with a page of them.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import type { ReactNode } from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuditPanel } from "@/features/admin/components/AuditPanel";

/** The stylesheet two of the cases below read as text — jsdom applies no CSS. */
const PANEL_CSS = "src/features/admin/components/AuditPanel.module.css";

const ADMIN_USER = "00000000-0000-0000-0000-0000000000a1";
const OTHER_USER = "00000000-0000-0000-0000-0000000000b2";

const h = vi.hoisted(() => ({
  fetchPage: vi.fn(),
  fetchActors: vi.fn(),
  state: {
    profile: {
      id: "p1",
      orgId: "10000000-0000-0000-0000-000000000001",
      userId: "00000000-0000-0000-0000-0000000000a1",
      role: "admin" as string,
      defaultCreateMode: "run",
      adminAnywhere: true,
    },
    sessionLoading: false,
  },
}));

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: h.state.sessionLoading ? null : { user: { id: h.state.profile.userId } },
    profile: h.state.sessionLoading ? null : h.state.profile,
    loading: h.state.sessionLoading,
  }),
}));

// ⚠️ FOUR READS NOW, AND THE THREE NAME LOOKUPS ARE STUBBED EMPTY ON PURPOSE.
// The panel decorates ids with names from `nodes` / `operators` / `products`,
// and every one of those is allowed to be absent — `auditView` renders an
// honest "Unknown place · 000007" rather than a name it does not have. Resolving
// them here would hide that path from every case in this file; the cases that
// care about names supply their own map. What must NOT be empty is the actor
// read, because the Who column is what these cases are largely about.
vi.mock("@/lib/api", () => ({
  fetchAuditPage: (...args: unknown[]) => h.fetchPage(...args),
  fetchActorIdentities: (...args: unknown[]) => h.fetchActors(...args),
  fetchHierarchyTree: () => Promise.resolve({ nodes: [], levels: [], templates: [] }),
  fetchOperatorsAdmin: () => Promise.resolve({ operators: [], skills: [] }),
  fetchAdminProducts: () => Promise.resolve([]),
  describeSchedulerError: (e: unknown) => String(e),
}));

// The org's date-format token. Not mocked away to a literal: the seam is what
// decides how the "when" column reads, and standing in for it would pin that
// the panel calls something rather than that a reader can read a date.
vi.mock("@/features/admin/hooks/useOrgSettings", () => ({
  useDateFormat: () => "iso",
}));

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 233,
    at: "2026-09-04T19:11:44.921206+00:00",
    actorId: ADMIN_USER,
    tableName: "products",
    rowId: "60000000-0000-0000-0000-000000000001",
    action: "insert" as const,
    before: null as Record<string, unknown> | null,
    after: { name: "Widget X", sku: "WX-1", active: true } as Record<string, unknown> | null,
    ...over,
  };
}

/**
 * ⭐⭐ THE FILTER OBJECT EVERY READ CARRIES. All four keys are always sent, with
 * `null` for "do not narrow on this", so a call can be asserted whole rather
 * than by picking at the keys somebody remembered to look at.
 */
const NO_FILTER = { since: null, until: null, actions: null, tables: null };

/**
 * ⭐⭐ THE SERVER HALF, FAITHFULLY. `fetchAuditPage` now puts the period, the
 * action and the table INTO the query, so a page is fifty MATCHES; a mock that
 * ignored the filter and returned everything would let a panel that had quietly
 * stopped narrowing pass every case in this file.
 *
 * So this double does what the database does: it applies the filter it is
 * handed, honours the keyset cursor, and measures `hasMore` on the MATCHING
 * set — which is the fact the whole footer now rests on.
 */
interface ServedFilter {
  since?: string | null;
  until?: string | null;
  actions?: readonly string[] | null;
  tables?: readonly string[] | null;
}

function serve(rows: ReturnType<typeof entry>[], pageSize = 50): void {
  h.fetchPage.mockImplementation((beforeId: number | null, filter: ServedFilter = {}) => {
    const matches = rows
      .filter((r) => beforeId == null || r.id < beforeId)
      .filter((r) => filter.since == null || Date.parse(r.at) >= Date.parse(filter.since))
      .filter((r) => filter.until == null || Date.parse(r.at) < Date.parse(filter.until))
      .filter((r) => filter.actions == null || filter.actions.includes(r.action))
      .filter((r) => filter.tables == null || filter.tables.includes(r.tableName))
      .sort((a, b) => b.id - a.id);
    return Promise.resolve({
      entries: matches.slice(0, pageSize),
      hasMore: matches.length > pageSize,
    });
  });
}

/** The last filter object the panel sent. */
function lastFilter(): ServedFilter {
  const call = h.fetchPage.mock.calls[h.fetchPage.mock.calls.length - 1];
  return (call?.[1] ?? {}) as ServedFilter;
}

function show(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    (
      <QueryClientProvider client={client}>
        <AuditPanel />
      </QueryClientProvider>
    ) as ReactNode,
  );
}

beforeEach(() => {
  h.state.profile.role = "admin";
  h.state.profile.userId = ADMIN_USER;
  h.state.sessionLoading = false;
  h.fetchPage.mockReset();
  h.fetchActors.mockReset();
  h.fetchPage.mockResolvedValue({ entries: [entry()], hasMore: false });
  // `audit_actor_identities()` (0046) returns an object per actor, not a role
  // string — the shape that let 0047's `display_name` be added without touching
  // a caller. `displayName` is null here because that is what every live row
  // carries: the column exists and nothing writes it yet.
  h.fetchActors.mockResolvedValue(
    new Map([[ADMIN_USER, { role: "admin", email: "admin@example.test", displayName: null }]]),
  );
});

describe("the screen answers what changed, when, and who did it", () => {
  it("shows a change as a sentence a person can read, not as a jsonb dump", async () => {
    show();
    expect(await screen.findByText("Product added")).toBeTruthy();
    // ⚠️ ASSERTED ON THE CELL, NOT ON THE PAGE, because "Widget X" legitimately
    // appears TWICE on an insert: once as the subject and once as the value the
    // `name` column arrived with. Dropping the second to make a page-wide
    // `getByText` work would mean hiding a field from an audit log to tidy a
    // test — the wrong way round.
    const cells = screen.getAllByRole("cell");
    expect(cells[2].textContent).toBe("Product addedWidget X");
    // The raw column names and the braces must not reach the screen.
    expect(screen.queryByText(/table_name/)).toBe(null);
    expect(screen.queryByText(/\{"name"/)).toBe(null);
  });

  it("says when, using the org's date format", async () => {
    show();
    // The seam is mocked to the `iso` token, so the day reads YYYY-MM-DD.
    await screen.findByText("Product added");
    expect(screen.getByRole("table").textContent).toContain("2026-09-0");
  });

  it("names the reader's own change as theirs", async () => {
    show();
    expect(await screen.findByText("You")).toBeTruthy();
  });

  it("⭐ names somebody else by their ADDRESS when the server could supply one", async () => {
    // The maintainer's actual complaint about the first version: *"the who needs
    // to show a user, it is currently not that helpful."* Migration 0046 made
    // this answerable; this is the case that says the screen uses the answer.
    //
    // ⚠️ AND IT IS STILL THE ORDINARY CASE AFTER 0047. `display_name` is null on
    // every live row, so the address is the rung the screen actually stands on
    // until somebody decides how names get written.
    h.fetchPage.mockResolvedValue({ entries: [entry({ actorId: OTHER_USER })], hasMore: false });
    h.fetchActors.mockResolvedValue(
      new Map([
        [OTHER_USER, { role: "supervisor", email: "marco@example.test", displayName: null }],
      ]),
    );
    show();
    await screen.findByText("Product added");
    expect(screen.getByText("marco@example.test")).toBeTruthy();
    // and the role-and-tail fallback is GONE, not merely joined by the address —
    // two answers to "who" in one cell is the thing this replaced.
    expect(screen.getByRole("table").textContent).not.toContain("Supervisor");
  });

  /**
   * ⭐⭐ THE NAME WINS (migration 0047). *"add display_name to user_profiles
   * too."* The same one-answer rule the case above states, one rung up: the
   * address does not survive beside the name any more than the role survived
   * beside the address.
   */
  it("⭐ names somebody by their NAME when the company has given them one", async () => {
    h.fetchPage.mockResolvedValue({ entries: [entry({ actorId: OTHER_USER })], hasMore: false });
    h.fetchActors.mockResolvedValue(
      new Map([
        [
          OTHER_USER,
          { role: "supervisor", email: "marco@example.test", displayName: "Marco Rossi" },
        ],
      ]),
    );
    show();
    await screen.findByText("Product added");
    expect(screen.getByText("Marco Rossi")).toBeTruthy();
    const table = screen.getByRole("table").textContent ?? "";
    expect(table).not.toContain("marco@example.test");
    expect(table).not.toContain("Supervisor");
  });

  it("names somebody else by role, and never as the reader", async () => {
    h.fetchPage.mockResolvedValue({ entries: [entry({ actorId: OTHER_USER })], hasMore: false });
    h.fetchActors.mockResolvedValue(
      new Map([[OTHER_USER, { role: "supervisor", email: null, displayName: null }]]),
    );
    show();
    await screen.findByText("Product added");
    expect(screen.getByRole("table").textContent).toContain("Supervisor");
    expect(screen.queryByText("You")).toBe(null);
  });

  /**
   * ⚠️ THE NAME LOOKUP IS THE ONE READ ALLOWED TO FAIL QUIETLY. It is a
   * decoration on the actor column; the CHANGES are the screen. Letting its
   * failure blank the list would trade the whole feature for a nicety.
   */
  it("still lists the changes when the actor lookup fails", async () => {
    h.fetchActors.mockRejectedValue(new Error("nope"));
    show();
    expect(await screen.findByText("Product added")).toBeTruthy();
  });

  it("shows the fields that moved, both sides", async () => {
    h.fetchPage.mockResolvedValue({
      entries: [
        entry({
          action: "update",
          tableName: "operators",
          before: { display_name: "Alex Green", active: true },
          after: { display_name: "Alex Green", active: false },
        }),
      ],
      hasMore: false,
    });
    show();
    await screen.findByText("Operator changed");
    const table = screen.getByRole("table").textContent ?? "";
    expect(table).toContain("Active");
    expect(table).toContain("yes");
    expect(table).toContain("no");
    expect(table).toContain("→");
  });
});

/* ===========================================================================
 * THE CEILING. See the header.
 * ======================================================================== */
describe("the screen never misrepresents how much of the log it is showing", () => {
  it("says plainly that it is showing the most recent changes, with a count", async () => {
    show();
    await screen.findByText("Product added");
    // The exact number is the number of rows actually on screen, so the
    // sentence cannot drift from the list it describes.
    expect(screen.getByText(/most recent 1 change/i)).toBeTruthy();
  });

  it("offers older changes when there are more, and fetches them from the last id", async () => {
    h.fetchPage.mockResolvedValueOnce({ entries: [entry({ id: 233 })], hasMore: true });
    h.fetchPage.mockResolvedValueOnce({
      entries: [
        entry({
          id: 100,
          tableName: "runs",
          action: "delete",
          before: { notes: "x" },
          after: null,
        }),
      ],
      hasMore: false,
    });
    show();
    const older = await screen.findByRole("button", { name: /older/i });
    fireEvent.click(older);
    expect(await screen.findByText("Run deleted")).toBeTruthy();
    // ⚠️ KEYSET, NOT OFFSET. The cursor is the last id ON SCREEN; an offset
    // would skip or repeat a row every time a change lands while somebody is
    // reading, which is the normal case for a live log.
    expect(h.fetchPage).toHaveBeenLastCalledWith(233, NO_FILTER);
    // Both pages stay on screen; "load older" appends, it does not replace.
    expect(screen.getByText("Product added")).toBeTruthy();
  });

  it("says when there is nothing older, instead of an button that does nothing", async () => {
    show();
    await screen.findByText("Product added");
    expect(screen.queryByRole("button", { name: /older/i })).toBe(null);
    expect(screen.getByText(/whole log/i)).toBeTruthy();
  });

  it("distinguishes an empty log from a failed read", async () => {
    h.fetchPage.mockResolvedValue({ entries: [], hasMore: false });
    show();
    expect(await screen.findByText(/nothing has been changed yet/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBe(null);
  });

  /**
   * ⚠️⚠️ D91 ONE COMPONENT OVER, AND IT IS THE THIRD TIME ON THIS PROJECT.
   * With `enabled: false` React Query v5 reports `isPending` with
   * `fetchStatus: "idle"`, so `isLoading` is FALSE while the session is still
   * resolving. Gating the query without widening the loading condition means the
   * screen renders its EMPTY state for a beat — and this screen's empty state is
   * the sentence "nothing has been changed yet", which is a claim about the
   * company, asserted before a single row has been asked for.
   */
  it("does not claim the log is empty while the session is still resolving", () => {
    h.state.sessionLoading = true;
    show();
    expect(screen.queryByText(/nothing has been changed yet/i)).toBe(null);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(h.fetchPage).not.toHaveBeenCalled();
  });

  /**
   * ⚠️⚠️ A PAGE CAN COME BACK EMPTY WITHOUT THE LOG BEING FINISHED.
   * `fetchAuditPage` drops any row `parseAuditEntry` refuses — a row with no
   * usable `id`, an action outside the CHECK constraint — so a page of fifty
   * such rows arrives as no entries and `hasMore: true`. That is the one state
   * in which the screen knows LEAST, and both of the sentences it could reach
   * for are claims it cannot support: "nothing has been changed yet" is about
   * the company, and "this is the whole log" is about the read.
   */
  it("does not call a page it could not read an empty log, or the whole one", async () => {
    h.fetchPage.mockResolvedValue({ entries: [], hasMore: true });
    show();
    await waitFor(() =>
      expect(/there are older ones/i.test(document.body.textContent ?? "")).toBe(true),
    );
    const page = document.body.textContent ?? "";
    expect(/nothing has been changed yet/i.test(page)).toBe(false);
    expect(/whole log/i.test(page)).toBe(false);
  });

  it("says a failed read failed, and does not call it an empty log", async () => {
    h.fetchPage.mockRejectedValue(new Error("network"));
    show();
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByText(/nothing has been changed yet/i)).toBe(null);
  });
});

/* ===========================================================================
 * WHO GETS DATA. See the header, point 1.
 * ======================================================================== */
describe("the panel refuses what the server would refuse", () => {
  /**
   * ⚠️⚠️ `adminSectionsFor` RETURNS "all" FOR A SITE ADMIN, so the rail alone
   * cannot express "company admin only" — `AdminPage`'s `companyAdminOnly` flag
   * does, exactly as it does for Settings. This is the second gate, in the
   * panel, so a site admin who reaches this pane by any route is TOLD, not shown
   * an empty list they would reasonably read as "nothing has ever changed".
   */
  it("tells a site admin the log is not theirs to read, and fires no query", async () => {
    h.state.profile.role = "viewer";
    show();
    expect(await screen.findByText(/only a system admin/i)).toBeTruthy();
    expect(h.fetchPage).not.toHaveBeenCalled();
    // The empty-log sentence would be a lie: the log is not empty, it is
    // filtered to nothing by RLS.
    expect(screen.queryByText(/nothing has been changed yet/i)).toBe(null);
  });

  it("a supervisor is refused for the same reason", async () => {
    h.state.profile.role = "supervisor";
    show();
    expect(await screen.findByText(/only a system admin/i)).toBeTruthy();
    expect(h.fetchPage).not.toHaveBeenCalled();
  });
});

describe("the screen says which columns it does not list", () => {
  /**
   * ⚠️ AN AUDIT LOG THAT SILENTLY OMITS FIELDS IS WORSE THAN ONE THAT DUMPS
   * JSON. Four bookkeeping columns are left out of every change list
   * (`id`, `org_id`, `created_at`, `updated_at` — `updated_at` moves on every
   * single update and would put one meaningless line on every row). That is a
   * defensible choice ONLY if the screen admits it.
   */
  it("names the omission rather than hiding it", async () => {
    show();
    await screen.findByText("Product added");
    const note = screen.getByText(/updated_at/);
    expect(within(note).queryByText("nothing")).toBe(null);
    expect(note.textContent).toContain("org_id");
  });
});

/* ===========================================================================
 * NARROWING THE LOG — AND THE ONE WAY A FILTER CAN LIE.
 *
 * ⭐⭐ THE LIST IS KEYSET-PAGED, SO A FILTER APPLIED TO A PAGE IS NOT A FILTER
 * ON THE LOG. A reader who picks "removals, last 7 days" and is shown whatever
 * removals happen to sit in the newest fifty rows — under a footer that counts
 * them as if that were the answer — has been told something false about their
 * own history, in the one screen whose entire job is to be trustworthy about
 * the past.
 *
 * ⭐⭐⭐ THE FILTER IS NOW IN THE QUERY, AND THAT CHANGED WHAT THE FOOTER RESTS
 * ON. `fetchAuditPage` takes the period, the action and the table and sends
 * `.gte("at", …)`, `.lt("at", …)` and `.in(…)`, so a page is fifty MATCHES and
 * `hasMore` means *"older MATCHING rows exist"*. The word "all" is therefore
 * licensed by exactly one fact — the server saying there are no more matches —
 * rather than by the old argument from ordering, which had to read PAST the
 * period's edge and then reason that nothing unread could still be inside it.
 *
 * ⚠️ THE OLD ARGUMENT ALSO CARRIED AN ASSUMPTION NOBODY HAD WRITTEN DOWN: that
 * `at` rises with `id`. Two rows written in ONE transaction share `at` exactly,
 * and a transaction that starts before another and commits after it takes its
 * `at` from its start — so a row INSIDE the period can sit below a row outside
 * it, and "the scan reached something older than the cutoff" would have
 * declared the search finished with that row unread. A predicate in the query
 * has no such assumption: `id < cursor` is a boundary, the filter is a test on
 * each row, and neither depends on the other.
 *
 * ⚠️ WHICH IS ALSO WHY A PERIOD WITH BOTH ENDS CAN BE OFFERED AT LAST. Nothing
 * about "yesterday" is a prefix of a newest-first read; it is a middle slice.
 * The server does not care.
 * ======================================================================== */
function agoIso(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

/** Midnight this morning, in the reader's own timezone — where "yesterday"
 *  ends. Written out here rather than imported, so the case states the
 *  DEFINITION of the period and not the panel's arithmetic. */
function localMidnight(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

describe("the reader can narrow the log", () => {
  it("offers a time period and a kind-of-change filter", async () => {
    show();
    await screen.findByText("Product added");
    expect(screen.getByLabelText(/time period/i)).toBeTruthy();
    expect(screen.getByLabelText(/kind of change/i)).toBeTruthy();
  });

  /**
   * ⭐⭐ THE POINT OF THE WHOLE CHANGE, PINNED ON THE CALL. A panel that had
   * quietly gone back to filtering its own rows would pass every case below
   * this one on a fixture this small; only the request shows it.
   */
  it("⭐ asks the SERVER to narrow, rather than reading rows to throw them away", async () => {
    serve([entry({ id: 300, at: agoIso(2) })]);
    show();
    await screen.findByText("Product added");
    expect(h.fetchPage).toHaveBeenLastCalledWith(null, NO_FILTER);

    fireEvent.change(screen.getByLabelText(/time period/i), { target: { value: "7d" } });
    await waitFor(() => expect(lastFilter().since).toBeTruthy());
    const since = Date.parse(lastFilter().since ?? "");
    expect(Math.round((Date.now() - since) / 3600_000)).toBe(24 * 7);
    // A now-anchored period has no upper end: "and everything since".
    expect(lastFilter().until ?? null).toBe(null);

    fireEvent.change(screen.getByLabelText(/kind of change/i), { target: { value: "delete" } });
    await waitFor(() => expect(lastFilter().actions).toEqual(["delete"]));

    fireEvent.change(screen.getByLabelText(/kind of thing/i), { target: { value: "products" } });
    await waitFor(() => expect(lastFilter().tables).toEqual(["products"]));
  });

  it("hides changes outside the chosen time period", async () => {
    serve([
      entry({ id: 300, at: agoIso(2) }),
      entry({ id: 200, at: agoIso(24 * 40), tableName: "runs", action: "delete" }),
    ]);
    show();
    await screen.findByText("Product added");
    expect(screen.getByText("Run deleted")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/time period/i), { target: { value: "7d" } });
    await waitFor(() => expect(screen.queryByText("Run deleted")).toBe(null));
    expect(await screen.findByText("Product added")).toBeTruthy();
  });

  it("hides changes that are not the chosen kind of change", async () => {
    serve([
      entry({ id: 300, at: agoIso(2) }),
      entry({ id: 200, at: agoIso(3), tableName: "runs", action: "delete" }),
    ]);
    show();
    await screen.findByText("Product added");
    fireEvent.change(screen.getByLabelText(/kind of change/i), { target: { value: "delete" } });
    expect(await screen.findByText("Run deleted")).toBeTruthy();
    expect(screen.queryByText("Product added")).toBe(null);
  });

  /** A filter that empties the view has not emptied the company's history. */
  it("does not call a filtered-empty list an empty log", async () => {
    serve([entry({ at: agoIso(2) })]);
    show();
    await screen.findByText("Product added");
    fireEvent.change(screen.getByLabelText(/kind of change/i), { target: { value: "delete" } });
    await waitFor(() => expect(screen.queryByText("Product added")).toBe(null));
    expect(screen.queryByText(/nothing has been changed yet/i)).toBe(null);
  });

  /**
   * ⚠️⚠️ THE TRAP THE SERVER-SIDE FILTER OPENS, AND IT IS A ONE-WAY DOOR FOR
   * THE READER. The kind picker is built from the rows the screen has actually
   * read, because the audited set is decided by triggers and a hand-written
   * list here would go blind to a seventh table. Once the SERVER does the
   * narrowing, the rows read under "Products" are all products — so a picker
   * rebuilt from them offers "Products" and nothing else, and there is no
   * control left to undo the filter with. What it has seen is remembered.
   */
  it("⭐ keeps every kind it has seen in the picker, so a filter can be undone", async () => {
    serve([
      entry({ id: 300, at: agoIso(2) }),
      entry({ id: 200, at: agoIso(3), tableName: "runs", action: "delete" }),
    ]);
    show();
    await screen.findByText("Run deleted");
    const kind = screen.getByLabelText(/kind of thing/i);
    fireEvent.change(kind, { target: { value: "products" } });
    await waitFor(() => expect(screen.queryByText("Run deleted")).toBe(null));
    const options = within(kind)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toContain("Run");
    expect(options).toContain("Product");
    // and the reader can actually get back
    fireEvent.change(kind, { target: { value: "all" } });
    expect(await screen.findByText("Run deleted")).toBeTruthy();
  });

  /**
   * ⭐⭐ A PERIOD WITH BOTH ENDS, WHICH THIS SCREEN COULD NOT OFFER BEFORE.
   * "Yesterday" sits in the MIDDLE of the log: it is not a prefix of a
   * newest-first read, so no amount of reading from the top proved it finished
   * while the browser was doing the filtering. The server does not care where
   * the slice sits.
   */
  it("⭐ offers a period with both ends, and asks the server for both", async () => {
    serve([entry({ id: 300, at: agoIso(2) })]);
    show();
    await screen.findByText("Product added");
    const picker = screen.getByLabelText(/time period/i);
    const labels = within(picker)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(labels).toContain("Yesterday");

    fireEvent.change(picker, { target: { value: "yesterday" } });
    await waitFor(() => expect(lastFilter().until).toBeTruthy());
    const until = localMidnight();
    const since = new Date(until);
    since.setDate(since.getDate() - 1);
    // ⚠️ THE READER'S OWN TIMEZONE, because the When column is in it too: a
    // "yesterday" that meant UTC would disagree with the dates on screen.
    expect(lastFilter().since).toBe(since.toISOString());
    // Exclusive at the top: today's changes belong to today.
    expect(lastFilter().until).toBe(until.toISOString());
  });
});

describe("a filter never claims to have searched more of the log than it has", () => {
  /**
   * ⚠️⚠️ THE FAILURE THIS PINS, AND IT DID NOT GO AWAY WITH THE ROUND TRIPS.
   * The server returns a PAGE of matches, not every match. While more matching
   * rows exist behind the cursor, the count on screen is not the answer, and
   * the screen must not dress it as one.
   */
  it("does not say `all` while the server says older matches exist", async () => {
    serve(
      [
        entry({
          id: 300,
          at: agoIso(1),
          tableName: "runs",
          action: "delete",
          before: { notes: "a" },
          after: null,
        }),
        entry({
          id: 290,
          at: agoIso(2),
          tableName: "runs",
          action: "delete",
          before: { notes: "b" },
          after: null,
        }),
        entry({
          id: 280,
          at: agoIso(3),
          tableName: "runs",
          action: "delete",
          before: { notes: "c" },
          after: null,
        }),
      ],
      2,
    );
    show();
    await screen.findAllByText("Run deleted");
    fireEvent.change(screen.getByLabelText(/kind of change/i), { target: { value: "delete" } });
    // The page holds two of the three matches, and the sentence says exactly
    // that — a count of what is shown, never of what exists.
    await waitFor(() =>
      expect(
        /Showing the 2 most recent matching changes in the log\. There are older ones\./.test(
          document.body.textContent ?? "",
        ),
      ).toBe(true),
    );
    const page = document.body.textContent ?? "";
    expect(screen.getAllByText("Run deleted").length).toBe(2);
    expect(/showing all/i.test(page)).toBe(false);
    expect(/has been searched/i.test(page)).toBe(false);
    expect(/whole log/i.test(page)).toBe(false);
    // and the control that reads further is still there
    expect(screen.getByRole("button", { name: /older/i })).toBeTruthy();
  });

  /**
   * ⭐⭐ THE OTHER HALF, AND IT IS NOW ONE ROUND TRIP. `hasMore: false` on a
   * FILTERED read is the server saying there is no older row that matches — so
   * the search is finished, whatever the period was and wherever it sits.
   */
  it("says the period is complete as soon as the server has no more matches", async () => {
    serve([
      entry({ id: 300, at: agoIso(2) }),
      entry({ id: 200, at: agoIso(24 * 40), tableName: "runs", action: "delete" }),
    ]);
    show();
    await screen.findByText("Product added");
    fireEvent.change(screen.getByLabelText(/time period/i), { target: { value: "7d" } });
    await waitFor(() =>
      expect(
        /whole of the last 7 days has been searched/i.test(document.body.textContent ?? ""),
      ).toBe(true),
    );
    expect(screen.queryByText("Run deleted")).toBe(null);
    expect(screen.getByText("Product added")).toBeTruthy();
    // ⚠️ NO BUTTON: there are older changes in the log, but none of them can
    // match, so offering to search for them would be offering work that cannot
    // change the answer.
    expect(screen.queryByRole("button", { name: /older/i })).toBe(null);
  });

  /**
   * ⭐⭐ AND THE SELF-READ IS GONE, WHICH IS THE COST HALF OF THE SAME CHANGE.
   * The panel used to page towards the period's floor by itself — up to ten
   * requests — because that walk was the only way to earn the word "all". With
   * the filter in the query the first page already carries the proof, so a
   * chosen period costs ONE request. Ten would now be ten pages of matches
   * nobody asked to see.
   */
  it("⭐ costs one request per filter, not ten", async () => {
    serve([entry({ id: 300, at: agoIso(1) })]);
    show();
    await screen.findByText("Product added");
    h.fetchPage.mockClear();
    fireEvent.change(screen.getByLabelText(/time period/i), { target: { value: "7d" } });
    await waitFor(() =>
      expect(/has been searched/i.test(document.body.textContent ?? "")).toBe(true),
    );
    expect(h.fetchPage.mock.calls.length).toBe(1);
  });

  /**
   * A filtered-empty answer is now a COMPLETE answer — the server searched the
   * period and found nothing — and it must read as one, without ever borrowing
   * the sentence that describes an empty company.
   */
  it("calls an empty result what it is: a finished search of that period", async () => {
    serve([entry({ id: 300, at: agoIso(2) })]);
    show();
    await screen.findByText("Product added");
    fireEvent.change(screen.getByLabelText(/kind of change/i), { target: { value: "delete" } });
    await waitFor(() =>
      expect(/no changes match this filter/i.test(document.body.textContent ?? "")).toBe(true),
    );
    const page = document.body.textContent ?? "";
    expect(/the whole of the log has been searched/i.test(page)).toBe(true);
    expect(/nothing has been changed yet/i.test(page)).toBe(false);
    // The controls survive a filter that empties the table, or the reader is
    // stuck looking at nothing.
    expect(screen.getByLabelText(/kind of change/i)).toBeTruthy();
  });

  it("finishes a bounded period the same way it finishes a now-anchored one", async () => {
    const until = localMidnight();
    const inYesterday = new Date(until.getTime() - 3600_000).toISOString();
    serve([
      entry({ id: 300, at: agoIso(1) }),
      entry({ id: 250, at: inYesterday, tableName: "runs", action: "delete" }),
    ]);
    show();
    await screen.findByText("Product added");
    fireEvent.change(screen.getByLabelText(/time period/i), { target: { value: "yesterday" } });
    expect(await screen.findByText("Run deleted")).toBeTruthy();
    expect(screen.queryByText("Product added")).toBe(null);
    expect(/whole of yesterday has been searched/i.test(document.body.textContent ?? "")).toBe(
      true,
    );
  });
});

/* ===========================================================================
 * A DELETION AT A GLANCE.
 *
 * The maintainer, on the Change column: *"I see a few rows which are crossed or
 * cut, we could have a red card border for the row to signify deletion."* The
 * crossing-out is how a REPLACED value reads (`Active: yes -> no`); on a DELETE
 * every field is struck at once, which reads as damage rather than as a removal.
 *
 * ⚠️ COLOUR NEVER CARRIES THE MEANING ALONE. The accent is an addition to the
 * word already in the What column ("Run deleted"), not a replacement for it, so
 * the row survives a colour-blind reader and a black-and-white print. All three
 * actions get one, so a reader learns one system rather than one exception.
 * ======================================================================== */
describe("a deletion is visible at a glance", () => {
  it("marks every row with the action it records", async () => {
    h.fetchPage.mockResolvedValue({
      entries: [
        entry({ id: 300 }),
        entry({ id: 250, action: "update", before: { name: "a" }, after: { name: "b" } }),
        entry({
          id: 200,
          tableName: "runs",
          action: "delete",
          before: { notes: "x" },
          after: null,
        }),
      ],
      hasMore: false,
    });
    show();
    await screen.findByText("Run deleted");
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => r.getAttribute("data-action"))).toEqual(["insert", "update", "delete"]);
  });

  it("keeps the word beside the accent, so colour is never the only signal", async () => {
    h.fetchPage.mockResolvedValue({
      entries: [
        entry({
          id: 200,
          tableName: "runs",
          action: "delete",
          before: { notes: "x" },
          after: null,
        }),
      ],
      hasMore: false,
    });
    show();
    const row = (await screen.findByText("Run deleted")).closest("tr");
    expect(row?.getAttribute("data-action")).toBe("delete");
    expect(row?.textContent).toContain("deleted");
  });

  /* The two rules below are properties of the STYLESHEET, and jsdom applies no
     CSS (`css: false` in vitest.config.ts), so they are read from the file the
     way `scaleAudit` and `fieldStandard` read theirs. A rule nothing asserts is
     a rule that gets deleted in a tidy-up. */
  it("reserves red for a removal and gives each action its own accent", () => {
    const clean = fs
      .readFileSync(`${process.cwd()}/${PANEL_CSS}`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = new Map<string, string>();
    for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      rules.set(m[1].trim().replace(/\s+/g, " "), m[2]);
    }
    for (const action of ["insert", "update", "delete"]) {
      const sel = `.row[data-action="${action}"]`;
      const body = rules.get(sel);
      expect(body, `${sel} must set its own accent colour`).toBeTruthy();
      expect(/border-left-color\s*:/.test(body ?? "")).toBe(true);
    }
    expect(rules.get('.row[data-action="delete"]')).toContain("--crit");
    expect(rules.get('.row[data-action="insert"]')).not.toContain("--crit");
    expect(rules.get('.row[data-action="update"]')).not.toContain("--crit");
    // Every row gets a bar, so the accent is a signal and not a width change.
    expect(/\.row\s*\{[^}]*border-left:/.test(clean)).toBe(true);
  });

  it("does not strike through the fields of a deleted row", () => {
    const clean = fs
      .readFileSync(`${process.cwd()}/${PANEL_CSS}`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // The strikethrough stays where it is doing real work — the replaced side of
    // an edit — and is switched off inside a delete, where every field would
    // carry it and none of them is a replacement.
    expect(/\.from\s*\{[^}]*text-decoration:\s*line-through/.test(clean)).toBe(true);
    const off = /\.row\[data-action="delete"\]\s+\.from\s*\{([^}]*)\}/.exec(clean);
    expect(off, "a delete row must switch the strikethrough off").toBeTruthy();
    expect(/text-decoration:\s*none/.test(off?.[1] ?? "")).toBe(true);
  });
});
