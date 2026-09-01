import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImportPanel } from "@/features/admin/components/ImportPanel";

/**
 * ⭐ ImportPanel drives the REAL pure libs on purpose (§19.67 / D106): `../lib/csv`,
 * `../lib/productImport` and `../lib/plantFilter` run for real, because they are
 * what the wizard renders. Only what has a network on the far side is mocked —
 * the catalogue read, the hierarchy read, and the import mutation.
 *
 * ⚠️ EACH HOOK IS MOCKED TO ITS FULL SHAPE. The panel reads `.isPending`,
 * `.isSuccess`, `.isError`, `.data`, `.reset` on the import mutation; an omitted
 * field would silently pick a branch (the disabled button, or the success view)
 * and every fire-event would do nothing — the bug `productsPanel.test.tsx`'s own
 * history warns about.
 */

const h = vi.hoisted(() => {
  const PLANT1 = "30000000-0000-0000-0000-000000000001";
  const product = (id: string, sku: string, name: string, externalId: string | null) => ({
    id,
    sku,
    name,
    active: true,
    source: "manual",
    externalId,
    siteNodeIds: [] as string[],
    colorToken: "product-1",
  });
  const baseProducts = () => [product("p1", "WX", "Widget X", "E1")];
  const baseTree = () => ({
    templates: [] as unknown[],
    levels: [] as unknown[],
    nodes: [
      {
        id: PLANT1,
        name: "Plant 1",
        parentId: null,
        levelId: "L",
        path: "plant_1",
        sortOrder: 1,
        active: true,
      },
    ],
    editableShapeIds: ["tpl-1"] as string[] | null,
    siteNodeIds: { "tpl-1": PLANT1 } as Record<string, string | null>,
  });
  return {
    // The import mutation, captured so a test can assert what it received.
    importMutate: vi.fn(),
    importReset: vi.fn(),
    baseProducts,
    baseTree,
    state: {
      profile: {
        id: "u1",
        orgId: "10000000-0000-0000-0000-000000000001",
        userId: "u1",
        role: "admin" as string,
        defaultCreateMode: "run",
        adminAnywhere: true,
      },
      products: baseProducts() as unknown[],
      tree: baseTree(),
      // The import mutation's live fields — a test flips these to render the
      // pending / success branches.
      importState: {
        isPending: false,
        isSuccess: false,
        isError: false,
        data: null as unknown,
        error: null as unknown,
      },
    },
  };
});

vi.mock("@tanstack/react-query", () => ({
  // ImportPanel's only `useQuery` is the hierarchy tree; the full shape it reads.
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
}));
vi.mock("@/features/admin/hooks/useProductImport", () => ({
  useProductImport: () => ({
    mutate: h.importMutate,
    mutateAsync: h.importMutate,
    reset: h.importReset,
    isPending: h.state.importState.isPending,
    isSuccess: h.state.importState.isSuccess,
    isError: h.state.importState.isError,
    data: h.state.importState.data,
    error: h.state.importState.error,
  }),
}));

/** A CSV that mixes a NEW part, a re-uploaded (matching external_id) part, and a bad row. */
const CSV = [
  "sku,name,external_id",
  "AA,Alpha,E9", // new -> insert
  "WX,Widget X v2,E1", // matches existing p1 by external_id -> update
  ",Bad Row,E7", // empty code -> error
].join("\n");

/** Drive a real File through the file input and wait for the async parse to land. */
async function loadCsv(text: string, name = "parts.csv") {
  const file = new File([text], name, { type: "text/csv" });
  // ⚠️ jsdom here does not implement `File.prototype.text()`; the panel reads the
  // File that way, so stub it on this instance to resolve the CSV text.
  if (typeof file.text !== "function") {
    Object.defineProperty(file, "text", { value: () => Promise.resolve(text) });
  }
  const input = screen.getByLabelText("Choose a CSV file") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText("Preview")).toBeTruthy());
}

function asCompanyAdmin() {
  h.state.profile = { ...h.state.profile, role: "admin" };
}
function asPlantAdmin() {
  h.state.profile = { ...h.state.profile, role: "viewer" };
}

beforeEach(() => {
  h.importMutate.mockClear();
  h.importReset.mockClear();
  asCompanyAdmin();
  h.state.products = h.baseProducts();
  h.state.tree = h.baseTree();
  h.state.importState = {
    isPending: false,
    isSuccess: false,
    isError: false,
    data: null,
    error: null,
  };
});

describe("ImportPanel — the preview", () => {
  it("T1: counts a new part, a re-uploaded part, and a bad row as 1 add / 1 update / 1 problem", async () => {
    render(<ImportPanel />);
    await loadCsv(CSV);
    expect(screen.getByText(/1 to add · 1 to update · 1 problem row/)).toBeTruthy();
    // The bad row is called out and named a skip.
    expect(screen.getByText("1 row has problems and will be skipped.")).toBeTruthy();
    // The three outcomes render their badges.
    expect(screen.getByText("New")).toBeTruthy();
    expect(screen.getByText("Update")).toBeTruthy();
    expect(screen.getByText("Problem")).toBeTruthy();
    // The bad row's reason is shown.
    expect(screen.getByText(/A product code is required\./)).toBeTruthy();
  });

  it("T2: Apply calls the import mutation with the plan and ctx.source === the file name", async () => {
    render(<ImportPanel />);
    await loadCsv(CSV);
    fireEvent.click(screen.getByRole("button", { name: /^Apply/ }));
    expect(h.importMutate).toHaveBeenCalledTimes(1);
    const arg = h.importMutate.mock.calls[0][0];
    expect(arg.plan).toBeTruthy();
    expect(arg.plan.counts).toEqual({ insert: 1, update: 1, error: 1 });
    expect(arg.ctx.source).toBe("parts.csv");
    expect(arg.ctx.orgId).toBe(h.state.profile.orgId);
  });
});

describe("ImportPanel — the company-admin gate", () => {
  it("T3: a non-company-admin sees the preview but NO Apply button, and is told why", async () => {
    asPlantAdmin();
    render(<ImportPanel />);
    await loadCsv(CSV);
    // The preview is still there.
    expect(screen.getByText(/1 to add · 1 to update · 1 problem row/)).toBeTruthy();
    // But applying is gone.
    expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
    expect(screen.getByText(/Only a company admin can import parts\./)).toBeTruthy();
  });
});

describe("ImportPanel — a required column left unmapped", () => {
  it("T4: with no code column, says so and offers no Apply", async () => {
    render(<ImportPanel />);
    await loadCsv("name,external_id\nAlpha,E9");
    expect(screen.getByText(/No column is mapped to the product code/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull();
  });
});

describe("ImportPanel — the result", () => {
  it("T5: a success renders inserted / updated and lists each failure", async () => {
    h.state.importState = {
      isPending: false,
      isSuccess: true,
      isError: false,
      data: { inserted: 1, updated: 1, failed: [{ line: 4, message: "the server refused it" }] },
      error: null,
    };
    render(<ImportPanel />);
    await loadCsv(CSV);
    expect(screen.getByText("Added 1, updated 1.")).toBeTruthy();
    expect(screen.getByText(/Line 4: the server refused it/)).toBeTruthy();
    // And a way to start over.
    expect(screen.getByRole("button", { name: "Import another file" })).toBeTruthy();
  });
});
