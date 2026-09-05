import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminPage from "@/features/admin/AdminPage";
import { useAdminViewStore } from "@/features/admin/store/adminView";

/**
 * ⭐⭐ THE ADMIN SCREEN WHEN THE SERVER HAS HANDED BACK NOTHING (session 19's
 * "supervisor with no grants reaches an empty admin screen").
 *
 * `adminAccess` admits a supervisor on purpose (D114) and says so in its own
 * comment: *"this admits a supervisor with no grants at all, who will find two
 * empty lists"*. What it never said is what the screen TELLS them, and the
 * answer was: nothing. A search box, an empty people list reading "Nobody
 * matches that.", and an "Add someone" form the server would refuse. Three
 * different situations — the app is broken / the read failed / nobody has given
 * you anything yet — rendered identically.
 *
 * ⚠️ THE PREDICATE IS THE SERVER'S, NOT A NEW CLIENT RULE. `nodes_select`
 * (migration 0019 §6) is `org_id = app_current_org() AND (app_is_admin() OR the
 * row's path is under one of app_grant_paths(false))`. So the rows that come
 * back in `data.nodes` ARE the server's answer to "what may you read". For
 * anybody who is not a system admin the only term left is the grant one, so an
 * EMPTY, SUCCESSFUL read means exactly: no grant of yours covers anything.
 * `app_can_read_owned` (0028) hangs off the same grant paths, which is why
 * Operators, Trainings and the Matrix are empty for the same person — one
 * sentence at the page level is the honest place to say it once.
 *
 * ⚠️ AND A SYSTEM ADMIN MUST NOT SEE THAT SENTENCE. `app_is_admin()` is the
 * FIRST term of the same policy, so for them zero nodes means the org has no
 * places yet — a brand-new company, not a permission. Telling them they have
 * not been given access would be false, and would hide the Hierarchy tab where
 * they create the first plant. Case N4 is that difference.
 *
 * ⭐⭐ AND THIS FILE OWNS THE THIRD POPULATION OF THE RAIL (N6/N7, DEF-0008).
 * There are three: a company admin, a site admin, and somebody ADMITTED BUT
 * NARROWED — a supervisor whose `adminSectionsFor` returns a list rather than
 * "all". `auditAccess.test.tsx` renders the first two against the tab list.
 * The third had no case naming the set it gets, so a widening of
 * `adminSectionsFor` was invisible: offering a supervisor Import, Products and
 * Settings passed all 2103 cases.
 *
 * ⛔ AND N3 ONLY LOOKED LIKE IT COVERED THAT. It asserts which PANEL a
 * supervisor lands on, and `resolveAdminSection` falls back to the FIRST
 * allowed section — so allowing "access" changes the landing panel and N3
 * notices, while allowing anything sorting after "operators" (products, cycle
 * times, import, settings) leaves it alone and N3 stays green. It was catching
 * one widening by accident and none of the rest on purpose.
 *
 * ⚠️ WHICH IS WHY N6 ASSERTS THE WHOLE LIST, NOT THREE `toBeTruthy()`s. A list
 * cannot be widened quietly; three truthy checks can. That distinction became
 * load-bearing at `23ba9aa`: Settings used to have TWO locks, this helper and
 * `companyAdminOnly`, and DEF-0007 correctly removed the second. A widening of
 * the first is now stopped by nothing but N6.
 *
 * The mocks stop at the network boundary (`fetchHierarchyTree`) and at the
 * panels, which are other files with their own suites; what is under test is
 * AdminPage's own decision about what to render. `readablePlants`,
 * `adminSectionsFor` and `resolveAdminSection` all run for real.
 */

const h = vi.hoisted(() => {
  const node = (id: string, name: string, parentId: string | null, path: string) => ({
    id,
    name,
    parentId,
    levelId: "lv-plant",
    path,
    sortOrder: 1,
    active: true,
  });
  return {
    node,
    state: {
      profile: {
        id: "p1",
        userId: "u1",
        orgId: "org-1",
        role: "supervisor",
        adminAnywhere: false,
      } as Record<string, unknown>,
      loading: false,
      /** What `fetchHierarchyTree` resolves to. */
      tree: null as unknown,
      /** Make the one read fail, which is a different fact from an empty one. */
      reject: false,
    },
  };
});

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: h.state.loading ? null : { user: { id: "u1" } },
    profile: h.state.loading ? null : h.state.profile,
    loading: h.state.loading,
  }),
}));

// The ONE read this page makes.
vi.mock("@/lib/api", () => ({
  fetchHierarchyTree: () => {
    if (h.state.reject) return Promise.reject(new Error("network"));
    return Promise.resolve(h.state.tree);
  },
}));

// Imported by AdminPage only for the query key; the real module pulls the whole
// mutation surface of `@/lib/api` in behind it, which the closed factory above
// deliberately does not define.
vi.mock("@/features/admin/hooks/useHierarchyMutations", () => ({
  hierarchyKeys: { all: ["hierarchy"] as const },
}));

// The children, stubbed by NAME so a case can say which pane it is looking at.
// Each panel keeps its `_PANEL_READY` flag, because `SECTIONS` reads it to
// decide whether the rail button is live at all.
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

const EMPTY_TREE = {
  templates: [],
  levels: [],
  nodes: [] as ReturnType<typeof h.node>[],
  editableShapeIds: [],
  siteNodeIds: {},
  sumsChildren: {},
};

const EMPTY_HEADING = "Nothing has been shared with you yet";

/**
 * Every SECTION button in the rail, in the order the rail renders them.
 *
 * ⚠️ SCOPED TO THE `<nav>`, so a button appearing anywhere else on the page can
 * neither pad this list nor stand in for a rail that failed to render at all.
 * The empty-text filter drops `PanelToggle`, which is the rail's collapse
 * control and is icon-only — it is the one button in here that is not a
 * section, and it survives a collapse precisely because it is not one.
 */
