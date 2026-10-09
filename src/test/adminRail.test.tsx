import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminPage from "@/features/admin/AdminPage";
import { useAdminViewStore } from "@/features/admin/store/adminView";
import { RAIL_MAX_WIDTH } from "@/features/board/lib/railWidth";

/**
 * adminRail.test.tsx — R-446: the admin rail's own drag handle, AR-1..AR-4.
 *
 * The standard's first hit outside the board (CLAUDE.md §7, R-446): a side
 * panel resizes by its edge, within a clamp, with pointer capture, and
 * remembers its width per person through `panelSize.ts` under its own
 * storage prefix. This file is the same division `operatorPanel.test.tsx`
 * draws for the operator rail -- the handle, the width state, and the round
 * trip through `readRailWidth`/`writeRailWidth` -- applied to `AdminPage.tsx`.
 *
 * The mock scaffold (useSession, fetchHierarchyTree, every section panel
 * stubbed by name) is `adminNoGrants.test.tsx`'s own -- this file needs the
 * ordinary screen to render (a company admin, one node), not an empty-scope
 * or loading branch, so the rail and its handle are actually on screen.
 *
 * ⚠️ `getBoundingClientRect()` ALWAYS RETURNS 0 IN JSDOM (no real layout), so
 * `AdminPage.tsx`'s `currentRailFloor()` -- which measures `.railProbe`'s
 * resolved width, the same trick `OperatorPanel.tsx`'s `currentUiScale()`
 * uses for `--ui-scale` -- would read a floor of 0 throughout this file
 * unless a case stubs the probe element's own `getBoundingClientRect`
 * directly (the same technique `commandBar.test.tsx`'s C8 already uses for a
 * different element). AR-1 and AR-4 do; AR-2 and AR-3 do not need to, since
 * neither drags past a floor.
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
      userId: "u1",
      loading: false,
    },
  };
});

vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: h.state.loading ? null : { user: { id: h.state.userId } },
    profile: h.state.loading
      ? null
      : {
          id: "p1",
          userId: h.state.userId,
          orgId: "org-1",
          role: "admin",
          adminAnywhere: true,
        },
    loading: h.state.loading,
  }),
}));

const TREE = {
  templates: [],
  levels: [],
  nodes: [h.node("n1", "Line A", null, "plant_1")],
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
vi.mock("@/features/admin/components/AbsencesPanel", () => ({
  AbsencesPanel: () => <div>stub AbsencesPanel</div>,
  ABSENCES_PANEL_READY: true,
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

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <AdminPage />
    </QueryClientProvider>,
  );
  return utils;
}

function nav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Admin sections" });
}

function handle(): HTMLElement {
  return document.querySelector('[class*="railHandle"]') as HTMLElement;
}

function probe(): HTMLElement {
  return document.querySelector('[class*="railProbe"]') as HTMLElement;
}

/** AR-1/AR-4: pin the probe's resolved `--rail-w` to a chosen px number, the
 *  same stub-one-element's-rect technique `commandBar.test.tsx`'s C8 uses. */
function stubFloor(px: number): void {
  probe().getBoundingClientRect = () =>
    ({
      width: px,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
}

/** A drag: pointerdown at `fromX`, pointermove to `toX`, pointerup there. */
function drag(fromX: number, toX: number): void {
  fireEvent.pointerDown(handle(), { clientX: fromX, pointerId: 1 });
  fireEvent.pointerMove(handle(), { clientX: toX, pointerId: 1 });
  fireEvent.pointerUp(handle(), { clientX: toX, pointerId: 1 });
}

beforeEach(() => {
  window.localStorage.clear();
  h.state.userId = "u1";
  h.state.loading = false;
  useAdminViewStore.setState({ plantChoice: null, hydratedOrgId: null });
});

describe("AdminPage: the section rail's drag handle (R-446)", () => {
  it("AR-1: at rest the rail has no inline width, and a drag on the handle sets one, grown from the current --rail-w floor", async () => {
    show();
    await screen.findByRole("button", { name: "Hierarchy" });
    expect(nav().style.width).toBe("");

    stubFloor(220);
    drag(300, 350); // +50px
    expect(nav().style.width).toBe("270px");
  });

  it("AR-2: the dragged width is remembered per person and restored on a later mount", async () => {
    const { unmount } = show();
    await screen.findByRole("button", { name: "Hierarchy" });
    stubFloor(0);
    drag(300, 380); // +80, well inside [0, 480]
    expect(nav().style.width).toBe("80px");
    unmount();

    // A fresh mount, same signed-in person: the stored width is read back on
    // mount, no drag needed this time.
    show();
    await screen.findByRole("button", { name: "Hierarchy" });
    expect(nav().style.width).toBe("80px");
  });

  it("AR-2b: a DIFFERENT signed-in person sees none of the first person's remembered width", async () => {
    const { unmount } = show();
    await screen.findByRole("button", { name: "Hierarchy" });
    stubFloor(0);
    drag(300, 400); // +100
    unmount();

    h.state.userId = "u2";
    show();
    await screen.findByRole("button", { name: "Hierarchy" });
    expect(nav().style.width).toBe("");
  });

  it("AR-3: collapsing and reopening the rail keeps the width it was dragged to", async () => {
    show();
    await screen.findByRole("button", { name: "Hierarchy" });
    stubFloor(0);
    drag(300, 390); // +90
    const grown = nav().style.width;
    expect(grown).toBe("90px");

    fireEvent.click(screen.getByRole("button", { name: /admin sections/i }));
    // Collapsed: `.railCollapsed`'s own `width: auto` wins, no inline style.
    expect(nav().style.width).toBe("");

    fireEvent.click(screen.getByRole("button", { name: /admin sections/i }));
    expect(nav().style.width).toBe(grown);
  });

  it("AR-4: the clamp holds both ways -- a drag past the ceiling stops at 480px, a drag past the floor stops at the floor", async () => {
    show();
    await screen.findByRole("button", { name: "Hierarchy" });
    stubFloor(220);

    drag(300, 300 + 1000); // way past the ceiling
    expect(nav().style.width).toBe(`${RAIL_MAX_WIDTH}px`);

    drag(300, 300 - 1000); // way past the floor (from the now-480px width)
    expect(nav().style.width).toBe("220px");
  });
});
