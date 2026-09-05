/**
 * Pin for DEF-0008 — after DEF-0007, `adminSectionsFor` is the ONLY gate left
 * on the Settings tab, and nothing in the suite exercises its non-admin branch
 * against the rail.
 *
 * R-335: "the test for that flag is not 'is this screen important' but 'would
 * the server refuse, or silently do nothing, for EVERY person
 * `adminSectionsFor` admits'."
 *
 * ⚠️ THIS PIN IS GREEN ON THE BUILD IT WAS WRITTEN AGAINST, WHICH IS THE POINT.
 * The behaviour is right today; the evidence for it is missing. It goes red on
 * the one-line mutation in DEF-0008's Reproduction:
 *
 *     src/features/auth/session.ts
 *     - return ["operators", "trainings", "matrix"];
 *     + return ["operators", "trainings", "matrix", "import", "products", "settings"];
 *
 * which offers a supervisor with NO admin grant anywhere the Import, Products
 * and Settings tabs, and which the 2103-case suite passes without a murmur.
 * The server refuses that person: a plain `POST /rest/v1/products` over their
 * own session is `42501 new row violates row-level security policy`.
 *
 * ⭐ WHY IT HAS TO BE THE WHOLE SET AND NOT THREE `toBeTruthy()`. What the
 * suite already has is `adminNoGrants.test.tsx` N3, which asserts a supervisor
 * lands on the Operators PANEL. That catches a widening only by accident —
 * "access" sorts before "operators" in `SECTIONS`, so allowing it changes which
 * panel the screen opens on and N3 notices. Anything sorting AFTER operators
 * (products, cycle times, import, settings) leaves the landing section alone
 * and is invisible. So the assertion here is the exact LIST of rail buttons,
 * in the rail's own order, which cannot be widened quietly.
 *
 * ⚠️ AND THE COMPANY-ADMIN CASE IS NOT DECORATION: without it, a change that
 * emptied the rail for everybody would pass the first case for the wrong
 * reason.
 *
 * The harness mirrors `auditAccess.test.tsx`: the mocks stop at the network
 * boundary and at the panels, because what is under test is AdminPage's own
 * decision about which rail buttons exist.
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
      role: "supervisor",
      adminAnywhere: false,
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

/**
 * ⚠️ A READABLE ROOT, so the "nothing has been shared with you" screen — which
 * is a DIFFERENT screen with no rail at all — never fires and hides what this
 * file reads. `adminNoGrants.test.tsx` N1 owns that branch.
 */
const TREE = {
  templates: [],
  levels: [],
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

/** Every button in the rail, in the order the rail renders them. */
function rail(): string[] {
  return screen
    .getAllByRole("button")
    .map((b) => (b.textContent ?? "").trim())
    .filter((t) => t.length > 0);
}

/** A supervisor: no admin grant anywhere, so `adminAnywhere` is false. */
const SUPERVISOR = {
  id: "p1",
  userId: "u1",
  orgId: "org-1",
  role: "supervisor",
  adminAnywhere: false,
};

beforeEach(() => {
  h.state.profile = { ...SUPERVISOR };
  useAdminViewStore.setState({ plantChoice: null, hydratedOrgId: null });
});

describe("DEF-0008: the rail a person with no admin grant is offered, as a whole list", () => {
  it("a supervisor gets Operators, Trainings and Matrix, and NOTHING else", async () => {
    show();
    await screen.findByRole("button", { name: "Operators" });
    expect(rail()).toEqual(["Operators", "Trainings", "Matrix"]);
  });

  it("and specifically not Settings, Products or Import — the server refuses all three", async () => {
    // Named one by one as well, so a failure says WHICH tab leaked rather than
    // printing two arrays and leaving the reader to diff them.
    show();
    await screen.findByRole("button", { name: "Operators" });
    expect(screen.queryByRole("button", { name: "Settings" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Products" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Import" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Access" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Hierarchy" })).toBe(null);
    expect(screen.queryByRole("button", { name: "Activity" })).toBe(null);
  });

  it("a company admin still gets the whole rail, so neither case passes by emptying it", async () => {
    h.state.profile = { ...SUPERVISOR, role: "admin", adminAnywhere: true };
    show();
    await screen.findByRole("button", { name: "Hierarchy" });
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
});
