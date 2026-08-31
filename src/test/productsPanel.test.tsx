import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { ProductsPanel } from "@/features/admin/components/ProductsPanel";
import { useAdminViewStore } from "@/features/admin/store/adminView";

/**
 * ⭐ THE FIRST TEST IN THIS REPO THAT MOUNTS A COMPONENT, and the reason it
 * exists is a finding, not a preference (§19.67 / D106).
 *
 * `scaleAudit`'s group J was written to make "you can SET it at creation and
 * never CHANGE it" impossible to ship. It passed every day the maintainer was blocked,
 * because of what it reads: `scopeParityOffences` opens three files under
 * `src/lib/api/`, slices the text around `.from("products")`, and asks whether
 * the substring `site_node_id` survives inside a window that also contains
 * `.update(`. That is a question about the DATA LAYER. Every part of the span
 * between "the API can express the change" and "a person can make the change"
 * — the hook, the panel, the permission predicate, the label on the button
 * that opens the form — was unmeasured, and the audit would still have
 * reported zero offences with `ProductsPanel.tsx` deleted from the repo.
 *
 * ⚠️ SO THIS FILE ASKS THE USER'S QUESTION, NOT THE MODULE'S: it looks for the
 * control the way a person looks for it — by accessible name — and then checks
 * that what opens really does carry the field. Written against the screen as it
 * was, T1 fails: the row's opener was named "Rename".
 *
 * ⚠️⚠️ AND "BY ACCESSIBLE NAME" IS STRICTER THAN AN ATTRIBUTE SELECTOR, WHICH IS
 * HOW THE FIRST VERSION OF THIS FILE SHIPPED BROKEN. It was verified in a browser
 * probe that found the row's boxes with `input[aria-label="Product code"]` — an
 * attribute match, so it saw one element. Testing Library computes the ACCESSIBLE
 * NAME, and the Add-a-product card's field is labelled "Product code" too, so it
 * saw two and threw. Five cases died in one helper against a screen that works.
 * **T8 is the case that pins it**, and the row's controls are now named for their
 * row — which is also the honest fix, because two identically-named boxes on one
 * screen is exactly what a screen-reader user has to disambiguate by guessing.
 *
 * Everything with a network on the far side is mocked; `../lib/products` and
 * `../lib/scope` are the REAL modules, because they are what the panel renders.
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
  const product = (id: string, sku: string, name: string, siteNodeId: string) => ({
    id,
    sku,
    name,
    active: true,
    source: "manual",
    externalId: null as string | null,
    siteNodeId,
    colorToken: "product-1",
  });
  // ⭐ FACTORIES, NOT LITERALS, AND `beforeEach` RESTORES FROM THEM. Three cases
  // already mutated the shared fixture in place — `asAdminOfNowhere` empties
  // `editableShapeIds` and T3 re-homes a product — and nothing put them back,
  // so every case after them ran against a fixture shaped by its predecessors.
  // That was survivable while every case wanted the same two rows; the plant
  // cases below add a whole second plant, which the cases above must not see.
  //
  // ⭐ Faithful to `supabase/seed.sql`, which since migration 0028 names a
  // `site_node_id` on every product row — the column is NOT NULL and there is
  // no company-wide product. Both base rows belong to Plant 1.
  const baseProducts = () => [
    product("p1", "WX", "Widget X", P1),
    product("p2", "WY", "Widget Y", P1),
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
    updateMutate: vi.fn(),
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
      products: baseProducts(),
      tree: baseTree(),
    },
  };
});

vi.mock("@tanstack/react-query", () => ({
  // ⚠️ `isSuccess` IS PART OF THE CONTRACT THIS PANEL READS, and it was missing.
  // `productRows` is handed `treeQuery.isSuccess ? sites : null`, so an omitted
  // flag meant every case above ran the "we could not read the structure" path:
  // no owner was ever resolved, every row was labelled "Another site", and
  // `view.elsewhere` could not be non-zero. Supplying it is what lets the plant
  // cases below tell the elsewhere count and the filter count apart.
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
  useCreateProduct: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateProduct: () => ({ mutate: h.updateMutate, isPending: false }),
  useSetProductActive: () => ({ mutate: vi.fn(), isPending: false }),
  useSetProductColor: () => ({ mutate: vi.fn(), isPending: false }),
}));

/**
 * ⚠️ 0029: MOCKING THIS IS NOT OPTIONAL, AND THE REASON IS WORTH KNOWING.
 *
 * `ProductsPanel` now imports `DeleteDialog`, which imports `useDeletion`,
 * which imports `useMutation`/`useQueryClient` from `@tanstack/react-query`
 * and `previewDeletion`/`deleteOwnedRow` from `@/lib/api`. Both of those
 * modules are mocked ABOVE with factories that list only what this file needed
 * before — and a vi.mock factory is a CLOSED object: importing a name it does
 * not define throws while the module graph is being built, so the whole file
 * would fail to load rather than any case failing.
 *
 * Mocking `useDeletion` itself cuts the chain at its head: the real module is
 * never evaluated, so neither factory has to grow a list of names that has
 * nothing to do with what this file tests. `useDeleteProduct` is gone from the
 * mock above for the same reason it is gone from the panel — 0029 replaced the
 * table delete with `delete_owned_row`.
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
 * Somebody who administers NOWHERE: org-wide role `viewer`, no admin grant.
 *
 * ⭐ RENAMED AND CHANGED BY 0028, AND THE CHANGE IS THE CASE. This used to be
 * `asSiteAdmin` with `adminAnywhere: true` — Dana, an admin of Plant 1 — and
 * it produced a refusal because the ROW was company-wide. D108 deleted that
 * row type. `canEditProduct` fails open for anyone who administers anywhere
 * (see its header), so Dana would now correctly get a live Edit button and
 * this case would be asserting nothing. The one certain refusal left needs a
 * person with no grants at all.
 */
