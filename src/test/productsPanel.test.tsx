import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ProductsPanel } from "@/features/admin/components/ProductsPanel";

/**
 * ⭐ THE FIRST TEST IN THIS REPO THAT MOUNTS A COMPONENT, and the reason it
 * exists is a finding, not a preference (§19.67 / D106).
 *
 * `scaleAudit`'s group J was written to make "you can SET it at creation and
 * never CHANGE it" impossible to ship. It passed every day Pratik was blocked,
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
  return {
    updateMutate: vi.fn(),
    state: {
      profile: {
        id: "u1",
        orgId: "10000000-0000-0000-0000-000000000001",
        userId: "u1",
        role: "admin",
        defaultCreateMode: "run",
        adminAnywhere: true,
      },
      // Faithful to `supabase/seed.sql`, which names no `site_node_id` on any
      // product row: every product in the demo data is company-wide.
      products: [
        {
          id: "p1",
          sku: "WX",
          name: "Widget X",
          active: true,
          source: "manual",
          externalId: null,
          siteNodeId: null as string | null,
          colorToken: "product-1",
        },
        {
          id: "p2",
          sku: "WY",
          name: "Widget Y",
          active: true,
          source: "manual",
          externalId: null,
          siteNodeId: null as string | null,
          colorToken: "product-2",
        },
      ],
      tree: {
        templates: [],
        levels: [],
        nodes: [
          node(P1, "Plant 1", null, "plant_1"),
          node("n-asm", "Assembly", P1, "plant_1.assembly"),
        ],
        editableShapeIds: ["tpl-1"] as string[] | null,
        siteNodeIds: { "tpl-1": P1 } as Record<string, string | null>,
      },
    },
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: h.state.tree, isLoading: false, isError: false, error: null }),
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
  useDeleteProduct: () => ({ mutate: vi.fn(), isPending: false }),
  useSetProductColor: () => ({ mutate: vi.fn(), isPending: false }),
}));

function asCompanyAdmin() {
  h.state.profile = { ...h.state.profile, role: "admin", adminAnywhere: true };
}
function asSiteAdmin() {
  // Dana in `dev_demo.sql`: org-wide role `viewer`, an admin grant on Plant 1.
  h.state.profile = { ...h.state.profile, role: "viewer", adminAnywhere: true };
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

beforeEach(() => {
  h.updateMutate.mockClear();
  asCompanyAdmin();
  h.state.products = h.state.products.map((p) => ({ ...p, siteNodeId: null }));
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
    h.state.products = h.state.products.map((p, i) => (i === 0 ? { ...p, siteNodeId: PLANT1 } : p));
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(belongsTo(editingRow("WX"), "WX").value).toBe(PLANT1);
  });

  it("T4: a company admin is offered company-wide and every node, indented", () => {
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const labels = [...belongsTo(editingRow("WX"), "WX").options].map((o) => o.text);
    expect(labels[0]).toBe("Everywhere (company-wide)");
    expect(labels).toContain("Plant 1");
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

  it("T6: saving a row left company-wide sends null, not undefined", () => {
    // ⚠️ `undefined !== null` in `updateProduct`'s patch: `null` means
    // company-wide, an ABSENT key means "leave it alone". A save that meant to
    // clear a scope and sent `undefined` would silently keep the old one.
    render(<ProductsPanel />);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    fireEvent.click(within(editingRow("WX")).getByRole("button", { name: "Save" }));
    const patch = h.updateMutate.mock.calls[0][0] as { siteNodeId: string | null };
    expect(patch.siteNodeId).toBeNull();
    expect("siteNodeId" in patch).toBe(true);
  });

  it("T7: a site admin gets no Edit control on a company-wide row, and is told why", () => {
    asSiteAdmin();
    render(<ProductsPanel />);
    // Every product in `seed.sql` is company-wide, so today this is the WHOLE
    // catalogue for Dana and Quinn — see §19.67 finding 2.
    for (const b of screen.getAllByRole("button", { name: "Edit" })) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    expect(
      screen.getAllByText("Company-wide — only a company admin can change this."),
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
