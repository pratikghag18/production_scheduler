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
import { AUDIT_AUTO_SCAN_PAGES, AuditPanel } from "@/features/admin/components/AuditPanel";

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
  // string — the shape that lets a `display_name` be added later without
  // touching a caller.
  h.fetchActors.mockResolvedValue(
    new Map([[ADMIN_USER, { role: "admin", email: "admin@example.test" }]]),
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
    h.fetchPage.mockResolvedValue({ entries: [entry({ actorId: OTHER_USER })], hasMore: false });
    h.fetchActors.mockResolvedValue(
      new Map([[OTHER_USER, { role: "supervisor", email: "marco@example.test" }]]),
    );
    show();
    await screen.findByText("Product added");
    expect(screen.getByText("marco@example.test")).toBeTruthy();
    // and the role-and-tail fallback is GONE, not merely joined by the address —
    // two answers to "who" in one cell is the thing this replaced.
    expect(screen.getByRole("table").textContent).not.toContain("Supervisor");
  });

  it("names somebody else by role, and never as the reader", async () => {
    h.fetchPage.mockResolvedValue({ entries: [entry({ actorId: OTHER_USER })], hasMore: false });
    h.fetchActors.mockResolvedValue(new Map([[OTHER_USER, { role: "supervisor", email: null }]]));
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
    expect(h.fetchPage).toHaveBeenLastCalledWith(233);
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
 * ON THE LOG. `fetchAuditPage` returns fifty ROWS, not fifty MATCHES. A reader
 * who picks "removals, last 7 days" and is shown whatever removals happen to sit
 * in the newest fifty rows — under a footer that counts them as if that were the
 * answer — has been told something false about their own history, and told it in
 * the one screen whose entire job is to be trustworthy about the past.
 *
 * So the screen distinguishes TWO facts it must never confuse:
 *   - how many rows it has READ from the log (the scan), and
 *   - how many of those MATCH the filter.
 * and it may only ever use the word "all" once it can prove the scan covered
 * every row the filter could have matched.
 *
 * ⚠️ THE PROOF IS THE ORDERING. The log is read newest-first on `id`, and every
 * period offered is anchored at NOW — "last 24 hours", "last 7 days", "last 30
 * days". Rows inside such a period are therefore a PREFIX of the scan: the
 * moment the scan reaches a row older than the cutoff, every matching row has
 * already been read, and the screen can say "all". A period that did NOT end at
 * now (say "August") would sit in the middle of the log and could not be
 * completed without reading everything newer, which is why none is offered.
 *
 * ⚠️ "ALL TIME" HAS NO CUTOFF, so under a filter it is complete only when the
 * whole log has been read. Until then the footer says what it actually searched.
 * ======================================================================== */
function agoIso(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

describe("the reader can narrow the log", () => {
  it("offers a time period and a kind-of-change filter", async () => {
    show();
    await screen.findByText("Product added");
    expect(screen.getByLabelText(/time period/i)).toBeTruthy();
    expect(screen.getByLabelText(/kind of change/i)).toBeTruthy();
  });

  it("hides changes outside the chosen time period", async () => {
    h.fetchPage.mockResolvedValue({
      entries: [
        entry({ id: 300, at: agoIso(2) }),
        entry({ id: 200, at: agoIso(24 * 40), tableName: "runs", action: "delete" }),
      ],
      hasMore: false,
    });
    show();
    await screen.findByText("Product added");
    expect(screen.getByText("Run deleted")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/time period/i), { target: { value: "7d" } });
    expect(screen.queryByText("Run deleted")).toBe(null);
    expect(screen.getByText("Product added")).toBeTruthy();
  });

  it("hides changes that are not the chosen kind of change", async () => {
    h.fetchPage.mockResolvedValue({
      entries: [
        entry({ id: 300, at: agoIso(2) }),
        entry({ id: 200, at: agoIso(3), tableName: "runs", action: "delete" }),
      ],
      hasMore: false,
    });
    show();
    await screen.findByText("Product added");
    fireEvent.change(screen.getByLabelText(/kind of change/i), { target: { value: "delete" } });
    expect(screen.getByText("Run deleted")).toBeTruthy();
    expect(screen.queryByText("Product added")).toBe(null);
  });

  /** A filter that empties the view has not emptied the company's history. */
  it("does not call a filtered-empty list an empty log", async () => {
    h.fetchPage.mockResolvedValue({ entries: [entry({ at: agoIso(2) })], hasMore: false });
    show();
    await screen.findByText("Product added");
    fireEvent.change(screen.getByLabelText(/kind of change/i), { target: { value: "delete" } });
    expect(screen.queryByText("Product added")).toBe(null);
    expect(screen.queryByText(/nothing has been changed yet/i)).toBe(null);
  });
});

describe("a filter never claims to have searched more of the log than it has", () => {
  /**
   * ⚠️⚠️ THE FAILURE THIS PINS. All time + "removals", one page read, more rows
   * behind it, no removal in the page. The tempting screen says "no removals" —
   * a statement about the whole company drawn from fifty rows. It must instead
   * say what it searched, and keep the control that searches further.
   */
  it("says what it searched rather than answering, when older rows are unread", async () => {
    h.fetchPage.mockResolvedValue({ entries: [entry({ at: agoIso(2) })], hasMore: true });
    show();
    await screen.findByText("Product added");
    fireEvent.change(screen.getByLabelText(/kind of change/i), { target: { value: "delete" } });
    const page = document.body.textContent ?? "";
    expect(/have not been searched/i.test(page)).toBe(true);
    // Never the words that would make it an answer about the whole log.
    expect(/whole log/i.test(page)).toBe(false);
    expect(screen.getByRole("button", { name: /older/i })).toBeTruthy();
  });

  /**
   * The other half, and the reason a period is worth having: a period anchored
   * at now IS completable against a newest-first scan. The screen reads on by
   * itself until it passes the cutoff, and only then uses the word "all".
   */
  it("reads on until the chosen period is passed, then says the period is complete", async () => {
    h.fetchPage.mockResolvedValueOnce({
      entries: [entry({ id: 300, at: agoIso(2) })],
      hasMore: true,
    });
    h.fetchPage.mockResolvedValueOnce({
      entries: [entry({ id: 200, at: agoIso(24 * 40), tableName: "runs", action: "delete" })],
      hasMore: true,
    });
    h.fetchPage.mockResolvedValue({ entries: [], hasMore: false });
    show();
    await screen.findByText("Product added");
    fireEvent.change(screen.getByLabelText(/time period/i), { target: { value: "7d" } });
    await waitFor(() => expect(h.fetchPage).toHaveBeenCalledWith(300));
    await waitFor(() =>
      expect(
        /whole of the last 7 days has been searched/i.test(document.body.textContent ?? ""),
      ).toBe(true),
    );
    // The row outside the period is not shown, and the one inside it is.
    expect(screen.queryByText("Run deleted")).toBe(null);
    expect(screen.getByText("Product added")).toBeTruthy();
  });

  /** The self-reading is bounded. An unbounded one is a screen that hammers the
   *  database on a busy company; a bounded one that says so is honest. */
  it("stops reading on by itself after a bounded number of pages, and says so", async () => {
    h.fetchPage.mockResolvedValue({ entries: [entry({ at: agoIso(1) })], hasMore: true });
    show();
    await screen.findByText("Product added");
    fireEvent.change(screen.getByLabelText(/time period/i), { target: { value: "7d" } });
    await waitFor(() => expect(h.fetchPage.mock.calls.length).toBe(AUDIT_AUTO_SCAN_PAGES));
    expect(/have not been searched/i.test(document.body.textContent ?? "")).toBe(true);
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