function asAdminOfNowhere() {
  h.state.profile = { ...h.state.profile, role: "viewer", adminAnywhere: false };
  // ⚠️ AND NO EDITABLE STRUCTURE. Without this the fixture's `editableShapeIds`
  // still resolves to Plant 1, which is exactly who owns both rows now, so
  // `canOwnProduct` returns TRUE and the Edit buttons stay live — the case
  // would assert nothing and read as a pass. Before 0028 the rows were
  // company-wide and nothing this person held could reach them, so the profile
  // change alone was enough.
  h.state.tree = { ...h.state.tree, editableShapeIds: [] };
}
/** The open editor for one row, found the way its own label reads. */
function editingRow(sku: string): HTMLElement {
  const box = screen.getByRole("textbox", { name: `Product code for ${sku}` });
  const li = box.closest("li");
  if (li === null) throw new Error("the editor is not inside a row");
  return li;
}
function belongsTo(row: HTMLElement, sku: string): HTMLSelectElement {
  return within(row).getByRole("combobox", {
    name: `Where ${sku} belongs`,
  }) as HTMLSelectElement;
}

/**
 * The two-plant world the filter exists for: a system admin who can read Plant
 * 1 and Plant 2, with a product in each.
 *
 * ⚠️ NOT IN THE BASE FIXTURE. `readablePlants` counts roots, so a second root
 * would give every case above a live plant control and a third Edit button.
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
  h.state.products = [...h.baseProducts(), h.product("p3", "ZZ", "Widget Z", PLANT2)];
}
/** Choose a plant the way the header control does, and re-render on it. */
function showPlant(choice: string | null) {
  act(() => useAdminViewStore.setState({ plantChoice: choice }));
}

