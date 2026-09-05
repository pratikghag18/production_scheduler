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
import type { ReactNode } from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuditPanel } from "@/features/admin/components/AuditPanel";

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

vi.mock("@/lib/api", () => ({
  fetchAuditPage: (...args: unknown[]) => h.fetchPage(...args),
  fetchAuditActors: (...args: unknown[]) => h.fetchActors(...args),
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
  h.fetchActors.mockResolvedValue(new Map([[ADMIN_USER, "admin"]]));
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

  it("names somebody else by role, and never as the reader", async () => {
    h.fetchPage.mockResolvedValue({ entries: [entry({ actorId: OTHER_USER })], hasMore: false });
    h.fetchActors.mockResolvedValue(new Map([[OTHER_USER, "supervisor"]]));
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
