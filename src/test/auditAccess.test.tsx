/**
 * WHO IS OFFERED THE ACTIVITY TAB.
 *
 * ⭐⭐ THE POLICY IS THE ONLY AUTHORITY HERE, AND IT IS NARROWER THAN EVERY
 * OTHER ADMIN SCREEN. `audit_log_select` (migration 0008) is
 *
 *     app_is_admin() and org_id = app_current_org()
 *
 * and `app_is_admin()` is `user_profiles.role = 'admin'` for the caller's own
 * profile (0018) — the ORG-WIDE role. A site admin carries the org-wide role
 * `viewer` plus an admin GRANT on their site; `app_is_admin()` is false for
 * them, so their read of `audit_log` returns ZERO ROWS. Not an error, not a
 * refusal: an empty list, which a reader would correctly interpret as "nothing
 * has ever been changed here". That is the failure `CLAUDE.md` §4 names — a
 * screen showing what the server will refuse — in its quietest form.
 *
 * ⚠️ `adminSectionsFor` CANNOT EXPRESS THIS. It returns "all" for anybody with
 * `adminAnywhere`, which is every site admin. The axis that can is
 * `companyAdminOnly`, filtered on `profile.role === "admin"` — the client mirror
 * of `app_is_admin()`, and the SAME predicate the policy runs.
 *
 * ⛔⛔ THIS SUITE USED TO HOLD ACTIVITY AND SETTINGS TOGETHER, AND THAT TIE WAS
 * ITSELF A DEFECT (DEF-0007). Its last case asserted that a site admin got
 * NEITHER tab, "so neither can drift" — true while the two tabs answered the
 * same question, which they stopped doing at migration 0050. `set_node_setting`
 * is `app_is_admin() OR app_is_admin_for(node)`, so the server takes a plant
 * admin's writes on their own plant while this suite asserted the client was
 * right to hide the tab that makes them. A GREEN CASE PINNING THE BUG, exactly
 * the shape CLAUDE.md §4 warns about: the case written to stop drift is what held
 * the stale half in place, and the suite named after the narrower tab is where
 * the wider one quietly acquired its gate.
 *
 * ⭐ SO WHAT THIS SUITE GUARDS NOW IS THE SEPARATION, not the tie. Activity is
 * company-admin-only because its READ goes silently empty; Settings is not,
 * because its WRITE is per node and the panel decides per node. The last case
 * below asserts both directions at once, so a change that re-couples them — in
 * either direction — goes red here.
 *
 * The mocks stop at the network boundary and at the panels, as
 * `adminNoGrants.test.tsx` does: what is under test is AdminPage's own decision
 * about which rail buttons exist.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminPage from "@/features/admin/AdminPage";
import { useAdminViewStore } from "@/features/admin/store/adminView";

const h = vi.hoisted(() => ({
  state: {
    profile: {
      id: "p1",
      userId: "u1",
      orgId: "org-1",
      role: "admin",
      adminAnywhere: true,
    } as Record<string, unknown>,
  },
}));

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: { user: { id: "u1" } },
    profile: h.state.profile,
    loading: false,
  }),
}));

const TREE = {
  templates: [],
  levels: [],
  // A readable place, so the "nothing has been shared with you" branch (which
  // is a DIFFERENT screen) never fires and hides the rail this suite reads.
  nodes: [
    {
      id: "n1",
      name: "Plant 1",
      parentId: null,
      levelId: "lv",
      path: "n1",
      sortOrder: 1,
      active: true,
    },
  ],
  editableShapeIds: [],
  siteNodeIds: {},
  sumsChildren: {},
};

vi.mock("@/lib/api", () => ({
  fetchHierarchyTree: () => Promise.resolve(TREE),
}));

vi.mock("@/features/admin/hooks/useHierarchyMutations", () => ({
  hierarchyKeys: { all: ["hierarchy"] as const },
}));

vi.mock("@/features/admin/components/LevelEditor", () => ({
  LevelEditor: () => <div>stub LevelEditor</div>,
}));
vi.mock("@/features/admin/components/NodeTreeEditor", () => ({
  NodeTreeEditor: () => <div>stub NodeTreeEditor</div>,
}));
vi.mock("@/features/admin/components/ShapePicker", () => ({
  ShapePicker: ({ children }: { children?: ReactNode }) => <div>stub ShapePicker{children}</div>,
}));
vi.mock("@/features/admin/components/SiteAccessPanel", () => ({
  SiteAccessPanel: () => <div>stub SiteAccessPanel</div>,
}));
vi.mock("@/features/admin/components/ShiftsPanel", () => ({
  ShiftsPanel: () => <div>stub ShiftsPanel</div>,
  SHIFTS_PANEL_READY: true,
}));
vi.mock("@/features/admin/components/OperatorsPanel", () => ({
  OperatorsPanel: () => <div>stub OperatorsPanel</div>,
  OPERATORS_PANEL_READY: true,
}));
vi.mock("@/features/admin/components/TrainingsPanel", () => ({
  TrainingsPanel: () => <div>stub TrainingsPanel</div>,
  TRAININGS_PANEL_READY: true,
}));
vi.mock("@/features/admin/components/MatrixPanel", () => ({
  MatrixPanel: () => <div>stub MatrixPanel</div>,
  MATRIX_PANEL_READY: true,
}));
vi.mock("@/features/admin/components/ProductsPanel", () => ({
  ProductsPanel: () => <div>stub ProductsPanel</div>,
  PRODUCTS_PANEL_READY: true,
}));
vi.mock("@/features/admin/components/CycleTimesPanel", () => ({
  CycleTimesPanel: () => <div>stub CycleTimesPanel</div>,
  CYCLE_TIMES_PANEL_READY: true,
}));
vi.mock("@/features/admin/components/ImportPanel", () => ({
  ImportPanel: () => <div>stub ImportPanel</div>,
  IMPORT_PANEL_READY: true,
}));
vi.mock("@/features/admin/components/SettingsPanel", () => ({
  SettingsPanel: () => <div>stub SettingsPanel</div>,
  SETTINGS_PANEL_READY: true,
}));
vi.mock("@/features/admin/components/AuditPanel", () => ({
  AuditPanel: () => <div>stub AuditPanel</div>,
  AUDIT_PANEL_READY: true,
}));

function show(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <AdminPage />
    </QueryClientProvider>,
  );
}

function railButton(name: string): HTMLElement | null {
  return screen.queryByRole("button", { name });
}

beforeEach(() => {
  h.state.profile = { id: "p1", userId: "u1", orgId: "org-1", role: "admin", adminAnywhere: true };
  useAdminViewStore.setState({ plantChoice: null, hydratedOrgId: null });
});

describe("the Activity tab is offered to exactly the people the policy admits", () => {
  it("a company admin gets it", async () => {
    show();
    expect(await screen.findByRole("button", { name: "Activity" })).toBeTruthy();
  });

  it("a company admin who opens it gets the panel", async () => {
    show();
    (await screen.findByRole("button", { name: "Activity" })).click();
    expect(await screen.findByText("stub AuditPanel")).toBeTruthy();
  });

  /**
   * ⚠️⚠️ THE CASE THE WHOLE `companyAdminOnly` AXIS EXISTS FOR. This person has
   * `adminAnywhere`, so `adminSectionsFor` says "all" and every other tab is
   * theirs. `app_is_admin()` is still false, so `audit_log` would hand them an
   * empty list — the quiet lie.
   */
  it("a SITE admin does not, even though every other tab is theirs", async () => {
    h.state.profile = {
      id: "p1",
      userId: "u1",
      orgId: "org-1",
      role: "viewer",
      adminAnywhere: true,
    };
    show();
    // The rail rendered, and the other tabs are there — so an absent Activity
    // button is a decision, not a failed render.
    expect(await screen.findByRole("button", { name: "Hierarchy" })).toBeTruthy();
    expect(railButton("Operators")).toBeTruthy();
    expect(railButton("Activity")).toBe(null);
    expect(screen.queryByText("stub AuditPanel")).toBe(null);
  });

  it("a supervisor does not", async () => {
    h.state.profile = {
      id: "p1",
      userId: "u1",
      orgId: "org-1",
      role: "supervisor",
      adminAnywhere: false,
    };
    show();
    expect(await screen.findByRole("button", { name: "Operators" })).toBeTruthy();
    expect(railButton("Activity")).toBe(null);
  });

  /**
   * ⛔⛔ THE CASE THAT REPLACES THE ONE THAT PINNED DEF-0007. It used to read
   * "Settings and Activity are gated by the same test, so neither can drift"
   * and assert both were null. They are NOT the same question:
   *
   *   Activity  → `audit_log_select` = `app_is_admin() and org_id = ...`
   *               a site admin gets ZERO ROWS. Hide it.
   *   Settings  → `set_node_setting` = `app_is_admin() OR app_is_admin_for(n)`
   *               a site admin's write on their OWN plant is TAKEN. Offer it.
   *
   * The same person, the same rail, opposite answers — which is the whole
   * content of the fix, so it is asserted in ONE case rather than two that
   * could be changed one at a time.
   */
  it("Settings and Activity are gated by DIFFERENT tests, and this person shows why", async () => {
    h.state.profile = {
      id: "p1",
      userId: "u1",
      orgId: "org-1",
      role: "viewer",
      adminAnywhere: true,
    };
    show();
    await screen.findByRole("button", { name: "Hierarchy" });
    // The server takes her writes on her own plant (R-333), so the tab exists;
    // WHICH scope she may edit is the panel's question, not the rail's.
    expect(railButton("Settings")).not.toBe(null);
    // The server hands her an empty list, so the tab does not.
    expect(railButton("Activity")).toBe(null);
  });
});
