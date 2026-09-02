import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { ProductsPanel } from "@/features/admin/components/ProductsPanel";
import { useAdminViewStore } from "@/features/admin/store/adminView";

/**
 * ⭐ THE ONE PANEL-LEVEL SUITE, and it drives the REAL store/hook/lib on purpose
 * (§19.67 / D106). It mocks only what has a network on the far side — the query,
 * the mutations, `DeleteDialog`'s chain — and lets `../lib/products`,
 * `../lib/scope` and `../lib/plantFilter` run for real, because they are what the
 * panel renders. It asks the USER'S question: it finds a control by its
 * accessible name and checks that what opens really carries the field, and it
 * asserts on what the mutations RECEIVE rather than on being called.
 *
 * ⭐⭐ REWRITTEN FOR D115 (§19.81). A product is the company-wide record (sku,
 * name, colour) plus a SEPARATE LIST of the plants that make it — `siteNodeIds`,
 * not a single `siteNodeId`. The Split governs the two apart:
 *   - the shared record (create, rename, recolour, retire, delete) is COMPANY
 *     property — company admin only;
 *   - the list of makers (add / remove a plant) is per-plant — a plant admin may
 *     manage a node they administer.
 * The old owner-`<select>` cases (T4/T5/T6/T13, the "show one owner save another"
 * bug) are gone with the picker; their place is taken by the plant-chip cases.
 */

const PLANT1 = "30000000-0000-0000-0000-000000000001";
const PLANT2 = "30000000-0000-0000-0000-000000000002";

const h = vi.hoisted(() => {
  const P1 = "30000000-0000-0000-0000-000000000001";
  const node = (id: string, name: string, parentId: string | null, path: string) => ({
    id,
    name,
    parentId,
    levelId: "L",
    path,
    sortOrder: 1,
    active: true,
  });
  // ⭐ D115: `siteNodeIds` IS A LIST. A product is made in zero, one or many
  // places, so the factory takes an array — faithful to `AdminProduct` since
  // migration 0034, and to `product_sites` being a join table.
  const product = (id: string, sku: string, name: string, siteNodeIds: string[]) => ({
    id,
    sku,
    name,
    active: true,
    source: "manual",
    externalId: null as string | null,
    siteNodeIds,
    colorToken: "product-1",
  });
  // ⭐ FACTORIES, NOT LITERALS, AND `beforeEach` RESTORES FROM THEM — a case that
  // mutates the shared fixture must not shape its successors. Both base rows are
  // made in Plant 1.
  const baseProducts = () => [
    product("p1", "WX", "Widget X", [P1]),
    product("p2", "WY", "Widget Y", [P1]),
  ];
  const baseTree = () => ({
    templates: [] as unknown[],
    levels: [] as unknown[],
    nodes: [
      node(P1, "Plant 1", null, "plant_1"),
      node("n-asm", "Assembly", P1, "plant_1.assembly"),
    ],
    editableShapeIds: ["tpl-1"] as string[] | null,
    siteNodeIds: { "tpl-1": P1 } as Record<string, string | null>,
  });
  return {
    // ⚠️ EACH MUTATION IS MOCKED THE SAME WAY — a captured `vi.fn()` plus
    // `isPending: false`. The panel reads `.isPending` on assign/unassign to
    // disable the control; an omitted field would silently pick the disabled
    // branch and the fire-events would do nothing (the bug this file's own
    // history warns about).
    updateMutate: vi.fn(),
    createMutate: vi.fn(),
    colorMutate: vi.fn(),
    assignMutate: vi.fn(),
    unassignMutate: vi.fn(),
    node,
    product,
    baseProducts,
    baseTree,
    state: {
      profile: {
        id: "u1",
        orgId: "10000000-0000-0000-0000-000000000001",
        userId: "u1",
        role: "admin",
        defaultCreateMode: "run",
        adminAnywhere: true,
      },
      products: baseProducts() as unknown[],
      tree: baseTree(),
    },
  };
});