function rail(): string[] {
  const nav = screen.getByRole("navigation", { name: "Admin sections" });
  return within(nav)
    .getAllByRole("button")
    .map((b) => (b.textContent ?? "").trim())
    .filter((t) => t.length > 0);
}

function show(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <AdminPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.state.profile = {
    id: "p1",
    userId: "u1",
    orgId: "org-1",
    role: "supervisor",
    adminAnywhere: false,
  };
  h.state.loading = false;
  h.state.tree = EMPTY_TREE;
  h.state.reject = false;
  useAdminViewStore.setState({ plantChoice: null, hydratedOrgId: null });
});

describe("the admin screen explains an empty scope instead of showing one", () => {
  it("N1 ⭐: a supervisor the server gave nothing is told so, and gets no panels", async () => {
    show();
    expect(await screen.findByRole("heading", { level: 1, name: EMPTY_HEADING })).toBeTruthy();
    // ⚠️ THE SENTENCE HAS TO RULE OUT A FAILURE, not merely describe an absence.
    // "No operators" would leave the reader exactly where they started.
    expect(screen.getByText(/Nothing failed to load/i)).toBeTruthy();
    // ⚠️ AND THE PANELS ARE ABSENT, NOT MERELY EMPTY. An "Add someone" form the
    // server refuses is the thing this replaces.
    expect(screen.queryByText("stub OperatorsPanel")).toBe(null);
    expect(screen.queryByText("stub TrainingsPanel")).toBe(null);
    expect(screen.queryByText("stub MatrixPanel")).toBe(null);
  });

  it("N2 ⭐: a read that FAILED is never reported as a permission", async () => {
    h.state.reject = true;
    show();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    // The two situations must not share a sentence: this one is worth retrying,
    // the other is not.
    expect(screen.queryByRole("heading", { name: EMPTY_HEADING })).toBe(null);
  });

  it("N3: a supervisor WITH a grant gets the ordinary screen", async () => {
    h.state.tree = { ...EMPTY_TREE, nodes: [h.node("n1", "Line A", null, "plant_1")] };
    show();
    expect(await screen.findByText("stub OperatorsPanel")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: EMPTY_HEADING })).toBe(null);
  });

  it("N4 ⭐⭐: a system admin of an org with no plants yet is NOT told they lack access", async () => {
    h.state.profile = {
      id: "p1",
      userId: "u1",
      orgId: "org-1",
      role: "admin",
      adminAnywhere: true,
    };
    show();
    // `app_is_admin()` is the first term of `nodes_select`, so for them an empty
    // read is an empty COMPANY. They must land on Hierarchy and build it.
    expect(await screen.findByRole("heading", { level: 1, name: "Hierarchy" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: EMPTY_HEADING })).toBe(null);
  });

  /**
   * ⭐⭐ THE CASE `adminSectionsFor`'S NARROWING NOW RESTS ON (DEF-0008). The
   * mutation it exists to catch is one line in `src/features/auth/session.ts`:
   *
   *     - return ["operators", "trainings", "matrix"];
   *     + return ["operators", "trainings", "matrix", "import", "products", "settings"];
   *
   * The server refuses this person outright — a plain `POST /rest/v1/products`
   * over their own session is `42501 new row violates row-level security
   * policy` — so every one of those tabs would be a control shown for something
   * the server refuses (R-239), and Settings would be one no lock stops.
   */
  it("N6 ⭐⭐: a supervisor's rail is Operators, Trainings and Matrix, and nothing else", async () => {
    h.state.tree = { ...EMPTY_TREE, nodes: [h.node("n1", "Line A", null, "plant_1")] };
    show();
    await screen.findByRole("button", { name: "Operators" });
    // The whole list, in the rail's own order. A widening shows up here as an
    // extra element with a name, which is what makes the failure readable
    // without a second set of by-name assertions to maintain beside it.
    expect(rail()).toEqual(["Operators", "Trainings", "Matrix"]);
  });

  it("N7: a company admin's rail is the whole of SECTIONS, so N6 cannot pass by emptying it", async () => {
    h.state.profile = {
      id: "p1",
      userId: "u1",
      orgId: "org-1",
      role: "admin",
      adminAnywhere: true,
    };
    h.state.tree = { ...EMPTY_TREE, nodes: [h.node("n1", "Line A", null, "plant_1")] };
    show();
    await screen.findByRole("button", { name: "Hierarchy" });
    // ⚠️ SETTINGS IS IN BOTH DIRECTIONS NOW: absent from N6, present here. Before
    // DEF-0007 it was absent from a site admin's rail too, and the case that
    // asserted so was pinning the bug — see `auditAccess.test.tsx`.
    expect(rail()).toEqual([
      "Hierarchy",
      "Access",
      "Shifts",
      "Operators",
      "Trainings",
      "Matrix",
      "Products",
      "Cycle times",
      "Import",
      "Settings",
      "Activity",
    ]);
  });

  it("N5: while the session is still resolving, the refusal never flashes", () => {
    // D97/D91's standing lesson one component over: a permission sentence shown
    // before the answer has landed reads as a permission BUG to the person it
    // happens to. `nothingShared` requires a resolved profile AND a settled
    // read, so this window says nothing about access at all.
    //
    // ⚠️ What keeps the PANELS off screen in this window is `RequireAdmin`,
    // which does not mount this page until the session resolves — pinned by
    // `requireAdmin.test.tsx` G5, not here.
    h.state.loading = true;
    show();
    expect(screen.queryByRole("heading", { name: EMPTY_HEADING })).toBe(null);
    expect(screen.queryByText(/not been given access/i)).toBe(null);
  });
});