beforeEach(() => {
  h.updateMutate.mockClear();
  asCompanyAdmin();
  h.state.products = h.baseProducts();
  h.state.tree = h.baseTree();
  // ⚠️ THE STORE IS A MODULE SINGLETON AND OUTLIVES A RENDER. Left set, one
  // case's chosen plant filters the next case's catalogue — the cross-section
  // leak this feature exists to make visible, arriving in the test file.
  useAdminViewStore.setState({ plantChoice: null, hydratedOrgId: null });
});

describe("ProductsPanel — the row's editor is reachable (D106)", () => {
  it("T1: every row offers a control named 'Edit' — and none named 'Rename'", () => {
    render(<ProductsPanel />);
    // ⚠️ BY ACCESSIBLE NAME, which is the only handle a person has. The screen
    // that produced four rounds of "I still cannot edit a product" passed every
    // test in the repo while failing this line: the picker was wired, and the
    // door to it said "Rename".
    expect(screen.queryAllByRole("button", { name: "Rename" })).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2);
  });

  it("T2: the Edit control opens a form carrying the 'Belongs to' picker", () => {
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(belongsTo(editingRow("WX"), "WX").tagName).toBe("SELECT");
  });

  it("T3: the picker opens on the row's CURRENT scope, not on a default", () => {
    // ⚠️ ASSEMBLY, not Plant 1. The `beforeEach` now homes every row at Plant 1
    // (0028: there is no unowned row to start from), so re-homing this row to
    // Plant 1 would make the case pass against a picker that ignored the row
    // entirely and opened on its own first option — which is exactly the
    // defect it exists to catch.
    h.state.products = h.state.products.map((p, i) =>
      i === 0 ? { ...p, siteNodeId: "n-asm" } : p,
    );
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(belongsTo(editingRow("WX"), "WX").value).toBe("n-asm");
  });

  it("T4 ⭐ (rewritten by 0028): the picker offers every node, indented, and NO company-wide entry", () => {
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const labels = [...belongsTo(editingRow("WX"), "WX").options].map((o) => o.text);
    // D108: it used to open with "Everywhere (company-wide)". A picker that can
    // still emit a value the database refuses is D106 with a different label.
    expect(labels).not.toContain("Everywhere (company-wide)");
    expect(labels[0]).toBe("Plant 1");
    // `indentedLabel` pads a child with two U+2007 figure spaces per level.
    expect(labels).toContain("\u2007\u2007Assembly");
  });

  it("T5: changing the picker and saving SENDS the new scope", () => {
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const row = editingRow("WX");
    fireEvent.change(belongsTo(row, "WX"), { target: { value: PLANT1 } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    expect(h.updateMutate).toHaveBeenCalledTimes(1);
    expect(h.updateMutate.mock.calls[0][0]).toEqual({
      id: "p1",
      sku: "WX",
      name: "Widget X",
      siteNodeId: PLANT1,
    });
  });

  it("T6 ⭐ (rewritten by 0028): saving an untouched row still SENDS its owner, rather than omitting the key", () => {
    // ⚠️ The original hazard survives D108 with a different shape. In
    // `updateProduct`'s patch an ABSENT key means "leave it alone" — so a save
    // that dropped the key would silently keep whatever the server had, and a
    // re-home that looked applied on screen would not be. The old case pinned
    // `null` (company-wide) travelling as itself rather than as `undefined`;
    // this pins the key being present and carrying the row's real owner.
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.click(within(editingRow("WX")).getByRole("button", { name: "Save" }));
    const patch = h.updateMutate.mock.calls[0][0] as { siteNodeId: string };
    expect("siteNodeId" in patch).toBe(true);
    expect(patch.siteNodeId).toBe(PLANT1);
  });

  it("T7 ⭐ (rewritten by 0028): a site admin who administers nowhere gets no Edit control, and is told why", () => {
    asAdminOfNowhere();
    render(<ProductsPanel />);
    // ⭐ The refusal this case pins CHANGED CAUSE UNDER 0028 and kept its
    // shape. It used to be "this row is company-wide, only a company admin may
    // touch it" — a state D108 deleted. `canEditProduct` now fails OPEN for
    // anyone who administers anywhere, so the only certain refusal left is for
    // someone who administers nowhere at all, and `editRefusalNote` has exactly
    // one sentence to say. `asAdminOfNowhere()` supplies that person.
    for (const b of screen.getAllByRole("button", { name: "Edit" })) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    expect(
      screen.getAllByText("You don't administer anywhere, so this is read-only."),
    ).toHaveLength(2);
  });

  it("T8: an open row's boxes are named apart from the Add card's", () => {
    // ⚠️ THE CASE THAT PINS THE INSTRUMENT FAILURE, not a style preference. With
    // the row's boxes labelled plainly "Product code" / "Belongs to", opening an
    // editor put two identically-named controls on the screen: `getByRole` threw,
    // and a screen-reader user gets two boxes it cannot tell apart. The Add card
    // keeps the plain names because its labels are visible text.
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getAllByRole("textbox", { name: "Product code" })).toHaveLength(1);
    expect(screen.getAllByRole("combobox", { name: "Belongs to" })).toHaveLength(1);
    expect(screen.getAllByRole("textbox", { name: "Product code for WX" })).toHaveLength(1);
  });
});