vi.mock("@tanstack/react-query", () => ({
  // `isSuccess` is part of the contract the panel reads; supply the full shape.
  useQuery: () => ({
    data: h.state.tree,
    isLoading: false,
    isError: false,
    isSuccess: true,
    error: null,
  }),
}));
vi.mock("@/lib/api", () => ({
  describeSchedulerError: (e: unknown) => String(e),
  fetchHierarchyTree: vi.fn(),
}));
vi.mock("@/features/auth/useSession", () => ({
  useSession: () => ({
    session: { user: { id: h.state.profile.userId } },
    profile: h.state.profile,
    loading: false,
  }),
}));
vi.mock("@/features/admin/hooks/useHierarchyMutations", () => ({
  hierarchyKeys: { all: ["hierarchy"] },
}));
vi.mock("@/features/admin/hooks/useProducts", () => ({
  useAdminProducts: () => ({
    data: h.state.products,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useCreateProduct: () => ({ mutate: h.createMutate, isPending: false }),
  useUpdateProduct: () => ({ mutate: h.updateMutate, isPending: false }),
  useSetProductActive: () => ({ mutate: vi.fn(), isPending: false }),
  useSetProductColor: () => ({ mutate: h.colorMutate, isPending: false }),
  // ⭐ D115: the two new writes, mocked to the EXACT shape of the others.
  useAssignProductSite: () => ({ mutate: h.assignMutate, isPending: false }),
  useUnassignProductSite: () => ({ mutate: h.unassignMutate, isPending: false }),
}));

/**
 * ⚠️ `DeleteDialog`'s import chain reaches `useMutation`/`@/lib/api` names the
 * mocks above do not list. Cutting the chain at `useDeletion` keeps those
 * factories from having to grow a list of names this file does not test.
 */
vi.mock("@/features/admin/hooks/useDeletion", () => ({
  useDeletionPreview: () => ({
    data: undefined,
    isPending: true,
    isError: false,
    error: null,
  }),
  useDeleteOwnedRow: () => ({ mutate: vi.fn(), isPending: false }),
}));

function asCompanyAdmin() {
  h.state.profile = { ...h.state.profile, role: "admin", adminAnywhere: true };
}
/**
 * A PLANT admin, not a company admin: org-wide role `viewer`, but they administer
 * a structure that resolves to Plant 1 (`editableShapeIds` -> `siteNodeIds`). So
 * the shared record is read-only to them (no create card, no Edit), and they may
 * add or remove Plant 1 from any part (`canManagePlace`).
 */
function asPlantAdmin() {
  h.state.profile = { ...h.state.profile, role: "viewer", adminAnywhere: false };
}
/**
 * Someone who administers NOWHERE: role `viewer`, no editable structure. The
 * shared record is read-only AND there is no plant they may manage.
 */
function asAdminOfNowhere() {
  h.state.profile = { ...h.state.profile, role: "viewer", adminAnywhere: false };
  h.state.tree = { ...h.state.tree, editableShapeIds: [] };
}
/** The open editor for one row, found the way its own label reads. */
function editingRow(sku: string): HTMLElement {
  const box = screen.getByRole("textbox", { name: `Product code for ${sku}` });
  const li = box.closest("li");
  if (li === null) throw new Error("the editor is not inside a row");
  return li;
}
/** The <li> for a product, found by its visible sku text. */
function rowOf(sku: string): HTMLElement {
  const cell = screen.getByText(sku);
  const li = cell.closest("li");
  if (li === null) throw new Error(`no row for ${sku}`);
  return li;
}

/**
 * The two-plant world the filter exists for: a system admin who can read Plant 1
 * and Plant 2, with a product made in each.
 */
function withTwoPlants() {
  h.state.tree = {
    ...h.baseTree(),
    nodes: [
      h.node(PLANT1, "Plant 1", null, "plant_1"),
      h.node("n-asm", "Assembly", PLANT1, "plant_1.assembly"),
      h.node(PLANT2, "Plant 2", null, "plant_2"),
      h.node("n-l9", "Line 9", PLANT2, "plant_2.line_9"),
    ],
  };
  h.state.products = [...h.baseProducts(), h.product("p3", "ZZ", "Widget Z", [PLANT2])];
}
/** Choose a plant the way the header control does, and re-render on it. */
function showPlant(choice: string | null) {
  act(() => useAdminViewStore.setState({ plantChoice: choice }));
}

beforeEach(() => {
  // ⚠️ mockReset, not mockClear — one case sets an `updateMutate` implementation
  // (to fire its onSuccess), and mockClear would leave that leaking into the
  // next test. Reset clears the call log AND the implementation; every other
  // case uses these as plain spies, so a bare reset is what they expect anyway.
  h.updateMutate.mockReset();
  h.createMutate.mockReset();
  h.colorMutate.mockReset();
  h.assignMutate.mockReset();
  h.unassignMutate.mockReset();
  asCompanyAdmin();
  h.state.products = h.baseProducts();
  h.state.tree = h.baseTree();
  useAdminViewStore.setState({ plantChoice: null, hydratedOrgId: null });
});

describe("ProductsPanel — the shared record (D115 / the Split)", () => {
  it("T1: a company admin gets an 'Edit' control on every row, and none named 'Rename'", () => {
    render(<ProductsPanel />);
    expect(screen.queryAllByRole("button", { name: "Rename" })).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2);
  });

  it("T2: Edit opens a form carrying the code and name fields — and NO owner picker", () => {
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const row = editingRow("WX");
    expect(within(row).getByRole("textbox", { name: "Product code for WX" })).toBeTruthy();
    expect(within(row).getByRole("textbox", { name: "Name for WX" })).toBeTruthy();
    // The single-owner `<select>` is gone with D115 — places are chips now.
    expect(screen.queryByRole("combobox", { name: /Where WX belongs/ })).toBeNull();
  });

  it("T2b ⭐: Edit also opens the colour palette — the maintainer, 2 Sept", () => {
    // Hitting Edit and not finding the colour "feels wrong and non-intuitive";
    // D115 had scoped Edit to code + name with colour on the swatch alone. The
    // palette now rides inside the Edit panel (R-307). The swatch stays a
    // shortcut, so the group exists closed too — this asserts the "Colour" label
    // that only the edit panel adds, and that the palette is inside THIS row.
    render(<ProductsPanel />);
    // Closed: no "Colour" label anywhere yet.
    expect(screen.queryByText("Colour")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const row = editingRow("WX");
    expect(within(row).getByRole("group", { name: "Product colour" })).toBeTruthy();
    expect(within(row).getByText("Colour")).toBeTruthy();
  });

  it("T2c ⭐: a colour picked in Edit is STAGED — it does not write until Save", () => {
    // The maintainer, 2 Sept: colour should wait for Save like the code and name,
    // not apply on the click. So picking a swatch inside Edit writes nothing yet;
    // Save is what sends it — as its own call (setProductColor is separate from
    // updateProduct), and with sku/name unchanged there is no rename write at all.
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const row = editingRow("WX");
    fireEvent.click(within(row).getByRole("button", { name: "product-2" }));
    expect(h.colorMutate).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    expect(h.colorMutate).toHaveBeenCalledTimes(1);
    expect(h.colorMutate.mock.calls[0][0]).toEqual({ id: "p1", colorToken: "product-2" });
    expect(h.updateMutate).not.toHaveBeenCalled();
  });

  it("T2d ⭐: Cancel after picking a colour writes nothing — the note that prompted this", () => {
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const row = editingRow("WX");
    fireEvent.click(within(row).getByRole("button", { name: "product-2" }));
    fireEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(h.colorMutate).not.toHaveBeenCalled();
    expect(h.updateMutate).not.toHaveBeenCalled();
  });

  it("T2e ⭐: Save with a rename AND a recolour writes each on its own call, rename first", () => {
    // The two are separate writes on purpose (products.ts). Save orders them: the
    // rename, then the colour once the rename is in, so a rejected rename never
    // recolours the row underneath it. The update mock invokes its onSuccess so
    // the colour, which is chained on it, actually fires.
    h.updateMutate.mockImplementation((_input: unknown, opts?: { onSuccess?: () => void }) =>
      opts?.onSuccess?.(),
    );
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const row = editingRow("WX");
    fireEvent.change(within(row).getByRole("textbox", { name: "Name for WX" }), {
      target: { value: "Widget X2" },
    });
    fireEvent.click(within(row).getByRole("button", { name: "product-2" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    expect(h.updateMutate).toHaveBeenCalledTimes(1);
    expect(h.updateMutate.mock.calls[0][0]).toEqual({ id: "p1", sku: "WX", name: "Widget X2" });
    expect(h.colorMutate).toHaveBeenCalledTimes(1);
    expect(h.colorMutate.mock.calls[0][0]).toEqual({ id: "p1", colorToken: "product-2" });
  });

  it("T3: editing sends only { id, sku, name } — no place travels on the rename", () => {
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const row = editingRow("WX");
    fireEvent.change(within(row).getByRole("textbox", { name: "Name for WX" }), {
      target: { value: "Widget X2" },
    });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    expect(h.updateMutate).toHaveBeenCalledTimes(1);
    expect(h.updateMutate.mock.calls[0][0]).toEqual({
      id: "p1",
      sku: "WX",
      name: "Widget X2",
    });
    expect("siteNodeId" in h.updateMutate.mock.calls[0][0]).toBe(false);
  });

  it("T4: creating a product is company-admin-only and sends { orgId, sku, name }", () => {
    render(<ProductsPanel />);
    fireEvent.change(screen.getByLabelText("Product code"), { target: { value: "NEW" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Widget" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(h.createMutate).toHaveBeenCalledTimes(1);
    expect(h.createMutate.mock.calls[0][0]).toEqual({
      orgId: h.state.profile.orgId,
      sku: "NEW",
      name: "New Widget",
    });
    expect("siteNodeId" in h.createMutate.mock.calls[0][0]).toBe(false);
  });
});

describe("ProductsPanel — the list of makers (D115 / the Split)", () => {
  it("T5: a product's plants are listed by name, with the full path as a tooltip", () => {
    render(<ProductsPanel />);
    const row = rowOf("WX");
    expect(within(row).getByText("Plant 1")).toBeTruthy();
  });

  it("T6: a company admin can ADD a plant — assign gets { orgId, productId, nodeId }", () => {
    render(<ProductsPanel />);
    const row = rowOf("WX");
    // WX is already made in Plant 1, so the picker offers what is left: Assembly.
    const add = within(row).getByRole("combobox", { name: "Add a plant to WX" });
    fireEvent.change(add, { target: { value: "n-asm" } });
    expect(h.assignMutate).toHaveBeenCalledTimes(1);
    expect(h.assignMutate.mock.calls[0][0]).toEqual({
      orgId: h.state.profile.orgId,
      productId: "p1",
      nodeId: "n-asm",
    });
  });

  it("T7: the add picker excludes plants the product is already made in", () => {
    render(<ProductsPanel />);
    const add = within(rowOf("WX")).getByRole("combobox", {
      name: "Add a plant to WX",
    }) as HTMLSelectElement;
    const values = [...add.options].map((o) => o.value);
    expect(values).not.toContain(PLANT1); // already made there
    expect(values).toContain("n-asm"); // still offerable
  });

  it("T8: a company admin can REMOVE a plant — unassign gets { orgId, productId, nodeId }", () => {
    render(<ProductsPanel />);
    const row = rowOf("WX");
    fireEvent.click(within(row).getByRole("button", { name: "Remove Plant 1 from WX" }));
    expect(h.unassignMutate).toHaveBeenCalledTimes(1);
    expect(h.unassignMutate.mock.calls[0][0]).toEqual({
      orgId: h.state.profile.orgId,
      productId: "p1",
      nodeId: PLANT1,
    });
  });

  it("T9: a product made in ZERO plants renders the 'not assigned' state, not a crash", () => {
    h.state.products = [h.product("p1", "WX", "Widget X", [])];
    render(<ProductsPanel />);
    const row = rowOf("WX");
    expect(within(row).getByText("Not assigned to any plant yet")).toBeTruthy();
    // No remove control, because there is nothing to remove.
    expect(within(row).queryByRole("button", { name: /^Remove / })).toBeNull();
  });
});

describe("ProductsPanel — a plant admin, not a company admin", () => {
  it("T10: sees no create card and no rename controls, and is told why", () => {
    asPlantAdmin();
    render(<ProductsPanel />);
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
    expect(screen.queryByLabelText("Product code")).toBeNull();
    expect(screen.queryAllByRole("button", { name: "Edit" })).toHaveLength(0);
    expect(
      screen.getAllByText(
        "Only a company admin can change a part number — but you can add or remove your own plant below.",
      ),
    ).toHaveLength(2);
  });

  it("T11: can still REMOVE their own plant", () => {
    asPlantAdmin();
    render(<ProductsPanel />);
    const row = rowOf("WX");
    fireEvent.click(within(row).getByRole("button", { name: "Remove Plant 1 from WX" }));
    expect(h.unassignMutate.mock.calls[0][0]).toEqual({
      orgId: h.state.profile.orgId,
      productId: "p1",
      nodeId: PLANT1,
    });
  });

  it("T12: someone who administers nowhere is offered no plant control at all", () => {
    asAdminOfNowhere();
    render(<ProductsPanel />);
    expect(screen.queryAllByRole("button", { name: "Edit" })).toHaveLength(0);
    expect(screen.queryByRole("combobox", { name: /Add a plant/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });
});

describe("ProductsPanel — the catalogue guards", () => {
  it("T13: a row that could not be read is counted, not blanked", () => {
    h.state.products = [...h.baseProducts(), null];
    render(<ProductsPanel />);
    expect(screen.getByText("1 product couldn't be read and isn't shown.")).toBeTruthy();
    // The readable rows are still there.
    expect(screen.getByText("WX")).toBeTruthy();
    expect(screen.getByText("WY")).toBeTruthy();
  });
});

/**
 * ⭐⭐ ROADMAP 1(c) — "which plant am I looking at", on this panel. These cases
 * drive the REAL store (`usePlantFilter` / `plantFilter.ts` / `adminView.ts`),
 * not a mock of it.
 */
describe("ProductsPanel — the plant filter (roadmap 1(c))", () => {
  it("T14: the catalogue is cut to the chosen plant", () => {
    withTwoPlants();
    render(<ProductsPanel />);
    expect(screen.queryByText("ZZ")).not.toBeNull();
    showPlant(PLANT1);
    expect(screen.queryByText("ZZ")).toBeNull();
    expect(screen.queryByText("WX")).not.toBeNull();
    expect(screen.queryByText("WY")).not.toBeNull();
  });

  it("T15: what the filter hides is COUNTED, and named by the plant", () => {
    withTwoPlants();
    render(<ProductsPanel />);
    expect(screen.queryByText(/isn't listed|aren't listed/)).toBeNull();
    showPlant(PLANT1);
    expect(screen.getByText(/1 product outside Plant 1 isn't listed\./)).toBeTruthy();
  });

  it("T16: the ROW's add picker narrows to the chosen plant's subtree", () => {
    withTwoPlants();
    render(<ProductsPanel />);
    showPlant(PLANT2);
    // ZZ is made in Plant 2, so its picker offers Plant 2's subtree minus Plant
    // 2 itself: just Line 9, indented.
    const add = within(rowOf("ZZ")).getByRole("combobox", {
      name: "Add a plant to ZZ",
    }) as HTMLSelectElement;
    const labels = [...add.options].map((o) => o.text);
    expect(labels).toEqual(["Add a plant…", "  Line 9"]);
  });

  it("T17: an editor whose row the filter took away does not come back open", () => {
    withTwoPlants();
    render(<ProductsPanel />);
    showPlant(PLANT2);
    fireEvent.click(within(rowOf("ZZ")).getByRole("button", { name: "Edit" }));
    expect(screen.queryAllByRole("textbox", { name: "Product code for ZZ" })).toHaveLength(1);
    showPlant(PLANT1);
    showPlant(null);
    expect(screen.queryByText("ZZ")).not.toBeNull();
    expect(screen.queryAllByRole("textbox", { name: "Product code for ZZ" })).toHaveLength(0);
  });

  it("T18: 'All plants' hides nothing and says nothing", () => {
    withTwoPlants();
    render(<ProductsPanel />);
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(3);
    expect(screen.queryByText(/outside/)).toBeNull();
  });

  it("T19: one readable root means the filter is a no-op, whatever is remembered", () => {
    showPlant(PLANT2);
    render(<ProductsPanel />);
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2);
    expect(screen.queryByText(/aren't listed|isn't listed/)).toBeNull();
  });
});
