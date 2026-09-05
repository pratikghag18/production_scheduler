/**
 * Pin for DEF-0007 — the Settings tab is hidden from a site admin, and the
 * server would let that same person change their own plant's settings.
 *
 * R-239: "A client control is never hidden for something the server permits."
 *
 * WHAT THE SERVER ACTUALLY SAYS. `set_node_setting` (migration 0050, second key
 * added by 0052) gates on `app_is_admin() OR app_is_admin_for(p_node_id)` — the
 * plant's own admin, not only the company's. Measured over Dana's own session
 * against her own plant, with a deliberately illegal value so nothing is
 * written and the permission gate is the only thing that can answer first:
 *
 *     set_node_setting(plant_a, 'eligibility_policy', '__probe__')
 *       -> 400 PT400 {"error": "invalid_argument", "field": "eligibility_policy"}
 *
 * `invalid_argument`, not `not_permitted`: the gate ran and passed her.
 *
 * ⚠️ THE CONTROL CASE IS NOT DECORATION. Activity IS company-admin-only —
 * `audit_log_select` is `app_is_admin() and org_id = app_current_org()`, and a
 * site admin's read of it returns zero rows rather than an error. Measured the
 * same way: `GET /audit_log` as Dana is `200 []`. So the fix is not to delete
 * the `companyAdminOnly` axis; it is to stop applying it to a tab whose writes
 * are no longer company-only. Both cases are asserted here so a fix in either
 * direction alone goes red.
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

/** A site admin: the org-wide role is `viewer`, the power comes from a grant. */
const SITE_ADMIN = {
  id: "p2",
  userId: "u2",
  orgId: "org-1",
  role: "viewer",
  adminAnywhere: true,
};

beforeEach(() => {
  h.state.profile = { ...SITE_ADMIN };
  useAdminViewStore.setState({ plantChoice: null, hydratedOrgId: null });
});

describe("DEF-0007: the rail offers what the server permits, tab by tab", () => {
  it("a site admin is offered Settings — the server takes their writes on their own plant", async () => {
    show();
    expect(await screen.findByRole("button", { name: "Hierarchy" })).toBeTruthy();
    expect(railButton("Settings")).not.toBe(null);
  });

  it("a site admin is NOT offered Activity — that read really is company-admin-only", async () => {
    // The control. `audit_log_select` is `app_is_admin() and org_id = ...`, so
    // this tab must stay hidden; deleting the `companyAdminOnly` axis outright
    // would fix the case above and break this one.
    show();
    expect(await screen.findByRole("button", { name: "Hierarchy" })).toBeTruthy();
    expect(railButton("Activity")).toBe(null);
  });

  it("a company admin is offered both, so neither case passes by hiding everything", async () => {
    h.state.profile = { ...SITE_ADMIN, role: "admin" };
    show();
    expect(await screen.findByRole("button", { name: "Hierarchy" })).toBeTruthy();
    expect(railButton("Settings")).not.toBe(null);
    expect(railButton("Activity")).not.toBe(null);
  });
});