/**
 * ⭐⭐ ROADMAP 1(c) — "which plant am I looking at", on this panel.
 *
 * The maintainer, 31 Aug: *"for the system admin, may be we need a filter for
 * plants in all the sub tabs."* The control and the header chip belong to
 * `AdminPage`; what is pinned here is the half a panel owns — that the choice
 * reaches the LIST, the FORMS and the id-keyed state, and that what it removes
 * is COUNTED rather than quietly gone.
 *
 * ⚠️ THESE CASES DRIVE THE REAL STORE, not a mock of it. `usePlantFilter`,
 * `plantFilter.ts` and `adminView.ts` are the modules under test as much as the
 * panel is: mocking the hook would pin that the panel calls something, which is
 * the shape of assertion §19.77's own audit passed while the screen was broken.
 */
describe("ProductsPanel — the plant filter (roadmap 1(c))", () => {
  it("T9: the catalogue is cut to the chosen plant", () => {
    withTwoPlants();
    render(<ProductsPanel />);
    // All plants first, so the case cannot pass against a panel that simply
    // never had the third row.
    expect(screen.queryByText("ZZ")).not.toBeNull();
    showPlant(PLANT1);
    expect(screen.queryByText("ZZ")).toBeNull();
    expect(screen.queryByText("WX")).not.toBeNull();
    expect(screen.queryByText("WY")).not.toBeNull();
  });

  it("T10 ⭐ what the filter hides is COUNTED, and named by the plant", () => {
    // `scope.ts`'s rule and decision 1's other half: hiding is invisible and
    // permanent, so a list that shrank has to say by how much. The count is
    // NAMED (`plant.label`) rather than described as "another plant", because
    // the hierarchy is user-defined and "plant" is this company's word for it.
    withTwoPlants();
    render(<ProductsPanel />);
    expect(screen.queryByText(/isn't listed|aren't listed/)).toBeNull();
    showPlant(PLANT1);
    expect(screen.getByText(/1 product outside Plant 1 isn't listed\./)).toBeTruthy();
  });

  it("T11: the count is the filter's alone — it does not double-count `elsewhere`", () => {
    // ⚠️ THE CASE FOR THE `sites`-VS-`rowsInPlant` DECISION. `productRows` drops
    // a product whose owner this reader cannot resolve and counts it as
    // `elsewhere` — a statement about PERMISSION. Filtering `sites` by plant
    // would have swept every other plant's products into that count and blamed
    // a reversible view choice on what this person may see. Owner resolution
    // stays whole; the plant cut happens on the rows that survive it.
    withTwoPlants();
    h.state.products = [...h.state.products, h.product("p4", "QQ", "Widget Q", "n-gone")];
    render(<ProductsPanel />);
    showPlant(PLANT1);
    expect(
      screen.getByText(/1 product scheduled here belongs to another site, so it isn't listed\./),
    ).toBeTruthy();
    // One, not two: the unreadable row never reached the plant filter.
    expect(screen.getByText(/1 product outside Plant 1 isn't listed\./)).toBeTruthy();
  });

  it("T12 ⭐ decision 3: the ADD form narrows too — what you see is what you can create in", () => {
    withTwoPlants();
    render(<ProductsPanel />);
    showPlant(PLANT2);
    const add = screen.getByRole("combobox", { name: /Belongs to/ }) as HTMLSelectElement;
    expect([...add.options].map((o) => o.text)).toEqual(["Plant 2", "\u2007\u2007Line 9"]);
    // And the picker's VALUE follows, rather than pointing at a node it no
    // longer offers — `ownerValue`'s resolve-or-fall-back.
    expect(add.value).toBe(PLANT2);
  });

  it("T12b: the ROW's picker narrows the same way", () => {
    withTwoPlants();
    render(<ProductsPanel />);
    showPlant(PLANT2);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const labels = [...belongsTo(editingRow("ZZ"), "ZZ").options].map((o) => o.text);
    expect(labels).toEqual(["Plant 2", "\u2007\u2007Line 9"]);
  });

  it("T13 ⭐⭐ the row's picker can never show one owner and SAVE another", () => {
    // The defect this pins: `<select value=...>` handed a value none of its
    // options carries renders its FIRST option and reports nothing. Re-home WX
    // to Plant 2, then filter to Plant 1 — the control reads "Plant 1" and the
    // patch used to carry Plant 2.
    withTwoPlants();
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.change(belongsTo(editingRow("WX"), "WX"), { target: { value: "n-l9" } });
    showPlant(PLANT1);
    const row = editingRow("WX");
    expect(belongsTo(row, "WX").value).toBe(PLANT1);
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    expect(h.updateMutate.mock.calls[0][0]).toEqual({
      id: "p1",
      sku: "WX",
      name: "Widget X",
      siteNodeId: PLANT1,
    });
  });

  it("T14 ⭐ an editor whose row the filter took away does not come back open", () => {
    // ⚠️ RESOLVE-OR-FALL-BACK IS NOT ENOUGH FOR A FORM. It is reversible by
    // construction, so widening back to All plants would re-open an editor —
    // or, worse, a delete confirmation — the reader left behind two plants ago.
    withTwoPlants();
    render(<ProductsPanel />);
    showPlant(PLANT2);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryAllByRole("textbox", { name: "Product code for ZZ" })).toHaveLength(1);
    showPlant(PLANT1);
    showPlant(null);
    expect(screen.queryByText("ZZ")).not.toBeNull();
    expect(screen.queryAllByRole("textbox", { name: "Product code for ZZ" })).toHaveLength(0);
  });

  it("T15: 'All plants' hides nothing, and says nothing", () => {
    withTwoPlants();
    render(<ProductsPanel />);
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(3);
    expect(screen.queryByText(/outside/)).toBeNull();
    // ⚠️ And no advice about switching either: the add-form note is the
    // filter's own footnote and must not appear when nothing is filtered.
    expect(screen.queryByText(/so a new product can only go there/)).toBeNull();
  });

  it("T16: one readable root means the filter is a no-op, whatever is remembered", () => {
    // Decision 2, from the panel's side. The base fixture has ONE root, so
    // `resolvePlantChoice` collapses a stored id to "All plants" rather than
    // leaving somebody filtered by a control `AdminPage` does not render.
    showPlant(PLANT2);
    render(<ProductsPanel />);
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(2);
    expect(screen.queryByText(/aren't listed|isn't listed/)).toBeNull();
  });
});
